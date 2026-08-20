// The live end-to-end run. Real deployment, real keys, real inference, no mocks.
//
//   npx tsx test/live-e2e.mts                       # against production
//   npx tsx test/live-e2e.mts --base http://...     # against a preview or local
//
// Everything else in test/ boots the handlers in-process with throwaway secrets.
// That proves the logic and proves nothing about the thing users actually hit, so
// this drives the deployed service over the public internet: it mints keys from
// the live endpoint, launches real supporter nodes that answer with a real local
// agent, and sends real chat completions that have to come back with the right
// answer. Every step is timed and written out, because "it works" and "it works
// in four seconds" are different products.
//
// Prompts are questions with one correct answer on purpose. An echo, a canned
// string, or a mock would pass a "did I get a response" check; only real
// inference gets 391 out of 17 x 23.
//
// Costs real model calls on whatever account runs the supporter. --jobs bounds it.

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, writeFile, appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'

// --- options -----------------------------------------------------------------

const argv = new Map<string, string>()
for (let i = 2; i < process.argv.length; i += 2) argv.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1])

const BASE = (argv.get('base') ?? 'https://relaybee.vercel.app').replace(/\/$/, '')
const JOBS = Number(argv.get('jobs') ?? 8)
const SUPPORTERS = Number(argv.get('supporters') ?? 2)
const CONCURRENCY = Number(argv.get('concurrency') ?? 4)
const OUT = argv.get('out') ?? join(process.cwd(), 'telemetry')
const SKIP_RELAY = argv.get('skip-relay') === 'true'

const started = Date.now()
const RUN = 'live-' + new Date(started).toISOString().replace(/[:.]/g, '-')
const EVENTS = join(OUT, RUN + '.jsonl')

// --- reporting ---------------------------------------------------------------

type Check = { stage: string; name: string; pass: boolean; detail: string; ms?: number }
const checks: Check[] = []
let stage = 'preflight'

const dim = (s: string) => '\x1b[2m' + s + '\x1b[0m'
const bold = (s: string) => '\x1b[1m' + s + '\x1b[0m'
const green = (s: string) => '\x1b[32m' + s + '\x1b[0m'
const red = (s: string) => '\x1b[31m' + s + '\x1b[0m'

async function event(e: Record<string, unknown>) {
  await appendFile(EVENTS, JSON.stringify({ at: Date.now(), stage, ...e }) + '\n')
}

function ok(name: string, pass: boolean, detail = '', ms?: number) {
  checks.push({ stage, name, pass, detail, ms })
  const tail = [detail, ms !== undefined ? ms + 'ms' : ''].filter(Boolean).join('  ')
  console.log((pass ? green('pass') : red('FAIL')) + '  ' + name + (tail ? '  ' + dim(tail) : ''))
  void event({ event: 'check', name, pass, detail, ms })
}

function section(title: string, name: string) {
  stage = name
  console.log('\n' + dim('-'.repeat(72)) + '\n' + bold(title) + '\n')
}

/** Time an async call, in whole milliseconds. */
async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t = Date.now()
  const v = await fn()
  return [v, Date.now() - t]
}

// --- the service under test ---------------------------------------------------

const json = { 'content-type': 'application/json' }
const auth = (key: string) => ({ authorization: 'Bearer ' + key })

async function mint(handle?: string): Promise<{ key: string; user_id: string }> {
  const res = await fetch(BASE + '/api/keys/issue', {
    method: 'POST', headers: json, body: JSON.stringify(handle ? { handle } : {}),
  })
  const body = (await res.json()) as { key?: string; user_id?: string; error?: { message: string } }
  if (!body.key) throw new Error('mint failed (' + res.status + '): ' + (body.error?.message ?? 'no key'))
  return { key: body.key, user_id: body.user_id! }
}

type Usage = { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cost_usd?: number }

type Completion = {
  status: number
  text: string
  usage?: Usage
  headers: Headers
  firstByteMs: number | null
  totalMs: number
}

/** One chat completion, buffered or streamed, with the timings that matter. */
async function complete(key: string, body: Record<string, unknown>): Promise<Completion> {
  const t0 = Date.now()
  const res = await fetch(BASE + '/api/v1/chat/completions', {
    method: 'POST', headers: { ...json, ...auth(key) }, body: JSON.stringify(body),
  })

  if (!body.stream || !res.body) {
    const raw = await res.text()
    let text = ''
    let usage: Usage | undefined
    try {
      const parsed = JSON.parse(raw)
      text = parsed?.choices?.[0]?.message?.content ?? ''
      usage = parsed?.usage
    } catch { /* leave empty */ }
    return { status: res.status, text: text || raw, usage, headers: res.headers, firstByteMs: null, totalMs: Date.now() - t0 }
  }

  // Streaming: time to the FIRST frame is the number that matters, because that
  // is what buys the long wait. Everything after it is the supporter thinking.
  let firstByteMs: number | null = null
  let text = ''
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (firstByteMs === null) firstByteMs = Date.now() - t0
    buf += decoder.decode(value, { stream: true })
    let nl = buf.indexOf('\n\n')
    while (nl !== -1) {
      const frame = buf.slice(0, nl)
      buf = buf.slice(nl + 2)
      nl = buf.indexOf('\n\n')
      if (!frame.startsWith('data: ')) continue
      const payload = frame.slice(6)
      if (payload === '[DONE]') continue
      try {
        const o = JSON.parse(payload)
        if (o.error) text += '\n[error] ' + o.error.message
        const d = o?.choices?.[0]?.delta?.content
        if (typeof d === 'string') text += d
      } catch { /* keepalive comment or partial frame */ }
    }
  }
  return { status: res.status, text, headers: res.headers, firstByteMs, totalMs: Date.now() - t0 }
}

// --- the questions -------------------------------------------------------------
// Verifiable answers only. A relay that echoed, cached, or mocked would fail these.

const QUESTIONS = [
  { q: 'What is 17 times 23? Reply with just the number, no words.', expect: /391/ },
  { q: 'What is the capital of Australia? Reply with just the city name.', expect: /canberra/i },
  { q: 'How many sides does a hexagon have? Reply with just the digit.', expect: /\b6\b|six/i },
  { q: 'What is 144 divided by 12? Reply with just the number.', expect: /\b12\b/ },
  { q: 'Which planet is closest to the Sun? Reply with just the planet name.', expect: /mercury/i },
  { q: 'What is 2 to the power of 10? Reply with just the number.', expect: /1024/ },
  { q: 'In what year did the Apollo 11 moon landing happen? Reply with just the year.', expect: /1969/ },
  { q: 'What is the chemical symbol for gold? Reply with just the symbol.', expect: /\bAu\b/i },
  { q: 'What is 45 plus 55? Reply with just the number.', expect: /\b100\b/ },
  { q: 'How many continents are there? Reply with just the digit.', expect: /\b7\b|seven/i },
  { q: 'What is the largest ocean on Earth? Reply with just the ocean name.', expect: /pacific/i },
  { q: 'What is 9 squared? Reply with just the number.', expect: /\b81\b/ },
]

// --- run -----------------------------------------------------------------------

const supporters: ChildProcess[] = []
const summary: Record<string, unknown> = { run: RUN, base: BASE, startedAt: new Date(started).toISOString() }

function stats(xs: number[]) {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const at = (p: number) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
  return { n: s.length, min: s[0], p50: at(50), p90: at(90), max: s[s.length - 1], mean: Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) }
}

async function main() {
  await mkdir(OUT, { recursive: true })
  console.log('\n' + bold('Relaybee live end-to-end') + '  ' + dim(BASE) + '\n' + dim('run ' + RUN))

  // --- preflight ---------------------------------------------------------------
  section('Preflight: is the deployment alive and configured', 'preflight')
  const [health, healthMs] = await timed(async () => {
    const r = await fetch(BASE + '/api/health')
    return { status: r.status, body: (await r.json()) as Record<string, any> }
  })
  ok('the deployment answers /api/health', health.status === 200, 'status=' + health.status, healthMs)
  ok('both server secrets are configured',
    health.body?.configured?.master_secret === true && health.body?.configured?.master_encryption_key === true,
    JSON.stringify(health.body?.configured))
  // Against production the queue must be the durable one. Against a local
  // harness or a preview it is whatever that deployment was given, and asserting
  // upstash there would fail for the wrong reason.
  const isProd = BASE === 'https://relaybee.vercel.app'
  ok(isProd ? 'a durable queue backend is wired' : 'the queue backend is reported',
    isProd ? health.body?.queue === 'upstash' : typeof health.body?.queue === 'string',
    'queue=' + health.body?.queue)
  summary.commit = health.body?.commit
  summary.queue = health.body?.queue
  console.log(dim('  serving commit ' + health.body?.commit + ', providers ' + (health.body?.providers ?? []).join(', ')))

  // --- key lifecycle -----------------------------------------------------------
  section('A brand new API key, minted live and put to work', 'keys')
  const [alice, mintMs] = await timed(() => mint('alice'))
  ok('POST /api/keys/issue mints a key', Boolean(alice.key), alice.key.slice(0, 20) + '...', mintMs)
  ok('the key carries the current prefix', alice.key.startsWith('rb_live_'), alice.key.slice(0, 8))
  ok('the key is a signed payload, not an opaque id', alice.key.slice(8).split('.').length === 2)
  ok('the key names its own user id', alice.user_id.startsWith('alice_'), alice.user_id)

  const bob = await mint('bob')
  ok('a second key gets a different user id', bob.user_id !== alice.user_id, alice.user_id + ' vs ' + bob.user_id)

  const [models, modelsMs] = await timed(async () => {
    const r = await fetch(BASE + '/api/v1/models', { headers: auth(alice.key) })
    return { status: r.status, body: (await r.json()) as any }
  })
  ok('the fresh key authenticates immediately', models.status === 200, 'status=' + models.status, modelsMs)
  ok('and it can see the model catalogue', Array.isArray(models.body?.data) && models.body.data.length > 0,
    (models.body?.data ?? []).map((m: any) => m.id).join(', '))

  const noKey = await fetch(BASE + '/api/v1/models')
  ok('no key is rejected', noKey.status === 401, 'status=' + noKey.status)

  const parts = alice.key.slice(8).split('.')
  const body = parts[0]
  const sig = parts[1]
  const flipped = sig.slice(0, -1) + (sig.slice(-1) === 'A' ? 'B' : 'A')
  const forged = await fetch(BASE + '/api/v1/models', { headers: auth('rb_live_' + body + '.' + flipped) })
  ok('a key with one signature byte changed is rejected', forged.status === 401, 'status=' + forged.status)

  const reshaped = await fetch(BASE + '/api/v1/models', { headers: auth('rb_live_' + body) })
  ok('a key with the signature stripped is rejected', reshaped.status === 401, 'status=' + reshaped.status)

  const legacy = await fetch(BASE + '/api/v1/models', { headers: auth('fo_live_' + body + '.' + sig) })
  ok('the pre-rename fo_live_ prefix still verifies', legacy.status === 200, 'status=' + legacy.status)

  // --- cross-user isolation -----------------------------------------------------
  // No provider credential needed: sealing does not validate the upstream key, so a
  // throwaway one proves the binding without spending anything.
  section('Sealed connections are bound to the key that made them', 'sealing')
  const conn = await fetch(BASE + '/api/connect', {
    method: 'POST', headers: { ...json, ...auth(alice.key) },
    body: JSON.stringify({ provider: 'anthropic', api_key: 'sk-ant-not-a-real-key-live-e2e', label: 'alice-test' }),
  })
  const connBody = (await conn.json()) as any
  ok('a connection seals into an opaque blob', conn.status === 200 && typeof connBody.connection === 'string', 'status=' + conn.status)

  if (connBody.connection) {
    const [aliceUse, aliceMs] = await timed(() => fetch(BASE + '/api/v1/chat/completions', {
      method: 'POST',
      headers: { ...json, ...auth(alice.key), 'x-relaybee-connection': connBody.connection },
      body: JSON.stringify({ model: 'anthropic/claude-opus-5', messages: [{ role: 'user', content: 'hi' }] }),
    }))
    // The blob opens, the proxy reaches Anthropic, and Anthropic rejects the fake
    // credential. A 401 from upstream is the whole chain working.
    ok('the owner blob opens and the proxy reaches the provider', aliceUse.status === 401,
      'upstream said ' + aliceUse.status + ', attempts=' + aliceUse.headers.get('x-relaybee-attempts') +
      ', health=' + aliceUse.headers.get('x-relaybee-pool-health'), aliceMs)

    const bobUse = await fetch(BASE + '/api/v1/chat/completions', {
      method: 'POST',
      headers: { ...json, ...auth(bob.key), 'x-relaybee-connection': connBody.connection },
      body: JSON.stringify({ model: 'anthropic/claude-opus-5', messages: [{ role: 'user', content: 'hi' }] }),
    })
    ok('another user presenting the same blob is refused', bobUse.status === 403, 'status=' + bobUse.status)
  }

  // --- input handling -----------------------------------------------------------
  section('The edges callers actually hit', 'edges')
  const badModel = await complete(alice.key, { model: 'nope/whatever', messages: [{ role: 'user', content: 'hi' }] })
  ok('an unknown model is a clean 400, not a 500', badModel.status === 400, 'status=' + badModel.status)

  const noMessages = await complete(alice.key, { model: 'claude-code', messages: [] })
  ok('an empty messages array is refused before anything is queued', noMessages.status === 400, 'status=' + noMessages.status)

  const oversize = await complete(alice.key, { model: 'claude-code', messages: [{ role: 'user', content: 'x'.repeat(300 * 1024) }] })
  ok('a 300KB body is refused at the door', oversize.status === 400, 'status=' + oversize.status)

  const bigPool = await fetch(BASE + '/api/v1/chat/completions', {
    method: 'POST',
    headers: { ...json, ...auth(alice.key), 'x-relaybee-connection': Array(20).fill('blob').join(',') },
    body: JSON.stringify({ model: 'anthropic/claude-opus-5', messages: [{ role: 'user', content: 'hi' }] }),
  })
  ok('a 20-connection pool is capped rather than amplified', bigPool.status === 400, 'status=' + bigPool.status)

  if (SKIP_RELAY) { await finish(); return }

  // --- relay, cold --------------------------------------------------------------
  section('The relay with nobody home', 'relay-cold')
  const before = (await (await fetch(BASE + '/api/health')).json()) as any
  console.log(dim('  supporters online before we start: ' + before.supporters_online))
  if (before.supporters_online === 0) {
    const cold = await complete(alice.key, { model: 'claude-code', messages: [{ role: 'user', content: 'anyone there?' }] })
    ok('an unanswerable request fails fast instead of hanging', cold.status === 504 && cold.totalMs < 25_000, 'status=' + cold.status, cold.totalMs)
    ok('and it says nobody is online rather than blaming the caller', /no supporter is online/i.test(cold.text), cold.text.slice(0, 90))
  } else {
    ok('skipped the cold test, a supporter is already online', true, 'online=' + before.supporters_online)
  }

  // --- supporters up -------------------------------------------------------------
  section('Bringing ' + SUPPORTERS + ' real supporter node(s) online', 'relay-connect')
  const nodeKeys: string[] = []
  for (let i = 0; i < SUPPORTERS; i++) {
    const k = await mint('supporter' + (i + 1))
    nodeKeys.push(k.key)
    // --own-traffic-only: this run's callers are this run, so the node is
    // answering its operator's own questions on its operator's own login. That
    // is the one shape the API-billing rule does not cover, and it is why the
    // flag exists rather than the test quietly dropping --bare.
    const child = spawn(process.execPath, [
      join(process.cwd(), 'scripts', 'supporter.mjs'),
      '--base', BASE, '--key', k.key, '--label', 'node-' + (i + 1), '--telemetry', EVENTS,
      '--own-traffic-only', 'true', '--max-jobs', String(JOBS),
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', (d) => process.stdout.write(dim('  ' + String(d).trimEnd()) + '\n'))
    child.stderr.on('data', (d) => process.stderr.write(red('  ' + String(d).trimEnd()) + '\n'))
    supporters.push(child)
  }

  const connectStart = Date.now()
  let connected = 0
  while (Date.now() - connectStart < 60_000) {
    const states = await Promise.all(nodeKeys.map(async (k) => {
      const r = await fetch(BASE + '/api/work/status', { headers: auth(k) })
      return ((await r.json()) as any).connected === true
    }))
    connected = states.filter(Boolean).length
    if (connected === SUPPORTERS) break
    await new Promise((r) => setTimeout(r, 2000))
  }
  ok('all ' + SUPPORTERS + ' node(s) report connected', connected === SUPPORTERS, connected + '/' + SUPPORTERS, Date.now() - connectStart)

  // /api/health deliberately serves a cached count: 5s in-process, then s-maxage=10
  // with stale-while-revalidate=30 at the CDN. The relay-cold check above primed
  // that cache with zero, so the public number lags a node coming online by up to
  // 45s. That is the documented tradeoff, not a fault, so measure the lag instead
  // of asserting an instant answer. The private per-key /api/work/status above is
  // never cached, which is why the site uses that one to light up "connected".
  const healthLagStart = Date.now()
  let healthAgrees = false
  let healthLagMs = 0
  while (Date.now() - healthLagStart < 50_000) {
    const h = (await (await fetch(BASE + '/api/health')).json()) as any
    healthLagMs = Date.now() - healthLagStart
    if ((h.supporters_online ?? 0) >= SUPPORTERS) { healthAgrees = true; break }
    await new Promise((r) => setTimeout(r, 3000))
  }
  summary.healthLagMs = healthLagMs
  ok('the public health count catches up inside its documented 45s window', healthAgrees, 'lag ' + healthLagMs + 'ms', healthLagMs)

  const stranger = await fetch(BASE + '/api/work/status', { headers: auth(bob.key) })
  const strangerBody = (await stranger.json()) as any
  ok('a stranger sees no node of their own', strangerBody.connected === false, 'connected=' + strangerBody.connected)

  // --- relay, warm ----------------------------------------------------------------
  section(JOBS + ' real requests through the relay, ' + CONCURRENCY + ' at a time', 'relay-warm')
  console.log(dim('  every answer comes from a real local agent, and has to be right\n'))

  type Result = {
    i: number; q: string; stream: boolean; status: number
    totalMs: number; firstByteMs: number | null; answer: string; correct: boolean; usage?: Usage
  }
  const results: Result[] = []
  // A key per caller, so this is a real multi-tenant run rather than one client in
  // a loop. Minting is IP-limited at 10/min, so callers share a small pool of keys.
  const extra = await Promise.all([mint('carol'), mint('dave')])
  const callerKeys = [alice.key, bob.key, extra[0].key, extra[1].key]

  let next = 0
  await Promise.all(Array.from({ length: CONCURRENCY }, async (_unused, lane) => {
    for (;;) {
      const i = next++
      if (i >= JOBS) return
      const { q, expect } = QUESTIONS[i % QUESTIONS.length]
      // Alternate so both paths are measured. The buffered window is 20s, the
      // streamed one 110s, and real agents do not reliably fit the first.
      const stream = i % 2 === 1
      const key = callerKeys[lane % callerKeys.length]
      const r = await complete(key, { model: 'claude-code', stream, messages: [{ role: 'user', content: q }] })
      const correct = expect.test(r.text)
      results.push({ i, q, stream, status: r.status, totalMs: r.totalMs, firstByteMs: r.firstByteMs, answer: r.text.slice(0, 120), correct, usage: r.usage })
      await event({ event: 'caller_result', i, stream, status: r.status, totalMs: r.totalMs, firstByteMs: r.firstByteMs, correct, answerChars: r.text.length })
      const tag = correct ? green('correct') : red('wrong  ')
      console.log('  ' + tag + ' ' + dim('#' + String(i).padStart(2) + ' ' + (stream ? 'stream' : 'buffer') + ' ' + String(r.totalMs).padStart(6) + 'ms') + ' ' + JSON.stringify(r.text.slice(0, 60)))
    }
  }))

  results.sort((a, b) => a.i - b.i)
  const streamed = results.filter((r) => r.stream)
  const buffered = results.filter((r) => !r.stream)
  ok('every relayed request came back 200', results.every((r) => r.status === 200), results.filter((r) => r.status === 200).length + '/' + results.length)
  ok('every streamed answer is the correct answer', streamed.length > 0 && streamed.every((r) => r.correct),
    streamed.filter((r) => r.correct).length + '/' + streamed.length + ' correct')
  ok('the first stream frame always arrives inside the Edge deadline', streamed.every((r) => (r.firstByteMs ?? 1e9) < 25_000),
    'max ' + Math.max(...streamed.map((r) => r.firstByteMs ?? 0)) + 'ms')
  ok('buffered answers land too, or time out honestly', buffered.every((r) => r.correct || /supporter took this/i.test(r.answer)),
    buffered.filter((r) => r.correct).length + '/' + buffered.length + ' correct inside the 20s window')

  // The nodes report what each job cost them, so the caller's usage block should
  // carry real numbers rather than the zeros a relay has nothing to fill in with.
  const costed = results.filter((r) => (r.usage?.total_tokens ?? 0) > 0)
  ok('the caller is told what the answer cost', costed.length === buffered.length,
    costed.length + '/' + buffered.length + ' buffered answers carried a token count')
  const spend = results.reduce((a, r) => a + (r.usage?.cost_usd ?? 0), 0)
  console.log(dim('  reported spend across this run: $' + spend.toFixed(4)))
  summary.reportedSpendUsd = spend

  summary.results = results
  summary.latency = stats(results.map((r) => r.totalMs))
  summary.streamLatency = stats(streamed.map((r) => r.totalMs))
  summary.bufferLatency = stats(buffered.map((r) => r.totalMs))
  summary.firstByte = stats(streamed.map((r) => r.firstByteMs ?? 0))
  summary.correctness = { correct: results.filter((r) => r.correct).length, total: results.length }

  await finish()
}

async function finish() {
  // The last answer reaches the caller before the node has finished writing its
  // own telemetry line for it, so killing immediately loses one job from the
  // supporter-side stats. Let the writes land, then stop the nodes.
  if (supporters.length) await new Promise((r) => setTimeout(r, 1500))
  for (const c of supporters) c.kill()

  // Supporter-side timings come from the node's own telemetry, so the report has
  // both halves: what the caller waited, and where inside the relay it went.
  const lines = (await readFile(EVENTS, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const servedJobs = lines.filter((l: any) => l.event === 'job_served')
  if (servedJobs.length) {
    summary.supporter = {
      served: servedJobs.length,
      queueWaitMs: stats(servedJobs.map((j: any) => j.queueWaitMs)),
      agentMs: stats(servedJobs.map((j: any) => j.agentMs)),
      deliverMs: stats(servedJobs.map((j: any) => j.deliverMs)),
    }
  }

  const passed = checks.filter((c) => c.pass).length
  summary.checks = { passed, total: checks.length }
  summary.detail = checks
  summary.durationMs = Date.now() - started
  summary.finishedAt = new Date().toISOString()

  await writeFile(join(OUT, RUN + '.json'), JSON.stringify(summary, null, 2))

  console.log('\n' + dim('-'.repeat(72)))
  console.log(bold(passed + '/' + checks.length + ' checks passed') + ' in ' + ((Date.now() - started) / 1000).toFixed(1) + 's')
  if (summary.latency) {
    const l = summary.latency as any
    console.log(dim('relay latency   p50 ' + l.p50 + 'ms  p90 ' + l.p90 + 'ms  max ' + l.max + 'ms  over ' + l.n + ' real requests'))
  }
  if (summary.supporter) {
    const s = summary.supporter as any
    console.log(dim('supporter side  queue wait p50 ' + s.queueWaitMs.p50 + 'ms  model p50 ' + s.agentMs.p50 + 'ms  deliver p50 ' + s.deliverMs.p50 + 'ms'))
  }
  console.log(dim('telemetry  ' + EVENTS))
  console.log(dim('summary    ' + join(OUT, RUN + '.json') + '\n'))

  if (passed !== checks.length) {
    console.log(red('failed checks:'))
    for (const c of checks.filter((x) => !x.pass)) console.log(red('  [' + c.stage + '] ' + c.name + '  ' + c.detail))
    process.exit(1)
  }
}

process.on('SIGINT', () => { for (const c of supporters) c.kill(); process.exit(130) })

main().catch(async (e) => {
  for (const c of supporters) c.kill()
  console.error(red('\nlive run aborted: ' + (e?.stack ?? e)))
  process.exit(1)
})
