#!/usr/bin/env node
// The onboarding path, end to end, with nothing simulated.
//
//   node test/onboard-e2e.mjs                    # against production
//   node test/onboard-e2e.mjs --base http://...  # against a preview
//   node test/onboard-e2e.mjs --reuse            # keep the node already running
//
// What a supporter actually does is open Claude Code and paste one line from
// the homepage. Nothing else in test/ runs that: live-e2e.mts starts
// scripts/supporter.mjs directly, which skips the agent reading llms.txt and
// the script it writes from it, and that is where every real failure has been.
// So this takes the line off the live homepage, hands it to a fresh headless
// Claude Code, waits for the relay to see the node it brings up, then calls it
// the way a developer would: a key minted from the public endpoint, a Python
// file written around that key, run as a separate process.
//
// It runs on this machine's Claude login and spends real usage: one setup
// session plus four short answers. Not part of `npm run check`.

import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d }
const BASE = opt('base', 'https://relaybee.vercel.app').replace(/\/$/, '')
const REUSE = argv.includes('--reuse')
const SETUP_TIMEOUT_MS = Number(opt('setup-timeout', 420_000))
const KEY_FILE = join(homedir(), '.relaybee_key')

const results = []
let failed = 0
function step(name, ok, detail = '', ms) {
  if (!ok) failed++
  results.push({ name, ok, detail, ms })
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${ms != null ? `  ${(ms / 1000).toFixed(1)}s` : ''}${detail ? `  ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const bash = (cmd) => spawnSync('bash', ['-c', cmd], { encoding: 'utf8' })

async function mint() {
  const res = await fetch(`${BASE}/api/keys/issue`, { method: 'POST' })
  return (await res.json()).key
}

async function status(key) {
  const res = await fetch(`${BASE}/api/work/status`, { headers: { authorization: `Bearer ${key}` } })
  return res.json()
}

/** One streamed chat call. Resolves to the answer text, or throws the relay's own message. */
async function chat(key, prompt) {
  const res = await fetch(`${BASE}/api/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-code', stream: true, messages: [{ role: 'user', content: prompt }] }),
  })
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 200)}`)
  let text = ''
  for (const line of (await res.text()).split(/\r?\n/)) {
    if (!line.startsWith('data:') || line.includes('[DONE]')) continue
    const chunk = JSON.parse(line.slice(5))
    if (chunk.error) throw new Error(chunk.error.message)
    text += chunk.choices?.[0]?.delta?.content ?? ''
  }
  return text
}

async function timed(name, fn, check) {
  const at = Date.now()
  try {
    const out = await fn()
    step(name, check(out), JSON.stringify(out).slice(0, 80), Date.now() - at)
    return out
  } catch (e) {
    step(name, false, e.message.slice(0, 160), Date.now() - at)
  }
}

/** Hand the homepage's own connect line to a fresh headless Claude Code. */
function runAgent(prompt, cwd) {
  return new Promise((resolve) => {
    const child = spawn('claude', ['-p', '--dangerously-skip-permissions', '--output-format', 'json'], {
      cwd, stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    const timer = setTimeout(() => child.kill(), SETUP_TIMEOUT_MS)
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, text: e.message }) })
    child.on('close', (code) => {
      clearTimeout(timer)
      let text = out
      try { text = JSON.parse(out).result ?? out } catch { /* plain output */ }
      resolve({ code, text: text || err })
    })
    child.stdin.end(prompt)
  })
}

console.log(`onboarding e2e against ${BASE}\n`)

// 1. The line a supporter pastes, taken from the page that hands it out.
const appJs = await (await fetch(`${BASE}/app.js`)).text()
const line = /function connectLine\(\) \{\s*return `([^`]+)`/.exec(appJs)?.[1]?.replaceAll('${origin}', BASE)
step('the homepage hands out a connect line', Boolean(line), line?.slice(0, 70))
if (!line) process.exit(1)

// 2. A fresh Claude Code sets the node up from that line and nothing else.
if (!REUSE) {
  bash('kill $(cat ~/.relaybee_worker.pid 2>/dev/null) 2>/dev/null; rm -f ~/.relaybee_worker.pid')
  if (existsSync(KEY_FILE)) await copyFile(KEY_FILE, `${KEY_FILE}.bak`)
  bash('rm -f ~/.relaybee_key')
  const cwd = await mkdtemp(join(tmpdir(), 'relaybee-onboard-'))
  const at = Date.now()
  const agent = await runAgent(line, cwd)
  await writeFile(join(cwd, 'agent-report.txt'), agent.text)
  step('a fresh Claude Code finishes the setup', agent.code === 0, `report: ${join(cwd, 'agent-report.txt')}`, Date.now() - at)
  console.log(`\n--- what the agent reported ---\n${agent.text.trim().slice(0, 1200)}\n---\n`)
}

// 3. The relay, not the agent, says whether a node came up. Agents report a pid
//    for nodes that never started.
const nodeKey = existsSync(KEY_FILE) ? (await readFile(KEY_FILE, 'utf8')).trim() : ''
step('the setup left a key in ~/.relaybee_key', nodeKey.startsWith('rb_live_'))
let seen = false
for (let i = 0; nodeKey && i < 20 && !seen; i++) {
  seen = (await status(nodeKey).catch(() => ({}))).connected === true
  if (!seen) await sleep(3000)
}
step('the relay sees the node online', seen)
const pid = bash('cat ~/.relaybee_worker.pid 2>/dev/null').stdout.trim()
step('the node process is alive', pid !== '' && bash(`kill -0 ${pid}`).status === 0, `pid ${pid}`)

if (seen) {
  // 4. Its own key reaches it. One correct answer, so an echo cannot pass.
  await timed('the node answers a call on its own key',
    () => chat(nodeKey, 'What is 17 x 23? Reply with the number only.'), (t) => /391/.test(t))

  // 5. A stranger's key reaches it too: minted from the public endpoint, never
  //    seen by the node.
  const fresh = await mint()
  step('the public endpoint mints a key', typeof fresh === 'string' && fresh.startsWith('rb_live_'))
  await timed('the node answers a key it has never seen',
    () => chat(fresh, 'What is 19 x 21? Reply with the number only.'), (t) => /399/.test(t))

  // 6. Non-ASCII survives the round trip. A Windows node turned these into U+FFFD.
  await timed('accents and dashes come back intact',
    () => chat(nodeKey, 'Reply with exactly this and nothing else: café — ok'), (t) => t.includes('café — ok'))

  // 7. The developer's view: a Python file around that key, run on its own.
  const dir = await mkdtemp(join(tmpdir(), 'relaybee-sample-'))
  const sample = join(dir, 'sample.py')
  await writeFile(sample, `import json, sys, urllib.request
sys.stdout.reconfigure(encoding="utf-8")
API_KEY = "${fresh}"
PROMPT = "What is 12 x 12? Reply with the number only."
req = urllib.request.Request(
    "${BASE}/api/v1/chat/completions",
    headers={"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"},
    data=json.dumps({"model": "claude-code", "stream": True,
                     "messages": [{"role": "user", "content": PROMPT}]}).encode(),
)
for line in urllib.request.urlopen(req, timeout=130):
    line = line.decode().strip()
    if not line.startswith("data:") or line == "data: [DONE]":
        continue
    chunk = json.loads(line[5:])
    if "error" in chunk:
        sys.exit("Error: " + chunk["error"]["message"])
    print(chunk["choices"][0]["delta"].get("content") or "", end="", flush=True)
print()
`)
  const at = Date.now()
  const py = spawnSync('python', [sample], { encoding: 'utf8' })
  step('a Python file using that key prints the answer', py.status === 0 && /144/.test(py.stdout),
    `${(py.stdout || py.stderr).trim().slice(0, 80)}  (${sample})`, Date.now() - at)
}

console.log(`\n${failed === 0 ? 'all steps passed' : `${failed} step(s) failed`}. The node is left running; stop it with: kill $(cat ~/.relaybee_worker.pid)`)
process.exit(failed === 0 ? 0 : 1)
