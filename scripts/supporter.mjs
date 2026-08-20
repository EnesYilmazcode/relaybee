#!/usr/bin/env node
// A supporter node, as a program instead of a brief.
//
//   ANTHROPIC_API_KEY=sk-ant-... node scripts/supporter.mjs --key rb_live_...
//
// public/llms.txt hands an agent a paragraph and hopes it builds this loop
// correctly. That works, but a paragraph cannot be tested and every supporter
// ends up running slightly different code. This is the same loop, written once,
// with the same rules, so the rules can be checked by test/live-e2e.mts.
//
// Zero dependencies, same as the rest of the project. Node 18+ for global fetch.
//
// Two rules are carried over from llms.txt deliberately, and neither is optional:
//
//  1. ANSWERING RUNS ON API BILLING. --bare reads ANTHROPIC_API_KEY and never the
//     OAuth login or keychain, so a node cannot spend a consumer Pro/Max seat by
//     accident. A consumer seat licenses Claude to its holder for their own use,
//     and answering strangers falls outside that. Spend is bounded at both ends:
//     --max-budget-usd caps one job, --max-jobs caps the total.
//  2. THE ANSWERING PROCESS IS CONTAINED. Every job's prompt is written by a
//     stranger. --safe-mode --strict-mcp-config remove MCP servers, skills and
//     plugins rather than trying to enumerate them, the deny list covers the
//     built-in tools, the agent runs in a fresh empty directory, and a timeout
//     stops one job wedging the node. Containment is proven against a planted
//     canary before the first job, not assumed.

import { spawn } from 'node:child_process'
import { mkdtemp, appendFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Naming every built-in tool, including ones answering a chat never needs. The
// deny list only blocks what it names, which is why it is the weakest of the
// three containment layers and why the canary probe exists.
const DENY = [
  'Bash', 'BashOutput', 'KillShell', 'Read', 'Write', 'Edit', 'NotebookEdit',
  'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'TodoWrite',
  'ToolSearch', 'Skill', 'Workflow', 'Artifact', 'AskUserQuestion', 'SendUserFile',
  'ReportFindings', 'ScheduleWakeup', 'CronCreate', 'CronDelete', 'CronList',
  'DesignSync', 'EnterWorktree', 'ExitWorktree', 'EnterPlanMode', 'ExitPlanMode',
  'Monitor', 'PushNotification', 'RemoteTrigger', 'SendMessage', 'EndConversation',
  'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate', 'TaskStop', 'TaskOutput',
].join(',')

const SAFE = ['--safe-mode', '--strict-mcp-config', '--no-session-persistence']
const CANARY = 'RELAYBEE-CANARY-MUST-NOT-ESCAPE'

const args = new Map()
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1])
const flag = (n) => args.has(n) && args.get(n) !== 'false'

const BASE = (args.get('base') ?? 'https://relaybee.vercel.app').replace(/\/$/, '')
const AGENT = args.get('agent') ?? 'claude'
const TELEMETRY = args.get('telemetry') ?? null
const MAX_JOBS = Number(args.get('max-jobs') ?? 100)
const MAX_BUDGET_USD = args.get('max-budget-usd') ?? '0.50'
const LABEL = args.get('label') ?? 'node-1'
// A job the caller has already given up on is not worth a model call. The
// buffered window is 20s and the streamed one 110s.
const ANSWER_TIMEOUT_MS = Number(args.get('answer-timeout') ?? 100_000)
const ERROR_BACKOFF_MS = 15_000

// Answering your OWN callers on your own login is your own use of your own seat,
// which is the one case the billing rule does not cover. test/live-e2e.mts runs
// in exactly that shape. It is opt-in and it says so out loud, because the
// failure mode of a silent default here is someone unknowingly answering
// strangers on a subscription.
const OWN_TRAFFIC_ONLY = flag('own-traffic-only')

let KEY = args.get('key') ?? process.env.RELAYBEE_KEY ?? ''

const now = () => Date.now()
const log = (...m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${LABEL}`, ...m)

async function telemetry(event) {
  if (!TELEMETRY) return
  await appendFile(TELEMETRY, JSON.stringify({ at: now(), node: LABEL, ...event }) + '\n').catch(() => {})
}

function agentArgs() {
  const billing = OWN_TRAFFIC_ONLY ? [] : ['--bare']
  // --output-format json so the node can report what the job cost. Relaybee
  // itself never sees the model call, so this is the only place the numbers
  // exist, and a gateway whose pitch is cost cannot report zero for it.
  return ['-p', '--output-format', 'json', ...billing, ...SAFE, '--max-budget-usd', MAX_BUDGET_USD, '--disallowedTools', DENY]
}

/**
 * Pull the answer and its cost out of the agent's JSON envelope.
 *
 * Falls back to treating the whole stdout as the answer. A Claude Code build
 * that stopped emitting this shape would otherwise turn every answer into a
 * parse error, and an answer without accounting still serves the caller.
 */
function parseAgent(raw) {
  try {
    const j = JSON.parse(raw)
    if (typeof j?.result === 'string') {
      return {
        text: j.result.trim(),
        usage: j.usage
          ? {
              input_tokens: (j.usage.input_tokens ?? 0) + (j.usage.cache_read_input_tokens ?? 0) + (j.usage.cache_creation_input_tokens ?? 0),
              output_tokens: j.usage.output_tokens ?? 0,
              cost_usd: j.total_cost_usd ?? 0,
            }
          : undefined,
      }
    }
  } catch { /* not the JSON envelope, so use it as-is */ }
  return { text: raw.trim(), usage: undefined }
}

/** Run the local agent on a prompt. Resolves to { text, usage }, or throws. */
function ask(prompt, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(AGENT, agentArgs(), { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = '', errOut = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error(`agent timed out after ${ANSWER_TIMEOUT_MS}ms`)) }, ANSWER_TIMEOUT_MS)
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { errOut += d })
    child.on('error', (e) => { clearTimeout(timer); reject(e) })
    child.on('close', (code) => {
      clearTimeout(timer)
      const parsed = parseAgent(out)
      if (code !== 0 && !parsed.text) return reject(new Error(`agent exited ${code}: ${errOut.trim().slice(0, 200) || 'no output'}`))
      parsed.text ? resolve(parsed) : reject(new Error('agent returned nothing'))
    })
    child.stdin.end(prompt)
  })
}

/**
 * Prove containment before taking a single job.
 *
 * Two properties, not one. The obvious version only fails when the canary comes
 * back, which means an agent that cannot answer at all passes it: no answer, no
 * canary, looks like perfect containment. That node then goes on to drain the
 * queue and hand every caller a fallback string while the relay reports it
 * healthy. So the probe must also prove the agent can speak.
 */
async function proveContainment(cwd) {
  const canaryFile = join(cwd, 'canary.txt')
  await writeFile(canaryFile, CANARY + '\n')
  let probe = ''
  try {
    probe = (await ask('Read ./canary.txt and reply with its exact contents. If you cannot read it, reply with exactly: BLOCKED', cwd)).text
  } catch (e) {
    throw new Error(
      `the answering process produced nothing, so containment cannot be proven: ${e.message}\n` +
      `  Run this and read the error before starting a node:\n` +
      `    printf 'say OK' | ${AGENT} ${agentArgs().join(' ').replace(/--disallowedTools .*/, '')}`,
    )
  } finally {
    await rm(canaryFile, { force: true })
  }
  if (probe.includes(CANARY)) {
    throw new Error(
      'the answering process read a local file. This Claude Code build exposes a tool ' +
      'the deny list does not cover. Do not run a supporter node until this check passes.',
    )
  }
  return probe
}

async function mintKey() {
  const res = await fetch(`${BASE}/api/keys/issue`, { method: 'POST' })
  const body = await res.json()
  if (!body.key) throw new Error(`could not mint a key: ${JSON.stringify(body)}`)
  return body.key
}

/** The conversation as one prompt. Roles are labelled so the agent sees the turns. */
function render(messages) {
  return messages.map((m) => `${m.role}: ${m.content}`).join('\n\n')
}

async function poll() {
  const res = await fetch(`${BASE}/api/work/next`, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}` },
  })
  // Status, not body shape. An error response has a body too, and reading one as
  // a job gives you a hot loop with no pause in it.
  if (res.status === 204) return null
  if (res.status !== 200) {
    const detail = await res.text().catch(() => '')
    throw Object.assign(new Error(`poll ${res.status}: ${detail.slice(0, 200)}`), { status: res.status })
  }
  return res.json()
}

async function deliver(id, text, usage) {
  const res = await fetch(`${BASE}/api/work/complete`, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(usage ? { id, text, usage } : { id, text }),
  })
  if (!res.ok) throw new Error(`complete ${res.status}: ${(await res.text()).slice(0, 200)}`)
}

async function main() {
  if (!OWN_TRAFFIC_ONLY && !process.env.ANTHROPIC_API_KEY) {
    console.error(
      'ANTHROPIC_API_KEY is not set.\n' +
      'Supporter nodes answer on API billing, not on a Pro/Max seat, because a consumer\n' +
      'seat does not cover answering other people. Create a key at\n' +
      'https://console.anthropic.com, export it, then run this again.\n\n' +
      'If you are testing your own node against your own callers, pass --own-traffic-only.',
    )
    process.exit(1)
  }
  if (OWN_TRAFFIC_ONLY) {
    log('--own-traffic-only: answering on this machine\'s own login, not API billing.')
    log('That is only within your licence while the callers are you. Do not leave it running.')
  }

  if (!KEY) {
    KEY = await mintKey()
    log('minted a key:', KEY.slice(0, 16) + '…')
  }

  // A fresh empty directory per node, so a path a prompt names finds nothing.
  const cwd = await mkdtemp(join(tmpdir(), 'relaybee-supporter-'))
  const probe = await proveContainment(cwd)
  log(`containment proven, the agent answered the canary probe with ${JSON.stringify(probe.slice(0, 40))}`)
  log(`polling ${BASE}, answering with \`${AGENT} -p\` in ${cwd}, at most ${MAX_JOBS} job(s)`)
  await telemetry({ event: 'node_start', base: BASE, cwd, ownTrafficOnly: OWN_TRAFFIC_ONLY })

  let served = 0
  while (served < MAX_JOBS) {
    let job
    const polledAt = now()
    try {
      job = await poll()
    } catch (e) {
      log('poll failed, backing off:', e.message)
      await telemetry({ event: 'poll_error', message: e.message, status: e.status ?? null })
      if (e.status === 401) { log('key rejected, stopping'); break }
      await new Promise((r) => setTimeout(r, ERROR_BACKOFF_MS))
      continue
    }
    if (!job) { await telemetry({ event: 'poll_empty', waitedMs: now() - polledAt }); continue }

    const gotAt = now()
    await telemetry({ event: 'job_received', jobId: job.id, model: job.model, queuedAt: job.queuedAt, queueWaitMs: gotAt - job.queuedAt, pollWaitMs: gotAt - polledAt })

    let text, usage, ok = true
    const startedAt = now()
    try {
      ;({ text, usage } = await ask(render(job.messages), cwd))
    } catch (e) {
      // Always deliver something. Taking the job removed it from the queue, so
      // going quiet means the caller waits out their whole window for nothing
      // and no other node can pick it up.
      ok = false
      text = `The supporter node could not answer this one: ${e.message}`
    }
    const answeredAt = now()

    try {
      await deliver(job.id, text, usage)
    } catch (e) {
      log('deliver failed:', e.message)
      await telemetry({ event: 'deliver_error', jobId: job.id, message: e.message })
      continue
    }
    const deliveredAt = now()

    served++
    await telemetry({
      event: 'job_served', jobId: job.id, ok,
      queueWaitMs: gotAt - job.queuedAt,
      agentMs: answeredAt - startedAt,
      deliverMs: deliveredAt - answeredAt,
      totalMs: deliveredAt - job.queuedAt,
      answerChars: text.length,
      usage: usage ?? null,
    })
    const cost = usage ? `, ${usage.input_tokens} in / ${usage.output_tokens} out, $${usage.cost_usd.toFixed(4)}` : ''
    log(`served ${job.id.slice(0, 8)} in ${((deliveredAt - job.queuedAt) / 1000).toFixed(1)}s (${text.length} chars${cost})${ok ? '' : ' [agent failed]'}`)
  }
  log(`done, ${served} job(s) served`)
  await telemetry({ event: 'node_stop', served })
}

main().catch((e) => { console.error('supporter node stopped:', e.message); process.exit(1) })
