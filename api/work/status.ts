// Is a supporter node live for this key right now?
//
// The homepage polls this in supporter mode so it can light up "connected" the
// moment the pasted worker loop starts hitting /api/work/next. Presence is keyed
// by the Relaybee user id in the bearer key, so a caller only ever sees the status
// of its own node — no cross-user visibility.

import { verifyKey, bearer } from '../../lib/auth'
import { isLive, countLive } from '../../lib/queue'
import { check, clientIp, rlHeaders } from '../../lib/ratelimit'

export const config = { runtime: 'edge' }

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-expose-headers': 'x-ratelimit-limit, x-ratelimit-remaining, x-ratelimit-reset',
}

// The page polls every 10s, so it needs 6 a minute. 60 was ten times that, and
// at 2 Upstash commands a poll one scripted source obeying the limit exactly
// could spend 172,800 commands a day against a 500K monthly budget: enough to
// take the relay offline for the rest of the month without breaking a rule.
// 15 is still more than double what any real page asks for.
const IP_STATUS_LIMIT = 15

// The global count is the same answer for everybody, so one instance need not
// buy it twice in a row. Presence has a 45s TTL, so a few seconds of staleness
// costs no accuracy the data could have expressed anyway. /api/health already
// does exactly this for the same read.
const COUNT_CACHE_MS = 5_000
let cachedCount: { at: number; value: number } | null = null

async function onlineCount(): Promise<number> {
  if (cachedCount && Date.now() - cachedCount.at < COUNT_CACHE_MS) return cachedCount.value
  const value = await countLive()
  cachedCount = { at: Date.now(), value }
  return value
}

// `connected` is this key's own node, so unlike /api/health this answer must
// never land in a shared cache where another caller could be served it.
const CACHE_CONTROL = 'private, no-store'

function json(status: number, obj: unknown, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': CACHE_CONTROL, ...CORS, ...extra },
  })
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
  if (req.method !== 'GET') return json(405, { error: { message: 'Use GET.' } })

  const auth = await verifyKey(bearer(req))
  if (!auth) return json(401, { error: { message: 'Missing or invalid Relaybee API key.', type: 'authentication_error' } })
  const rl = check(`status:${clientIp(req)}`, IP_STATUS_LIMIT)
  const rlh = rlHeaders(rl)
  if (!rl.ok) {
    return json(429, { error: { message: 'Polling status too fast.', type: 'rate_limit_error' } }, rlh)
  }

  let connected: boolean, online: number
  try {
    [connected, online] = await Promise.all([isLive(auth.u), onlineCount()])
  } catch {
    return json(503, { error: { message: 'Relay queue is temporarily unavailable.', type: 'server_error' } }, rlh)
  }
  return json(200, { connected, online }, rlh)
}
