// Incremental supporter delivery. A worker sends small text deltas as the
// provider produces them, followed by one done frame carrying final usage.
// /api/work/complete remains the backwards-compatible one-shot path.

import { verifyKey, bearer } from '../../lib/auth'
import { appendResultDelta, finishResultStream, failResultStream, checkTicket } from '../../lib/queue'
import { readUsage } from './complete'
import { check, clientIp, rlHeaders } from '../../lib/ratelimit'
import { corsFor } from '../../lib/cors'

export const config = { runtime: 'edge' }

const CORS_BASE = {
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-expose-headers': 'x-ratelimit-limit, x-ratelimit-remaining, x-ratelimit-reset',
}
const MAX_DELTA_BYTES = 16 * 1024
const MAX_ERROR_BYTES = 4 * 1024
const IP_STREAM_LIMIT = 300
const cors = (req: Request) => corsFor(req, CORS_BASE)
const jsonFor = (req: Request) => (status: number, obj: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...cors(req), ...extra } })

export default async function handler(req: Request): Promise<Response> {
  const json = jsonFor(req)
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) })
  if (req.method !== 'POST') return json(405, { error: { message: 'Use POST.' } })

  const auth = await verifyKey(bearer(req))
  if (!auth) return json(401, { error: { message: 'Missing or invalid Relaybee API key.', type: 'authentication_error' } })
  const rl = check(`stream:${clientIp(req)}`, IP_STREAM_LIMIT)
  const rlh = rlHeaders(rl)
  if (!rl.ok) return json(429, { error: { message: 'Too many answer frames.', type: 'rate_limit_error' } }, rlh)

  let body: { id?: unknown; ticket?: unknown; delta?: unknown; done?: unknown; error?: unknown; usage?: unknown }
  try { body = (await req.json()) as typeof body }
  catch { return json(400, { error: { message: 'Request body must be valid JSON.' } }, rlh) }

  const id = typeof body.id === 'string' ? body.id : ''
  const ticket = typeof body.ticket === 'string' ? body.ticket : ''
  if (!/^[0-9a-f-]{36}$/.test(id)) return json(400, { error: { message: 'Field "id" must be the job id from /api/work/next.' } }, rlh)
  if (!ticket) return json(400, { error: { message: 'Field "ticket" is required.' } }, rlh)
  if (!(await checkTicket(id, auth.u, ticket))) {
    return json(403, { error: { message: 'That ticket was not issued to this key for this job.', type: 'permission_error' } }, rlh)
  }

  const isDone = body.done === true
  const delta = typeof body.delta === 'string' ? body.delta : null
  const streamError = typeof body.error === 'string' ? body.error : null
  if (Number(delta !== null) + Number(isDone) + Number(streamError !== null) !== 1) {
    return json(400, { error: { message: 'Send exactly one of a text "delta", "done": true, or text "error".' } }, rlh)
  }
  if (delta !== null && (delta.length === 0 || new TextEncoder().encode(delta).length > MAX_DELTA_BYTES)) {
    return json(400, { error: { message: `Field "delta" must be 1-${MAX_DELTA_BYTES / 1024}KB.` } }, rlh)
  }
  if (streamError !== null && (streamError.length === 0 || new TextEncoder().encode(streamError).length > MAX_ERROR_BYTES)) {
    return json(400, { error: { message: `Field "error" must be 1-${MAX_ERROR_BYTES / 1024}KB.` } }, rlh)
  }

  try {
    if (delta !== null) await appendResultDelta(id, delta)
    else if (streamError !== null) await failResultStream(id, streamError)
    else await finishResultStream(id, readUsage(body.usage))
  } catch {
    return json(503, { error: { message: 'Relay queue is temporarily unavailable.', type: 'server_error' } }, rlh)
  }
  return json(202, { ok: true }, rlh)
}
