// Supporter side of the relay: deliver an answer for a job taken from /api/work/next.
//
// Delivery needs the ticket /api/work/next issued with the job, not just the job
// id. The id alone was never proof of anything: it is unguessable, which stops
// someone inventing one, but this endpoint accepted any well-formed uuid from
// any key, and the gateway hands the id straight back to the caller as
// `chatcmpl-<id>`. So an id that leaked once was a licence to write that
// caller's answer for as long as the job lived.
//
// The ticket is an HMAC over the job id and the popping node's user id, checked
// by recomputing it against the key presenting it. No storage, no extra queue
// command, and it cannot be replayed by a different key.

import { verifyKey, bearer } from '../../lib/auth'
import { completeJob, checkTicket, type Usage } from '../../lib/queue'
import { check, clientIp, rlHeaders } from '../../lib/ratelimit'
import { corsFor } from '../../lib/cors'

export const config = { runtime: 'edge' }

const cors = (req: Request) => corsFor(req, CORS_BASE)

const CORS_BASE = {
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-expose-headers': 'x-ratelimit-limit, x-ratelimit-remaining, x-ratelimit-reset',
}

const MAX_ANSWER_BYTES = 64 * 1024
const IP_COMPLETE_LIMIT = 30

const jsonFor = (req: Request) => (status: number, obj: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(obj), {
    status, headers: { 'content-type': 'application/json', ...cors(req), ...extra },
  })

/**
 * A node's self-reported cost for the job it just answered.
 *
 * The relay never sees the model call, so these numbers can only come from the
 * node and cannot be checked here. That makes them untrusted input in the
 * ordinary sense: a nonsense value must not reach the caller's usage block and
 * must not turn a delivered answer into an error, since the answer is the part
 * that matters. So anything that is not three sane finite numbers is dropped
 * and the answer goes through without a usage block, exactly as before.
 */
function readUsage(raw: unknown): Usage | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const u = raw as Record<string, unknown>
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)
  const inputTokens = num(u.input_tokens)
  const outputTokens = num(u.output_tokens)
  const costUsd = num(u.cost_usd)
  if (inputTokens === null || outputTokens === null || costUsd === null) return undefined
  // A ceiling so a node cannot report a number that reads as a bill. The relay
  // caps a job's messages at 32KB and an answer at 64KB, so real counts are
  // small and anything past this is a bug or a joke either way.
  if (inputTokens > 10_000_000 || outputTokens > 10_000_000 || costUsd > 1_000) return undefined
  return { inputTokens, outputTokens, costUsd }
}

export default async function handler(req: Request): Promise<Response> {
  const json = jsonFor(req)
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) })
  if (req.method !== 'POST') return json(405, { error: { message: 'Use POST.' } })

  const auth = await verifyKey(bearer(req))
  if (!auth) return json(401, { error: { message: 'Missing or invalid Relaybee API key.', type: 'authentication_error' } })
  const rl = check(`complete:${clientIp(req)}`, IP_COMPLETE_LIMIT)
  const rlh = rlHeaders(rl)
  if (!rl.ok) {
    return json(429, { error: { message: 'Rate limit exceeded.', type: 'rate_limit_error' } }, rlh)
  }

  let body: { id?: string; ticket?: string; text?: string; usage?: unknown }
  try {
    body = (await req.json()) as typeof body
  } catch {
    return json(400, { error: { message: 'Request body must be valid JSON.' } }, rlh)
  }

  const id = body.id ?? ''
  const text = body.text ?? ''
  if (!/^[0-9a-f-]{36}$/.test(id)) return json(400, { error: { message: 'Field "id" must be the job id from /api/work/next.' } }, rlh)
  const ticket = typeof body.ticket === 'string' ? body.ticket : ''
  if (!ticket) {
    return json(400, { error: { message: 'Field "ticket" is required. Send back the ticket /api/work/next returned with this job.' } }, rlh)
  }
  // 403, not 404: the job may well exist. What is missing is the proof that this
  // key is the one that took it, and saying so is more useful than pretending
  // the job is gone.
  if (!(await checkTicket(id, auth.u, ticket))) {
    return json(403, { error: { message: 'That ticket was not issued to this key for this job.', type: 'permission_error' } }, rlh)
  }
  if (!text) return json(400, { error: { message: 'Field "text" is required.' } }, rlh)
  if (new TextEncoder().encode(text).length > MAX_ANSWER_BYTES) {
    return json(400, { error: { message: `Answer too large: cap is ${MAX_ANSWER_BYTES / 1024}KB.` } }, rlh)
  }

  try {
    await completeJob(id, text, readUsage(body.usage))
  } catch {
    return json(503, { error: { message: 'Relay queue is temporarily unavailable.', type: 'server_error' } }, rlh)
  }
  return json(200, { ok: true }, rlh)
}
