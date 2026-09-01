// Runs lib/queue.ts against a fake Upstash REST server, so the branch that
// actually serves production is exercised instead of only the memory fallback.
//
//   npm run test:upstash
//
// The store is chosen at module load from the environment, so the env has to be
// set before lib/queue is imported. That is why this is its own file.

import { startFakeUpstash } from './fake-upstash.mts'

const fake = await startFakeUpstash()
process.env.UPSTASH_REDIS_REST_URL = fake.url
process.env.UPSTASH_REDIS_REST_TOKEN = fake.token
process.env.MASTER_SECRET = 'upstash-test-secret'

const queue = await import('../lib/queue.ts')
// Every job belongs to a requester now, and a node only ever sees its own
// queue. These tests act as one user throughout unless they say otherwise.
const OWNER = 'upstash_owner'
const { issueKey } = await import('../lib/auth.ts')

let failed = 0
const t = (name: string, cond: boolean, extra = '') => {
  if (!cond) failed++
  console.log(`${cond ? 'pass' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`)
}

console.log('\nupstash — the real REST path, not the memory fallback')
t('the queue selected the Upstash store', queue.QUEUE_DISTRIBUTED === true)

console.log('\nupstash — job round trip')
const submitted = await queue.submitJob('claude-code', [{ role: 'user', content: 'hello upstash' }], OWNER)
const popped = await queue.nextJob(2000, OWNER)
t('a submitted job comes back off the REST queue', popped?.id === submitted.id, popped?.id ?? 'none')
t('the job carries its messages intact', popped?.messages[0]?.content === 'hello upstash')
t('the queue is empty once popped', (await queue.nextJob(1000, OWNER)) === null)

console.log('\nupstash — a caller that gives up takes its job with it')
// Without this, a job abandoned after 15s still looks fresh to the age trim for
// another 45, so the next supporter to connect burns real model time on it.
const abandoned = await queue.submitJob('claude-code', [{ role: 'user', content: 'nobody is waiting for this' }], OWNER)
fake.reset()
await queue.cancelJob(abandoned, OWNER)
t('cancelling costs one command', fake.total() === 1, `${fake.total()}`)
t('the abandoned job is gone, so no supporter can be handed it', (await queue.nextJob(1200, OWNER)) === null)

// Cancelling a job a supporter already took must be a harmless no-op, not an error.
const taken = await queue.submitJob('claude-code', [{ role: 'user', content: 'already popped' }], OWNER)
const gotIt = await queue.nextJob(2000, OWNER)
t('the supporter got the job first', gotIt?.id === taken.id)
await queue.cancelJob(taken, OWNER)
t('cancelling an already-popped job is harmless', true)

console.log('\nupstash — stale jobs are dropped (regression guard for #55)')
// Push a job older than JOB_MAX_AGE_MS straight into the store, the way a queue
// that filled while nobody was online would look.
// The key name encodes the requester now, which is the isolation itself.
await fake.raw(['LPUSH', `relaybee:jobs:u:${OWNER}`, JSON.stringify({
  id: 'stale-1', model: 'claude-code', messages: [{ role: 'user', content: 'old' }],
  queuedAt: Date.now() - 5 * 60_000,
})])
t('a job older than the max age is never handed to a supporter', (await queue.nextJob(1500, OWNER)) === null)

console.log('\nupstash — answer delivery')
const answerId = 'result-round-trip'
await queue.completeJob(answerId, 'the answer')
t('an answer written by a supporter is read by the waiting caller', (await queue.awaitResult(answerId, 2000))?.text === 'the answer')

// A node reports what the job cost it, because the relay never sees the model
// call and so has nothing of its own to report.
const costedId = 'result-with-usage'
await queue.completeJob(costedId, 'costed answer', { inputTokens: 12, outputTokens: 34, costUsd: 0.0021 })
const costed = await queue.awaitResult(costedId, 2000)
t('a reported cost survives the round trip', costed?.usage?.inputTokens === 12 && costed?.usage?.outputTokens === 34, JSON.stringify(costed?.usage))
t('and the answer still comes back with it', costed?.text === 'costed answer')

// An answer written before this envelope existed is a bare string in Redis, and
// it has to stay readable for RESULT_TTL_S across the deploy that introduces it.
const legacyId = 'result-pre-envelope'
await fake.raw(['LPUSH', `relaybee:result:${legacyId}`, 'a bare pre-envelope answer'])
t('a pre-envelope answer is still delivered, not lost to a parse error',
  (await queue.awaitResult(legacyId, 2000))?.text === 'a bare pre-envelope answer')
t('an answer is delivered once, then gone', (await queue.awaitResult(answerId, 300)) === null)

console.log('\nupstash — command cost, which is the whole point of the change')
fake.reset()
const t0 = Date.now()
const nothing = await queue.awaitResult('never-answered', 3000)
const waited = Date.now() - t0
t('an unanswered 3s wait resolves null', nothing === null)
t('it blocks server side rather than spinning', waited >= 2800, `${waited}ms`)
t('a 3s wait costs one command, not six', fake.total() === 1, `${fake.total()} commands: ${[...fake.counts].map(([k, v]) => k + '=' + v).join(' ')}`)

fake.reset()
await queue.completeJob('cost-check', 'x')
t('publishing an answer costs two commands', fake.total() === 2, `${fake.total()}`)

console.log('\nupstash — presence')
await queue.markLive('node-a')
t('a polling node reads back as live', (await queue.isLive('node-a')) === true)
t('an unknown node reads back as offline', (await queue.isLive('node-b')) === false)
t('the global count sees it', (await queue.countLive()) >= 1)

console.log('\nupstash — counting supporters is one read, not a write plus a read')
// Plant a node whose last beat is older than the TTL.
const liveBefore = await queue.countLive()
await fake.raw(['ZADD', 'relaybee:nodes', Date.now() - (46 * 1000), 'stale-node'])
fake.reset()
const counted = await queue.countLive()
t('counting costs one command', fake.total() === 1, `${fake.total()} commands: ${[...fake.counts].map(([k, v]) => k + '=' + v).join(' ')}`)
t('and it is a range read, not a prune', (fake.counts.get('ZREMRANGEBYSCORE') ?? 0) === 0)
t('a node past its TTL is not counted', counted === liveBefore, `${counted} vs ${liveBefore}`)
const stored = await fake.raw(['ZCARD', 'relaybee:nodes'])
t('the expired member is still in the set, so the count did not rely on deleting it',
  stored === liveBefore + 1, String(stored))

console.log('\nupstash — the sweep rides the beat that grows the set, not a counter')
// A counter would live in one warm instance, so a poll landing on a cold one
// would restart it and the degenerate case would never sweep. Keying off ZADD's
// return value is server-side state, so it survives a cold start. Only the
// second assertion discriminates: a counter also skips the sweep on most beats,
// so it would still pass the first one.
fake.reset()
await queue.markLive('node-a')
t('a repeat beat from a known node costs one command and no sweep',
  fake.total() === 1 && (fake.counts.get('ZREMRANGEBYSCORE') ?? 0) === 0,
  `${fake.total()} commands: ${[...fake.counts].map(([k, v]) => k + '=' + v).join(' ')}`)

fake.reset()
await queue.markLive('brand-new-node')
t('the beat that adds a member sweeps', (fake.counts.get('ZREMRANGEBYSCORE') ?? 0) === 1, String(fake.counts.get('ZREMRANGEBYSCORE')))
t('and it removed the node that was past its TTL', (await fake.raw(['ZSCORE', 'relaybee:nodes', 'stale-node'])) === null)
t('so the set holds the live nodes and nothing else',
  (await fake.raw(['ZCARD', 'relaybee:nodes'])) === liveBefore + 1, String(await fake.raw(['ZCARD', 'relaybee:nodes'])))

console.log('\nupstash — presence is per pool, because that is what a "/public" caller depends on')
// Every node marks itself live whether or not it opted into the shared pool,
// so the global number cannot answer "is anyone watching the queue MY job went
// into". A second, opt-in set can, and an own-only node must not appear in it.
// Warm the member first: the beat that ADDS a node also sweeps, so measuring a
// first beat would measure the sweep and not the opt-in.
await queue.markLive('own-only-node')
fake.reset()
await queue.markLive('own-only-node')
t('a repeat own-only beat still costs exactly one command', fake.total() === 1,
  `${fake.total()} commands: ${[...fake.counts].map(([k, v]) => k + '=' + v).join(' ')}`)
t('and an own-only node is not counted as watching the public pool',
  (await queue.countLivePublic()) === 0, String(await queue.countLivePublic()))
fake.reset()
await queue.markLive('public-node', true)
t('a node that opted in is counted in the public pool',
  (await queue.countLivePublic()) === 1, String(await queue.countLivePublic()))
t('and it still shows up in the global number the site displays',
  (await queue.isLive('public-node')) === true)
t('opting in costs one extra write, paid only by the nodes that opt in',
  (fake.counts.get('ZADD') ?? 0) === 2, String(fake.counts.get('ZADD')))

console.log('\nupstash — the presence heartbeat is throttled, not per poll')
const workNext = (await import('../api/work/next.ts')).default
const pollReq = (k: string) => new Request('https://x/api/work/next', {
  method: 'POST', headers: { authorization: `Bearer ${k}` },
})
// The node polls its OWN queue, so the job has to be queued under the same user
// the key names. Under the old global list any user id would have done.
const BEAT_USER = 'beat_user'
const beatKey = await issueKey(BEAT_USER)
// Queue a job before each poll so BRPOP returns at once instead of blocking.
await queue.submitJob('claude-code', [{ role: 'user', content: 'beat one' }], BEAT_USER)
fake.reset()
await workNext(pollReq(beatKey))
t('a first poll marks presence', (fake.counts.get('ZADD') ?? 0) === 1, String(fake.counts.get('ZADD')))
await queue.submitJob('claude-code', [{ role: 'user', content: 'beat two' }], BEAT_USER)
const secondPoll = await workNext(pollReq(beatKey))
t('an immediate second poll does not pay for it again', (fake.counts.get('ZADD') ?? 0) === 1, String(fake.counts.get('ZADD')))
t('the second poll still returned its job', secondPoll.status === 200, String(secondPoll.status))

console.log('\nupstash — a backend outage degrades cleanly (the #55 guard, now covered)')
const key = await issueKey('outage_user')
fake.failNext(20)
const outage = await workNext(new Request('https://x/api/work/next', {
  method: 'POST', headers: { authorization: `Bearer ${key}` },
}))
t('an Upstash outage returns 503, not a bare platform error', outage.status === 503, `status=${outage.status}`)
const outageBody = await outage.json()
t('the outage body is a JSON error envelope', typeof outageBody?.error?.message === 'string')
t('the outage response still carries the CORS envelope', (outage.headers.get('vary') ?? '').includes('origin'))

console.log('\nupstash — /api/health does not hand out free queue reads')
const health = (await import('../api/health.ts')).default
// The outage above armed more failures than it consumed. Clear them.
fake.failNext(0)
// First health call of the process, so the cache is cold and this is a real read.
fake.reset()
const h1 = await health(new Request('https://x/api/health'))
const h1Body = await h1.json()
t('health reports a live supporter count', typeof h1Body.supporters_online === 'number', String(h1Body.supporters_online))
t('a cold health read costs a single count', fake.total() === 1, `${fake.total()}`)
for (let i = 0; i < 5; i++) await health(new Request('https://x/api/health'))
t('five more hits inside the cache window cost nothing', fake.total() === 1, `${fake.total()}`)

// Let the cache lapse, then take the queue away underneath it.
await new Promise((r) => setTimeout(r, 5100))
fake.failNext(20)
const h2 = await health(new Request('https://x/api/health'))
const h2Body = await h2.json()
t('health still answers 200 while the queue is down', h2.status === 200, `status=${h2.status}`)
t('health reports the unreadable count as null instead of throwing', h2Body.supporters_online === null, String(h2Body.supporters_online))
t('health still reports the rest of the service', h2Body.ok === true && h2Body.queue === 'upstash')

// docs.js and app.js both explain the status poll interval by naming what a
// poll costs. That number is load-bearing (it is the argument for a 10s poll
// against a 500K monthly budget) and it went stale silently when the count
// dropped from three to two. Measure it, and hold the docs to the measurement.
console.log('%supstash - the documented poll cost is the real poll cost', String.fromCharCode(10))
{
  const { readFileSync } = await import('node:fs')
  const statusKey = await issueKey('poll_cost_probe')
  const status = (await import('../api/work/status.ts')).default
  // Earlier blocks arm fake.failNext to exercise the outage guards; clear it so
  // a leftover queued failure does not answer for this one.
  fake.failNext(0)
  fake.reset()
  const res = await status(new Request('https://x/api/work/status', { headers: { authorization: `Bearer ${statusKey}` } }))
  const cost = fake.total()
  t('a status poll answers', res.status === 200, `status=${res.status}`)
  t('and it costs a small, known number of commands', cost > 0 && cost <= 4,
    `${cost} commands: ${[...fake.counts].map(([k, v]) => k + '=' + v).join(' ')}`)
  const words: Record<number, string> = { 1: 'one', 2: 'two', 3: 'three', 4: 'four' }
  for (const f of ['docs.js', 'app.js']) {
    const src = readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8')
    const claim = /each poll is (one|two|three|four) Upstash commands/i.exec(src)
    if (!claim) continue
    t(`public/${f} states the measured cost`, claim[1] === words[cost], `says ${claim[1]}, measured ${words[cost]}`)
  }
}

await fake.close()
console.log(failed === 0 ? '\nupstash: all checks passed' : `\nupstash: ${failed} check(s) FAILED`)
process.exit(failed === 0 ? 0 : 1)
