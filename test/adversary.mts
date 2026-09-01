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
  const { serveRoutes } = await import('./local-server.mts')
  const { base } = await serveRoutes({
    'POST /api/keys/issue': (await import('../api/keys/issue.ts')).default,
    'POST /api/connect': (await import('../api/connect.ts')).default,
    'GET /api/v1/models': (await import('../api/v1/models.ts')).default,
    'POST /api/v1/chat/completions': (await import('../api/v1/chat/completions.ts')).default,
    'POST /api/work/next': (await import('../api/work/next.ts')).default,
    'POST /api/work/complete': (await import('../api/work/complete.ts')).default,
    'GET /api/work/status': (await import('../api/work/status.ts')).default,
    'GET /api/health': (await import('../api/health.ts')).default,
  }, {
    // One source address for the whole run, because "one attacker" is the
    // threat being modelled and a per-request address hands them a fresh bucket.
    defaultHeaders: { 'x-real-ip': '203.0.113.99' },
  })
  return base
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
 *
 * It keeps the tickets it was issued, because the ticket forgery below has to be
 * the same length as a real one or the length guard in checkTicket refuses it
 * before the constant-time compare ever runs.
 */
function victimNode(key: string, stop: { done: boolean }, seen: string[], tickets: string[]) {
  return (async () => {
    while (!stop.done) {
      let res: Response
      try {
        res = await post('/api/work/next', { pool: 'own' }, key)
      } catch { return }
      if (res.status !== 200) continue
      const job = (await res.json()) as { id: string; ticket: string; messages: Array<{ content: string }> }
      seen.push(job.messages.at(-1)?.content ?? '')
      tickets.push(job.ticket)
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
  const victim = await mint('victim')
  const victimNodeKey = victim.key // the same key: that pairing is the access control

  // A control, not a defence, so it aborts the run rather than counting itself
  // among the checks that held. Every refusal below is only meaningful while the
  // attacker is holding a key that actually authenticates: a suite whose
  // attacker cannot get in anywhere would report a clean sweep having tested
  // nothing, and this line used to be a literal `true` that could not say so.
  const attackerAuth = await fetch(BASE + '/api/v1/models', { headers: auth(attacker.key) })
  if (attackerAuth.status !== 200) {
    throw new Error(`the attacker's minted key does not authenticate (status ${attackerAuth.status}), so nothing below would be testing anything`)
  }
  console.log(dim('control  minting needs no account: ' + attacker.user_id +
    ' in ' + (Date.now() - t0) + 'ms, and the key works'))

  // --- 1. can a stranger read someone else's prompts? ----------------------
  section('Attack 1: drain the queue and read a stranger\'s prompt')
  const stop = { done: false }
  const seen: string[] = []
  const tickets: string[] = []
  const node = victimNode(victimNodeKey, stop, seen, tickets)

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

  // Any non-200 used to pass this, which included a 429 from an exhausted bucket
  // and a 503 from a queue that was simply down. A missing ticket is a 400, and
  // that is the status that means the endpoint looked and refused.
  const injectNoTicket = await post('/api/work/complete', { id: leakedId, text: 'INJECTED' }, attacker.key)
  held('completing with just the leaked id is refused as a missing ticket',
    injectNoTicket.status === 400, 'status=' + injectNoTicket.status)

  // checkTicket compares lengths before it compares bytes, and the forgery here
  // used to be 42 characters against a real 43, so the length guard threw it out
  // and the constant-time compare underneath was never exercised at all. Build
  // one from a real ticket so it is the right length and every byte is wrong.
  const realTicket = tickets[0] ?? ''
  const forgedTicket = realTicket
    ? [...realTicket].map((c) => (c === 'A' ? 'B' : 'A')).join('')
    : 'A'.repeat(43)
  const injectFakeTicket = await post('/api/work/complete', { id: leakedId, ticket: forgedTicket, text: 'INJECTED' }, attacker.key)
  held('an invented ticket of the right length is refused by the compare, not the length guard',
    injectFakeTicket.status === 403 && realTicket.length > 0 && forgedTicket.length === realTicket.length,
    'status=' + injectFakeTicket.status + ', forged ' + forgedTicket.length + ' vs real ' + realTicket.length + ' chars')

  stop.done = true

  // --- 3. can a stranger forge a key? --------------------------------------
  section('Attack 3: forge, tamper with, or extend an API key')
  const [body, sig] = victim.key.slice('rb_live_'.length).split('.')
  const probe = async (name: string, key: string, want = 401) => {
    const r = await fetch(BASE + '/api/v1/models', { headers: auth(key) })
    held(name, r.status === want, 'status=' + r.status)
  }
  // Flip a character at the FRONT of the signature: every character there
  // contributes six significant bits, so this is always a different signature.
  await probe('a flipped signature byte', 'rb_live_' + body + '.' + (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1))
  // The last character is the interesting one and it has to be computed. A
  // 32-byte signature is 43 base64url characters, so the final one carries four
  // significant bits and two spare, and its alphabet index is always a multiple
  // of four: only the three characters above it in that group decode to the same
  // bytes. Those are the spellings the HMAC cannot tell apart, and the canonical
  // check in lib/auth.ts is the only thing rejecting them. Guessing a letter
  // usually lands in another group, where the HMAC does the work and this passes
  // while testing nothing.
  const B64U = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  const last = B64U.indexOf(sig.slice(-1))
  const group = last - (last % 4)
  for (const n of [group, group + 1, group + 2, group + 3]) {
    if (n === last) continue
    await probe('a non-canonical spelling of the same signature (' + B64U[n] + ')',
      'rb_live_' + body + '.' + sig.slice(0, -1) + B64U[n])
  }
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
