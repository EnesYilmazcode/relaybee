// Per-instance sliding-window limiter.
//
// This is deliberately not distributed. Relaybee has no datastore, so the counter
// lives in module scope on whatever warm edge instance served the request — a
// user spread across regions gets roughly N-regions times the limit, and a cold
// start resets to zero. That is sufficient for the service quotas most limits
// here protect. The public-pool throttle below is explicitly best effort and
// cannot bound provider spend across instances. Use Upstash if that must be exact.

type Window = { count: number; resetAt: number }

const buckets = new Map<string, Window>()
const WINDOW_MS = 60_000

export type Verdict = { ok: boolean; limit: number; remaining: number; resetAt: number }

/**
 * The rate-limit response headers for a Verdict. Every Relaybee endpoint returns
 * the same envelope so a cross-origin worker sees identical fields everywhere;
 * keeping this in one place stops the four copies from drifting.
 */
export function rlHeaders(rl: Verdict): Record<string, string> {
  return {
    'x-ratelimit-limit': String(rl.limit),
    'x-ratelimit-remaining': String(rl.remaining),
    'x-ratelimit-reset': String(Math.ceil(rl.resetAt / 1000)),
  }
}

/**
 * @param cost how many units this request consumes. One request is not always
 * one unit of work: a proxy call that walks an 8-connection pool makes eight
 * upstream requests, and metering it as one is what made batch key-testing
 * cheap. Charging what a request actually costs prices that at its real rate
 * without taking failover away from anyone using it honestly.
 */
export function check(userId: string, limit: number, cost = 1): Verdict {
  const now = Date.now()
  let w = buckets.get(userId)

  if (!w || w.resetAt <= now) {
    w = { count: 0, resetAt: now + WINDOW_MS }
    buckets.set(userId, w)
  }

  // Opportunistic sweep so an instance that has seen many users doesn't grow
  // without bound. Cheap because it only runs on bucket creation.
  if (buckets.size > 5_000) {
    for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k)
  }

  w.count += cost
  const remaining = Math.max(0, limit - w.count)
  return { ok: w.count <= limit, limit, remaining, resetAt: w.resetAt }
}

// One tier, because there has only ever been one. `pro` sat here for months with
// no code path able to mint a key carrying it, so the number was unreachable and
// read as a capability the service did not have. Adding a tier back is a two-line
// change on the day something actually issues one.
export const LIMITS: Record<string, number> = { free: 20 }

/**
 * Public-pool submissions, per warm instance, per key and source, per minute.
 *
 * `LIMITS.free` meters a caller against Relaybee's own invocation quota. This
 * meters them against a *volunteer's* API bill, which is a different budget and
 * a far smaller one, so it cannot be the same number. A node answers serially
 * and measured answers ran 4s to 283s, so repeated submissions can oversubscribe
 * a supporter by an order of magnitude on one warm instance.
 *
 * Four still exceeds what one node can work through in a minute, so it does not
 * constrain honest use. It reduces burst monopolisation on the same instance,
 * but cold starts and other edge instances have separate counters, so it is not
 * a global fairness or spend bound. Node-side limits remain the only ceiling on
 * a volunteer's total.
 */
export const PUBLIC_POOL_LIMIT = 4

/**
 * Best-effort client IP, for limits that must survive key rotation.
 *
 * Metering on user id alone is bypassable here: /api/keys/issue is unauthenticated
 * and free, so anyone can mint a fresh key — and therefore a fresh bucket — as often
 * as they like. An IP dimension makes rotation pointless for a single source. It is
 * not a real defence against a distributed caller, and it is not meant to be; it
 * closes the trivial bypass, nothing more.
 */
export function clientIp(req: Request): string {
  // Order matters, and the old order had it backwards.
  //
  // x-forwarded-for is a list a client can start: send your own header and the
  // proxy appends to it, so the FIRST entry is whatever the caller wrote. Taking
  // it meant every per-IP limit here could be reset by changing one header.
  // Vercel's own headers are set by the platform and cannot be spoofed from
  // outside, so they come first, and the fallback reads the LAST entry of the
  // list, which is the hop closest to us rather than the one furthest away.
  const vercel = req.headers.get('x-vercel-forwarded-for')
  if (vercel) return vercel.split(',').pop()!.trim()
  const real = req.headers.get('x-real-ip')
  if (real) return real.trim()
  const fwd = req.headers.get('x-forwarded-for')
  if (fwd) return fwd.split(',').pop()!.trim()
  return 'unknown'
}

/** Key minting is cheap for us but should not be free to automate. */
export const IP_ISSUE_LIMIT = 10
/** Ceiling per source IP across all keys it holds. */
export const IP_PROXY_LIMIT = 60
