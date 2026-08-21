import { bytesToB64u, enc } from './b64'

// Work relay queue: users' chat requests go in, supporters' answers come out.
//
// Storage is Upstash Redis (REST) when UPSTASH_REDIS_REST_URL/TOKEN are set,
// otherwise a per-instance in-memory fallback. The fallback lives on one warm
// edge instance, so a user and a supporter only meet if they land on the same
// instance. Good enough for a single-region demo and for tests; set Upstash to
// make it real.

export type Job = {
  id: string
  model: string
  messages: Array<{ role: string; content: string }>
  queuedAt: number
}

/**
 * What a job cost the supporter who answered it.
 *
 * Reported by the node, because that is the only place the numbers exist: the
 * relay never sees the model call. So it is the node's own accounting and not
 * something this side can verify. Absent when a node does not report it.
 */
export type Usage = {
  inputTokens: number
  outputTokens: number
  costUsd: number
}

export type Result = { text: string; usage?: Usage }

const RESULT_TTL_S = 120
const NODES_KEY = 'relaybee:nodes'

// One queue per requester, plus one opt-in pool.
//
// There used to be a single global list. Anyone could mint a free key at the
// unauthenticated /api/keys/issue and then long-poll it, which meant a stranger
// could drain every caller's prompts in plaintext and hand back an answer of
// their choosing. Neither half of that needed a bug: it was what the design
// said to do.
//
// So a job goes to its requester's own queue and only a node holding that same
// key can take it, which is the "personal capacity router" this project's design
// review already settled on. Answering for strangers still exists, but it is now
// something both sides opt into by name rather than the default nobody chose.
const ownQueue = (userId: string) => `relaybee:jobs:u:${userId}`
const PUBLIC_QUEUE = 'relaybee:jobs:public'

export type Pool = 'own' | 'public'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// A supporter node counts as "connected" for this long after its last poll.
// Comfortably longer than one poll window so a node between long-polls doesn't
// flicker offline.
const PRESENCE_TTL_S = 45

// Hard caps so an idle or attacked queue can't grow without bound. A job is
// ~32KB max; 200 is a generous ceiling for a demo and self-heals as work drains.
const MAX_QUEUE = 200
const JOB_MAX_AGE_MS = 60_000

interface Store {
  push(queue: string, job: Job): Promise<void>
  /** Take a queued job back out. No-op if a supporter already popped it. */
  remove(queue: string, job: Job): Promise<void>
  /** Block on every listed queue at once until a job arrives or maxWaitMs elapses. */
  waitPop(queues: string[], maxWaitMs: number): Promise<Job | null>
  setResult(id: string, result: Result): Promise<void>
  /** Block until this job's answer arrives or maxWaitMs elapses. */
  waitResult(id: string, maxWaitMs: number): Promise<Result | null>
  markPresence(userId: string): Promise<void>
  isPresent(userId: string): Promise<boolean>
  countPresent(): Promise<number>
}

function upstashStore(url: string, token: string): Store {
  const cmd = async (parts: Array<string | number>) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(parts),
    })
    if (!res.ok) throw new Error(`queue backend error ${res.status}`)
    return ((await res.json()) as { result: unknown }).result
  }
  return {
    push: async (queue, job) => {
      await cmd(['LPUSH', queue, JSON.stringify(job)])
      // Keep only the newest MAX_QUEUE (LPUSH prepends, BRPOP drains the tail).
      await cmd(['LTRIM', queue, 0, MAX_QUEUE - 1])
      // Without this a queue for a user who never runs a node lives forever.
      // Jobs already expire by age on the way out; this stops the key itself
      // accumulating, one command on a path that already costs two.
      await cmd(['EXPIRE', queue, Math.ceil(JOB_MAX_AGE_MS / 1000) * 2])
    },
    // The value is byte-identical to what push serialised, since it is the same
    // object. If a supporter popped it a moment ago this removes nothing, which
    // is the correct outcome.
    remove: async (queue, job) => { await cmd(['LREM', queue, 1, JSON.stringify(job)]) },
    // BRPOP blocks server-side, so an idle poll is one Redis command instead of
    // ~20 RPOP+sleep round-trips. The 15s cap is why api/work/next polls for 15s
    // and not 20: a longer window would need a second BRPOP to cover the tail,
    // and this is the only cost the project pays continuously. With the throttled
    // heartbeat that is about 6 commands a minute per idle supporter, roughly
    // 259K a month, against a 500K free tier. Two supporters do not fit.
    // BRPOP takes several keys and still costs one command, so a node that has
    // opted into the public pool watches both its own queue and that pool for
    // the same price as watching one.
    waitPop: async (queues, maxWaitMs) => {
      const deadline = Date.now() + maxWaitMs
      while (true) {
        const remaining = deadline - Date.now()
        if (remaining <= 0) return null
        const timeoutS = Math.max(1, Math.min(15, Math.ceil(remaining / 1000)))
        const res = (await cmd(['BRPOP', ...queues, timeoutS])) as [string, string] | null
        if (!res || !res[1]) continue
        const job = JSON.parse(res[1]) as Job
        // Drop jobs older than the memory store would have trimmed. Without this,
        // a queue that filled while no supporter was online feeds the first node
        // to connect a backlog of prompts whose callers already gave up — real
        // LLM quota spent answering dead requests. Keep looping within the poll
        // deadline until a live job or a timeout.
        if (Date.now() - job.queuedAt > JOB_MAX_AGE_MS) continue
        return job
      }
    },
    // The answer is a one-element list rather than a plain string so the waiting
    // caller can BRPOP it instead of polling GET twice a second.
    setResult: async (id, result) => {
      await cmd(['LPUSH', `relaybee:result:${id}`, JSON.stringify(result)])
      await cmd(['EXPIRE', `relaybee:result:${id}`, RESULT_TTL_S])
    },
    // Same trick as waitPop, on the other side of the relay: one blocking command
    // per 15s of waiting instead of two GETs a second. That is what makes a long
    // wait affordable, and a long wait is what real answers need.
    waitResult: async (id, maxWaitMs) => {
      const key = `relaybee:result:${id}`
      const deadline = Date.now() + maxWaitMs
      while (true) {
        const remaining = deadline - Date.now()
        if (remaining <= 0) return null
        const timeoutS = Math.max(1, Math.min(15, Math.ceil(remaining / 1000)))
        const res = (await cmd(['BRPOP', key, timeoutS])) as [string, string] | null
        if (res && res[1]) return decodeResult(res[1])
      }
    },
    // One command per poll, and a sweep only on the poll that grows the set.
    // ZADD returns 1 for a member the set did not already have, which is the
    // only way it gets bigger, so this ties the cleanup rate to the mess rate.
    // A counter would not: it lives in one warm instance, and a poll landing on
    // a cold one restarts it, so the degenerate case never sweeps at all.
    markPresence: async (userId) => {
      // Number(), not a strict compare: cmd returns unknown, so this has no
      // type-level protection, and coercing means a stringified reply cannot
      // silently disable the sweep forever.
      const added = await cmd(['ZADD', NODES_KEY, Date.now(), userId])
      if (Number(added) !== 1) return
      // Swallowed on purpose: the count never depended on the sweep landing, so
      // a failed one must not turn a supporter's poll into a 503.
      await cmd(['ZREMRANGEBYSCORE', NODES_KEY, 0, Date.now() - PRESENCE_TTL_S * 1000]).catch(() => {})
    },
    isPresent: async (userId) => {
      const score = (await cmd(['ZSCORE', NODES_KEY, userId])) as string | null
      return score !== null && Date.now() - Number(score) <= PRESENCE_TTL_S * 1000
    },
    // ZCOUNT answers straight from the score range, so an expired node is
    // already excluded whether or not anything deleted it.
    countPresent: async () => {
      const cutoff = Date.now() - PRESENCE_TTL_S * 1000
      return ((await cmd(['ZCOUNT', NODES_KEY, cutoff, '+inf'])) as number) ?? 0
    },
  }
}

function memoryStore(): Store {
  const queues = new Map<string, Job[]>()
  const listOf = (q: string) => {
    let l = queues.get(q)
    if (!l) { l = []; queues.set(q, l) }
    return l
  }
  const results = new Map<string, { result: Result; at: number }>()
  const presence = new Map<string, number>()

  const trimJobs = (jobs: Job[]) => {
    const cutoff = Date.now() - JOB_MAX_AGE_MS
    while (jobs.length && jobs[0].queuedAt < cutoff) jobs.shift()
    if (jobs.length > MAX_QUEUE) jobs.splice(0, jobs.length - MAX_QUEUE)
    // Drop an emptied queue so a process that has served many users does not
    // keep one empty array per user id forever.
    return jobs
  }

  return {
    push: async (queue, job) => { trimJobs(listOf(queue)).push(job) },
    remove: async (queue, job) => {
      const jobs = listOf(queue)
      const i = jobs.findIndex((j) => j.id === job.id)
      if (i >= 0) jobs.splice(i, 1)
      if (jobs.length === 0) queues.delete(queue)
    },
    waitPop: async (queues_, maxWaitMs) => {
      const deadline = Date.now() + maxWaitMs
      while (true) {
        for (const q of queues_) {
          const job = trimJobs(listOf(q)).shift()
          if (job) return job
          if (listOf(q).length === 0) queues.delete(q)
        }
        if (Date.now() >= deadline) return null
        await sleep(500)
      }
    },
    setResult: async (id, result) => {
      const now = Date.now()
      // Opportunistic sweep so read-once and orphaned answers don't accumulate.
      if (results.size > 500) {
        for (const [k, v] of results) if (now - v.at > RESULT_TTL_S * 1000) results.delete(k)
      }
      results.set(id, { result, at: now })
    },
    // In-process, so polling costs nothing. Reads once, matching BRPOP.
    waitResult: async (id, maxWaitMs) => {
      const deadline = Date.now() + maxWaitMs
      while (true) {
        const r = results.get(id)
        if (r) {
          results.delete(id)
          if (Date.now() - r.at <= RESULT_TTL_S * 1000) return r.result
        }
        if (Date.now() >= deadline) return null
        await sleep(100)
      }
    },
    markPresence: async (userId) => { presence.set(userId, Date.now()) },
    isPresent: async (userId) => {
      const at = presence.get(userId)
      if (at === undefined) return false
      if (Date.now() - at > PRESENCE_TTL_S * 1000) { presence.delete(userId); return false }
      return true
    },
    countPresent: async () => {
      const cutoff = Date.now() - PRESENCE_TTL_S * 1000
      let n = 0
      for (const [k, at] of presence) {
        if (at <= cutoff) presence.delete(k)
        else n++
      }
      return n
    },
  }
}

// One imported key per process, same shape as lib/auth.ts. Keyed by the secret
// so a rotated MASTER_SECRET is picked up rather than served from a warm cache.
let ticketKey: { secret: string; key: CryptoKey } | null = null

async function signTicket(jobId: string, supporter: string): Promise<string> {
  const secret = process.env.MASTER_SECRET
  if (!secret) throw new Error('MASTER_SECRET is not set')
  if (!ticketKey || ticketKey.secret !== secret) {
    ticketKey = {
      secret,
      key: await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
    }
  }
  // The separator cannot appear in a uuid, so no two (jobId, supporter) pairs
  // can produce the same signed string.
  const sig = await crypto.subtle.sign('HMAC', ticketKey.key, enc.encode(`${jobId}:${supporter}`))
  return bytesToB64u(new Uint8Array(sig))
}

const url = process.env.UPSTASH_REDIS_REST_URL
const token = process.env.UPSTASH_REDIS_REST_TOKEN
export const QUEUE_DISTRIBUTED = Boolean(url && token)
const store: Store = QUEUE_DISTRIBUTED ? upstashStore(url!, token!) : memoryStore()

/**
 * Queue a job for whoever can serve it.
 *
 * The job body still carries only model and flattened messages: no user id, no
 * IP, nothing to correlate. The requester's identity is in the queue NAME, which
 * the supporter never sees, so routing became private without the payload
 * learning anything new about the caller.
 */
export async function submitJob(
  model: string,
  messages: Job['messages'],
  owner: string,
  pool: Pool = 'own',
): Promise<Job> {
  const job: Job = { id: crypto.randomUUID(), model, messages, queuedAt: Date.now() }
  await store.push(pool === 'public' ? PUBLIC_QUEUE : ownQueue(owner), job)
  return job
}

/**
 * Withdraw a job whose caller has stopped waiting.
 *
 * The age trim cannot cover this. A job abandoned after 15s still looks fresh
 * for another 45, so without this the next supporter to connect spends real
 * model time answering a prompt nobody will read, and is not available for the
 * request that does have someone waiting. Observed in production, not theorised.
 */
export async function cancelJob(job: Job, owner: string, pool: Pool = 'own'): Promise<void> {
  await store.remove(pool === 'public' ? PUBLIC_QUEUE : ownQueue(owner), job)
}

/**
 * Long-poll for work on behalf of a supporter. Resolves null when nothing shows up.
 *
 * A node always watches its own queue: jobs submitted under the same key it
 * holds. Watching the public pool as well is opt-in, because taking a stranger's
 * job means reading a stranger's prompt and having them read whatever you send
 * back, and that is a thing to agree to rather than inherit.
 */
export async function nextJob(maxWaitMs: number, supporter: string, includePublic = false): Promise<Job | null> {
  const queues = [ownQueue(supporter)]
  if (includePublic) queues.push(PUBLIC_QUEUE)
  return store.waitPop(queues, maxWaitMs)
}

/**
 * Proof that this node is the one that took this job.
 *
 * The job id alone never was proof. It is unguessable, which stops someone
 * inventing one, but /api/work/complete accepted any well-formed uuid from any
 * key, so an id that leaked once was a licence to write that caller's answer for
 * as long as the job lived. The gateway also hands the raw id straight back to
 * the caller as `chatcmpl-<id>`, so it leaks by design.
 *
 * A ticket is an HMAC over the job id and the popping node's user id under the
 * same MASTER_SECRET that signs API keys. It is verified by recomputing, so this
 * costs no storage and no extra Redis command, and it cannot be replayed by a
 * different key because the key's own user id is inside the signature.
 */
export async function issueTicket(jobId: string, supporter: string): Promise<string> {
  return signTicket(jobId, supporter)
}

/** True only if this ticket was issued for this job to this supporter. */
export async function checkTicket(jobId: string, supporter: string, ticket: string): Promise<boolean> {
  if (!ticket) return false
  const expected = await signTicket(jobId, supporter)
  // Both sides are our own base64url of a fixed-length HMAC, so lengths match
  // for every real ticket and a constant-time compare is meaningful.
  if (expected.length !== ticket.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ ticket.charCodeAt(i)
  return diff === 0
}

/** Record that a supporter node is alive right now, keyed by its Relaybee user id. */
export async function markLive(userId: string): Promise<void> {
  await store.markPresence(userId)
}

/** Is a supporter node currently polling under this user id? */
export async function isLive(userId: string): Promise<boolean> {
  return store.isPresent(userId)
}

/** How many supporter nodes are live right now, across everyone. */
export async function countLive(): Promise<number> {
  return store.countPresent()
}

/**
 * The job id is the capability: it is an unguessable UUID handed only to the
 * supporter who popped the job, so holding it is proof of assignment.
 */
export async function completeJob(id: string, text: string, usage?: Usage): Promise<void> {
  await store.setResult(id, usage ? { text, usage } : { text })
}

/** Wait for a supporter's answer on behalf of the requesting user. */
export async function awaitResult(id: string, maxWaitMs: number): Promise<Result | null> {
  return store.waitResult(id, maxWaitMs)
}

/**
 * Read a stored answer back.
 *
 * Answers live for RESULT_TTL_S, so a deploy that changes this format leaves a
 * two-minute window where the queue still holds values the previous one wrote,
 * and those are bare answer strings. Reading one as text costs nothing; losing
 * it to a parse error costs a caller their whole wait.
 */
function decodeResult(raw: string): Result {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && typeof (parsed as Result).text === 'string') {
      return parsed as Result
    }
  } catch { /* not JSON, so it is a pre-envelope answer */ }
  return { text: raw }
}
