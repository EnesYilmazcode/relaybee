// Seal a provider credential into a client-held connection blob.
//
// The plaintext key exists only for the duration of this request. We encrypt it,
// return the blob, and forget it — there is nothing on our side to leak later.

import { verifyKey, bearer } from '../lib/auth'
import { seal } from '../lib/seal'
import { ADAPTERS } from '../lib/providers'
import { hasSecrets, NOT_CONFIGURED } from '../lib/config'
import { check, clientIp, rlHeaders } from '../lib/ratelimit'

export const config = { runtime: 'edge' }

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'POST, OPTIONS',
}

function json(status: number, obj: unknown, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', ...CORS, ...extra },
  })
}

// Sealing runs AES-256-GCM over a body this endpoint never bounded, on the only
// authenticated route with no meter on it at all. Every other one has both.
// Sealing is a client-side setup step measured in single digits per user, so the
// ceiling can be low without any real caller noticing.
const IP_CONNECT_LIMIT = 20
const MAX_CONNECT_BYTES = 8 * 1024

export default async function handler(req: Request): Promise<Response> {
  try {
    return await handleConnect(req)
  } catch {
    // Last line of defence: anything unforeseen becomes a clean JSON envelope
    // with CORS, never a bare platform error page.
    return json(500, { error: { message: 'Internal error sealing the connection.', type: 'api_error' } })
  }
}

async function handleConnect(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
  if (req.method !== 'POST') return json(405, { error: { message: 'Use POST.' } })

  // Verifying the key needs MASTER_SECRET; sealing the blob needs
  // MASTER_ENCRYPTION_KEY. Missing either would throw mid-operation — return a
  // clean 503 up front instead.
  if (!hasSecrets('MASTER_SECRET', 'MASTER_ENCRYPTION_KEY')) {
    return json(503, { error: { message: NOT_CONFIGURED, type: 'api_error' } })
  }

  const auth = await verifyKey(bearer(req))
  if (!auth) {
    return json(401, { error: { message: 'Missing or invalid Relaybee API key.', type: 'authentication_error' } })
  }

  const rl = check(`connect:${clientIp(req)}`, IP_CONNECT_LIMIT)
  const rlh = rlHeaders(rl)
  if (!rl.ok) {
    return json(429, { error: { message: 'Too many connections sealed from this source. Try again shortly.', type: 'rate_limit_error' } }, rlh)
  }

  // Bound the body before decoding it, in real bytes rather than JS string
  // length. A credential plus a label is a few hundred bytes.
  const raw = await req.arrayBuffer().catch(() => null)
  if (!raw) return json(400, { error: { message: 'Could not read the request body.' } }, rlh)
  if (raw.byteLength > MAX_CONNECT_BYTES) {
    return json(400, { error: { message: `Request body too large: cap is ${MAX_CONNECT_BYTES / 1024}KB.` } }, rlh)
  }

  let payload: { provider?: string; apiKey?: string; api_key?: string; label?: string }
  try {
    payload = JSON.parse(new TextDecoder().decode(raw)) as typeof payload
  } catch {
    return json(400, { error: { message: 'Request body must be valid JSON.' } }, rlh)
  }

  const provider = (payload.provider ?? '').toLowerCase()
  const apiKey = payload.apiKey ?? payload.api_key ?? ''

  // hasOwn, not a truthy index: a plain object answers for "constructor" and
  // "__proto__" too, so the bare lookup sealed a blob for a provider that does
  // not exist and reported success for it.
  if (!Object.hasOwn(ADAPTERS, provider)) {
    return json(400, {
      error: { message: `Unknown provider "${provider}". Supported: ${Object.keys(ADAPTERS).join(', ')}.` },
    }, rlh)
  }
  if (!apiKey || apiKey.length < 8) {
    return json(400, { error: { message: 'Field "apiKey" is required.' } }, rlh)
  }

  // The label is echoed back in the x-relaybee-connection-label response header,
  // so control characters here would be a header-injection vector. Strip to
  // printable ASCII at the point of sealing rather than trusting the read path.
  const label = (payload.label ?? '').replace(/[^\x20-\x7E]/g, '').slice(0, 40)

  const blob = await seal({
    provider,
    apiKey,
    owner: auth.u,
    createdAt: Date.now(),
    label: label || undefined,
  })

  return json(200, {
    connection: blob,
    provider,
    label: label || null,
    usage: 'Send this in the X-Relaybee-Connection header. Comma-separate several to pool them.',
    note: 'Bound to your key. Another user replaying this blob gets a decryption failure, not your credits.',
  }, rlh)
}
