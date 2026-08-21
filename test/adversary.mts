// The attack suite. It mints its own keys and tries to break in.
//
//   npm run test:adversary                           # boots its own server
//   npx tsx test/adversary.mts --base https://...    # against a real deployment
//
// Nothing here needs a human, an operator, or a credential from anywhere. That
// is the whole point: /api/keys/issue is unauthenticated and free, so a stranger
// starts exactly where this file starts, and every capability an attacker has is
// a capability this file can exercise on its own.
//
// It also costs nothing to run. The victim's node answers with a canned string
// rather than a model, because what is being tested is who is allowed to reach
// whom, not whether the answer is any good. test/live-e2e.mts is the one that
// spends money proving real inference works.
//
// Every check is written so that PASSING means the attack FAILED. A line that
// says BREACH is a real finding.

import { appendFile, mkdir } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'

const argv = new Map<string, string>()
for (let i = 2; i < process.argv.length; i += 2) argv.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1])

/**
 * With no --base this boots the real edge handlers on an ephemeral port and
 * attacks those. That is deliberate: an attack suite that needs a deployment, a
 * credential, or an operator is one that does not run, and this one has to run
 * on every push. It makes no model calls and needs no secrets, so it is free.
 */
async function bootLocal(): Promise<string> {
  process.env.MASTER_SECRET = 'adversary-suite-secret-not-real'
  process.env.MASTER_ENCRYPTION_KEY = Buffer.from(new Uint8Array(32).fill(23)).toString('base64url')
  const routes: Record<string, (req: Request) => Promise<Response> | Response> = {
    'POST /api/keys/issue': (await import('../api/keys/issue.ts')).default,
    'POST /api/connect': (await import('../api/connect.ts')).default,
    'GET /api/v1/models': (await import('../api/v1/models.ts')).default,
    'POST /api/v1/chat/completions': (await import('../api/v1/chat/completions.ts')).default,
    'POST /api/work/next': (await import('../api/work/next.ts')).default,
    'POST /api/work/complete': (await import('../api/work/complete.ts')).default,
    'GET /api/work/status': (await import('../api/work/status.ts')).default,
    'GET /api/health': (await import('../api/health.ts')).default,
  }
  const server = createServer(async (req: IncomingMessage, out: ServerResponse) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const headers = new Headers()
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v)
    // One source address for the whole run, because "one attacker" is the threat
    // being modelled and a per-request address would hand them a fresh bucket.
    if (!headers.has('x-real-ip')) headers.set('x-real-ip', '203.0.113.99')
    const path = (req.url ?? '/').split('?')[0]
    const h = routes[`${req.method} ${path}`]
    if (!h) { out.statusCode = 404; out.setHeader('content-type', 'application/json'); out.end('{}'); return }
    const res = await h(new Request(`http://127.0.0.1${req.url}`, {
      method: req.method, headers, body: chunks.length ? (Buffer.concat(chunks) as unknown as BodyInit) : undefined,
    }))
    out.statusCode = res.status
    res.headers.forEach((v, k) => out.setHeader(k, v))
    if (res.body) {
      const reader = res.body.getReader()
      for (;;) { const { done, value } = await reader.read(); if (done) break; out.write(Buffer.from(value)) }
    }
    out.end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  server.unref()
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

const BASE = (argv.get('base') ?? (await bootLocal())).replace(/\/$/, '')
const OUT = argv.get('out') ?? join(process.cwd(), 'telemetry')

const started = Date.now()
const RUN = 'adversary-' + new Date(started).toISOString().replace(/[:.]/g, '-')

const dim = (s: string) => '\x1b[2m' + s + '\x1b[0m'
const bold = (s: string) => '\x1b[1m' + s + '\x1b[0m'
const green = (s: string) => '\x1b[32m' + s + '\x1b[0m'
const red = (s: string) => '\x1b[31m' + s + '\x1b[0m'

type Check = { attack: string; held: boolean; detail: string }
const checks: Check[] = []

/** `held` is true when the defence held, i.e. the attack was refused. */
function held(attack: string, ok: boolean, detail = '') {
  checks.push({ attack, held: ok, detail })
  console.log((ok ? green('held  ') : red('BREACH')) + '  ' + attack + (detail ? '  ' + dim(detail) : ''))
}

function section(title: string) {
  console.log('\n' + dim('-'.repeat(74)) + '\n' + bold(title) + '\n')
}

const json = { 'content-type': 'application/json' }
const auth = (key: string) => ({ authorization: 'Bearer ' + key })

async function mint(handle: string): Promise<{ key: string; user_id: string }> {
  const res = await fetch(BASE + '/api/keys/issue', {
    method: 'POST', headers: json, body: JSON.stringify({ handle }),
  })
  const body = (await res.json()) as { key?: string; user_id?: string; error?: { message: string } }
  if (!body.key) throw new Error(`mint failed (${res.status}): ${body.error?.message ?? 'no key'}`)
  return { key: body.key, user_id: body.user_id! }
}

const post = (path: string, body: unknown, key?: string) =>
  fetch(BASE + path, {
    method: 'POST',
    headers: { ...json, ...(key ? auth(key) : {}) },
    body: JSON.stringify(body),
  })

/**
 * A minimal honest node for the victim: poll, answer with a fixed string,
 * deliver. No model, so this suite is free to run and safe in CI.
 */
function victimNode(key: string, stop: { done: boolean }, seen: string[]) {
  return (async () => {
    while (!stop.done) {
      let res: Response
      try {
        res = await post('/api/work/next', { pool: 'own' }, key)
      } catch { return }
      if (res.status !== 200) continue
      const job = (await res.json()) as { id: string; ticket: string; messages: Array<{ content: string }> }
      seen.push(job.messages.at(-1)?.content ?? '')
      await post('/api/work/complete', { id: job.id, ticket: job.ticket, text: 'ANSWERED_BY_THE_VICTIMS_OWN_NODE' }, key)
    }
  })()
}

async function main() {
  console.log('\n' + bold('Relaybee adversary suite') + '  ' + dim(BASE))
  console.log(dim('every key below was minted by this process; no human was involved'))

  // --- the attacker sets themselves up, exactly as a stranger would ---------
  section('Getting in the door')
  const t0 = Date.now()
  const attacker = await mint('attacker')
  held('minting a key needs no account, which is the attacker\'s starting position',
    true, 'got ' + attacker.user_id + ' in ' + (Date.now() - t0) + 'ms')
  const victim = await mint('victim')
  const victimNodeKey = victim.key // the same key: that pairing is the access control

  // --- 1. can a stranger read someone else's prompts? ----------------------
  section('Attack 1: drain the queue and read a stranger\'s prompt')
  const stop = { done: false }
  const seen: string[] = []
  const node = victimNode(victimNodeKey, stop, seen)

  // Let the node get its first poll in before the victim calls.
  await new Promise((r) => setTimeout(r, 1200))

  const SECRET = 'CANARY_PROMPT_' + Math.round((Date.now() - started) * 7919).toString(36)
  const victimCall = post('/api/v1/chat/completions', {
    model: 'claude-code', messages: [{ role: 'user', content: SECRET }],
  }, victim.key)

  // The attacker tries both queues at once. A poll holds for ~15s, so these run
  // alongside the victim's call rather than after it.
  const drainOwn = post('/api/work/next', {}, attacker.key)
  const drainPublic = post('/api/work/next', { pool: 'public' }, attacker.key)

  const answered = await victimCall
  const answerBody = (await answered.json()) as { id?: string; choices?: Array<{ message?: { content?: string } }> }
  const delivered = answerBody.choices?.[0]?.message?.content ?? ''

  held('the victim\'s own node is the one that answered', delivered === 'ANSWERED_BY_THE_VICTIMS_OWN_NODE', JSON.stringify(delivered.slice(0, 40)))

  const own = await drainOwn
  const pub = await drainPublic
  const ownBody = own.status === 200 ? await own.text() : ''
  const pubBody = pub.status === 200 ? await pub.text() : ''
  held('a stranger polling their own queue got no job', own.status === 204, 'status=' + own.status)
  held('a stranger opting into the public pool got no private job', pub.status === 204, 'status=' + pub.status)
  held('the secret prompt never appeared in anything the attacker was handed',
    !ownBody.includes(SECRET) && !pubBody.includes(SECRET))
  held('and the victim\'s node did see it, so the test was actually live',
    seen.some((s) => s.includes(SECRET)), seen.length + ' job(s) served')

  // --- 2. can a stranger write someone else's answer? ----------------------
  section('Attack 2: inject an answer into a stranger\'s request')
  // The job id is public by construction: the caller is handed chatcmpl-<id>.
  const leakedId = String(answerBody.id ?? '').replace(/^chatcmpl-/, '')
  held('the job id really is exposed to anyone who can see a response',
    /^[0-9a-f-]{36}$/.test(leakedId), leakedId || '(none)')

  const injectNoTicket = await post('/api/work/complete', { id: leakedId, text: 'INJECTED' }, attacker.key)
  held('completing with just the leaked id is refused', injectNoTicket.status !== 200, 'status=' + injectNoTicket.status)

  const injectFakeTicket = await post('/api/work/complete', { id: leakedId, ticket: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', text: 'INJECTED' }, attacker.key)
  held('completing with an invented ticket is refused', injectFakeTicket.status === 403, 'status=' + injectFakeTicket.status)

  stop.done = true

  // --- 3. can a stranger forge a key? --------------------------------------
  section('Attack 3: forge, tamper with, or extend an API key')
  const [body, sig] = victim.key.slice('rb_live_'.length).split('.')
  const probe = async (name: string, key: string, want = 401) => {
    const r = await fetch(BASE + '/api/v1/models', { headers: auth(key) })
    held(name, r.status === want, 'status=' + r.status)
  }
  await probe('a flipped signature byte', 'rb_live_' + body + '.' + sig.slice(0, -1) + (sig.slice(-1) === 'A' ? 'B' : 'A'))
  await probe('the signature removed entirely', 'rb_live_' + body)
  await probe('another user\'s payload under this signature', 'rb_live_' + attacker.key.slice('rb_live_'.length).split('.')[0] + '.' + sig)
  await probe('a payload edited to claim the pro tier',
    'rb_live_' + Buffer.from(JSON.stringify({ u: 'anyone', t: 'pro', v: 1, i: 0, e: 9e9 })).toString('base64url') + '.' + sig)
  await probe('a made-up key', 'rb_live_bm9wZQ.bm9wZQ')
  await probe('no key at all', '')

  // --- 4. can a stranger use someone else's provider credential? -----------
  section('Attack 4: use a sealed connection that belongs to someone else')
  const sealed = await post('/api/connect', {
    provider: 'anthropic', api_key: 'sk-ant-adversary-suite-not-real', label: 'victim-conn',
  }, victim.key)
  const blob = ((await sealed.json()) as { connection?: string }).connection
  held('the victim could seal a connection', typeof blob === 'string', 'status=' + sealed.status)
  if (blob) {
    const steal = await fetch(BASE + '/api/v1/chat/completions', {
      method: 'POST',
      headers: { ...json, ...auth(attacker.key), 'x-relaybee-connection': blob },
      body: JSON.stringify({ model: 'anthropic/claude-opus-5', messages: [{ role: 'user', content: 'hi' }] }),
    })
    held('a stranger replaying that blob is refused', steal.status === 403, 'status=' + steal.status)
  }

  // --- 5. can a stranger make one request cost eight? ----------------------
  section('Attack 5: amplify one cheap request into many upstream calls')
  const pool = await fetch(BASE + '/api/v1/chat/completions', {
    method: 'POST',
    headers: { ...json, ...auth(attacker.key), 'x-relaybee-connection': Array(20).fill('blob').join(',') },
    body: JSON.stringify({ model: 'anthropic/claude-opus-5', messages: [{ role: 'user', content: 'hi' }] }),
  })
  held('a 20-connection pool is refused rather than walked', pool.status === 400, 'status=' + pool.status)

  // A body that is inside the cap by JS string length and far over it in bytes.
  const multibyte = '漢'.repeat(120 * 1024)
  const payload = JSON.stringify({ model: 'claude-code', messages: [{ role: 'user', content: multibyte }] })
  const bytes = new TextEncoder().encode(payload).length
  const big = await fetch(BASE + '/api/v1/chat/completions', {
    method: 'POST', headers: { ...json, ...auth(attacker.key) }, body: payload,
  })
  held('an oversized multibyte body is measured in bytes, not characters',
    big.status === 400, payload.length + ' chars = ' + bytes + ' bytes, status=' + big.status)

  // --- 6. is anything unmetered? -------------------------------------------
  section('Attack 6: find an endpoint with no meter on it')
  // Before the burst: a 429 from an exhausted bucket would pass this for the
  // wrong reason, and a check that cannot fail is not a check.
  const proto = await post('/api/connect', { provider: 'constructor', api_key: 'sk-ant-proto-probe' }, attacker.key)
  held('a prototype key is not accepted as a provider', proto.status === 400, 'status=' + proto.status)
  const dunder = await post('/api/connect', { provider: '__proto__', api_key: 'sk-ant-proto-probe' }, attacker.key)
  held('and neither is __proto__', dunder.status === 400, 'status=' + dunder.status)

  let sealLimited = false
  let sealCalls = 0
  for (let i = 0; i < 60 && !sealLimited; i++) {
    const r = await post('/api/connect', { provider: 'anthropic', api_key: 'sk-ant-burst-' + i }, attacker.key)
    sealCalls++
    if (r.status === 429) sealLimited = true
  }
  held('sealing connections is rate limited', sealLimited, 'limited after ' + sealCalls + ' call(s)')

  // --- report ---------------------------------------------------------------
  stop.done = true
  await node.catch(() => {})

  const breaches = checks.filter((c) => !c.held)
  console.log('\n' + dim('-'.repeat(74)))
  console.log(bold(`${checks.length - breaches.length}/${checks.length} defences held`) + ' in ' + ((Date.now() - started) / 1000).toFixed(1) + 's')

  await mkdir(OUT, { recursive: true }).catch(() => {})
  await appendFile(join(OUT, RUN + '.jsonl'),
    checks.map((c) => JSON.stringify({ at: Date.now(), base: BASE, ...c })).join('\n') + '\n').catch(() => {})

  if (breaches.length) {
    console.log(red('\nbreached:'))
    for (const b of breaches) console.log(red('  ' + b.attack + '  ' + b.detail))
    process.exit(1)
  }
  console.log(dim('no attack in this suite got anything it should not have\n'))
}

main().catch((e) => {
  console.error(red('\nadversary run aborted: ' + (e?.stack ?? e)))
  process.exit(1)
})
