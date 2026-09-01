// Shared gateway logic behind the /api/v1 routes.
//
// This lives in lib/ rather than in a catch-all route because Vercel's
// zero-config api/ directory only matches ONE path segment for [...param] —
// /api/v1/models resolved, /api/v1/chat/completions 404'd. Explicit route files
// import from here, so the logic stays in one place and the routing is boring.

import { verifyKey, bearer } from './auth'
import { open, type Connection } from './seal'
import { route, ADAPTERS, type ChatRequest } from './providers'
import { check, LIMITS, clientIp, IP_PROXY_LIMIT, rlHeaders } from './ratelimit'
import { submitJob, awaitResult, cancelJob, countLivePublic, isLive, type Job, type Usage, type Pool } from './queue'
import { hasSecrets, NOT_CONFIGURED } from './config'

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type, x-relaybee-connection, x-fanout-connection',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-expose-headers':
    'x-relaybee-provider, x-relaybee-connection-label, x-relaybee-attempt, x-relaybee-attempts, ' +
    'x-relaybee-pool-size, x-relaybee-pool-health, x-ratelimit-limit, x-ratelimit-remaining, x-ratelimit-reset',
}

const preflight = () => new Response(null, { status: 204, headers: CORS })

function err(status: number, message: string, type = 'invalid_request_error', extra: Record<string, string> = {}) {
  return new Response(JSON.stringify({ error: { message, type } }), {
    status,
    headers: { 'content-type': 'application/json', ...CORS, ...extra },
  })
}

/** Verifies the key and meters the request. Returns a Response only on rejection. */
async function gate(req: Request) {
  // Verifying the key needs MASTER_SECRET. Without it verifyKey would treat every
  // key as invalid and return a misleading 401; a 503 tells the truth.
  if (!hasSecrets('MASTER_SECRET')) return { fail: err(503, NOT_CONFIGURED, 'api_error') }

  const auth = await verifyKey(bearer(req))
  if (!auth) {
    return { fail: err(401, 'Missing or invalid Relaybee API key. Get one from /api/keys/issue.', 'authentication_error') }
  }
  const rl = check(auth.u, LIMITS[auth.t] ?? LIMITS.free)
  const headers = rlHeaders(rl)
  if (!rl.ok) return { fail: err(429, 'Rate limit exceeded.', 'rate_limit_error', headers) }

  // Second dimension, on the source IP. Without it the per-user limit above is
  // decorative: minting a new key is free and unauthenticated, so a caller can
  // rotate into a fresh bucket whenever they hit one.
  const ip = check(`ip:${clientIp(req)}`, IP_PROXY_LIMIT)
  if (!ip.ok) return { fail: err(429, 'Rate limit exceeded for this source.', 'rate_limit_error', headers) }

  return { auth, headers }
}

/** Provider statuses worth retrying on a different credential. */
function shouldFailover(status: number) {
  return status === 401 || status === 403 || status === 429 || status >= 500
}

// Failover walks the pool serially, so pool size is a direct multiplier on both
// outbound requests and function time. Uncapped, a caller could send ~140 blobs
// in one header (bounded only incidentally by Vercel's 32KB header limit) and
// turn a single request into 140 upstream calls and ~20s of execution.
// Eight is well past any legitimate pool and bounds the blast radius.
export const MAX_POOL = 8

/**
 * The OpenAI models list.
 *
 * Every id in `data` has to be something a caller can put in `model` and have
 * work, because that is the entire contract of this endpoint and clients build
 * model pickers straight out of it. This used to return the provider names with
 * `object: "provider"`, which meant a picker offered "anthropic" and every pick
 * came back 400: routing wants "<provider>/<model>", not a bare provider.
 *
 * `data` is the relay ids, built from the constants the router dispatches on so
 * the list cannot drift from what routes. Both of them belong on it because they
 * are different capacity: the bare id reaches only nodes running under the
 * caller's own key, so advertising it alone hands every caller without a node of
 * their own the one id that is guaranteed to time out for them, and hides the
 * only id that reaches anybody else's machine.
 *
 * The providers are still worth reporting, they are just not models, so they
 * moved to their own field with the shape a caller has to build.
 */
export async function listModels(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return preflight()
  const g = await gate(req)
  if (g.fail) return g.fail
  return new Response(
    JSON.stringify({
      object: 'list',
      data: RELAY_MODELS.map((id) => ({ id, object: 'model', owned_by: 'relaybee' })),
      providers: Object.keys(ADAPTERS).map((id) => ({ id, model_format: `${id}/<model>` })),
    }),
    { headers: { 'content-type': 'application/json', ...CORS, ...g.headers } },
  )
}

// --- the supporter relay --------------------------------------------------

// "claude-code/<anything>" routes to the supporter queue instead of a provider:
// the request needs no connection blobs, because supporters' machines are the
// capacity. Non-streaming in substance; stream:true gets the finished answer as
// a single SSE chunk so OpenAI clients that always stream still work.
const RELAY_PROVIDER = 'claude-code'
// "claude-code" goes to the caller's own nodes. "claude-code/public" offers the
// job to anyone running a node that has opted into the shared pool.
//
// The default used to be the second one, without anyone choosing it: every job
// went to one global list that any free key could drain. Reading a stranger's
// prompt and writing a stranger's answer are both things to agree to, so they
// are now named on both sides.
const PUBLIC_SUFFIX = 'public'
const poolFor = (model: string): Pool =>
  model.slice(RELAY_PROVIDER.length + 1) === PUBLIC_SUFFIX ? 'public' : 'own'
// Spelled from the same two constants poolFor reads, so a change to either one
// moves the router and the models list together instead of leaving the list to
// advertise a spelling that stopped routing.
const RELAY_MODELS = [RELAY_PROVIDER, `${RELAY_PROVIDER}/${PUBLIC_SUFFIX}`]
// The buffered path emits nothing until the answer is complete, so it is bounded
// by Vercel Edge's ~25s initial-response deadline. Exceed that and a timeout
// surfaces as platform 504 HTML instead of our clean JSON, so we give up first.
const RELAY_WAIT_MS = 20_000
// The streaming path is not bounded the same way. Edge requires a response to
// BEGIN within 25s but then allows streaming for minutes, so once the first
// chunk is out we can wait for an answer a supporter is actually still writing.
// Measured against production: a real headless `claude -p` on a real question
// takes 20 to 30 seconds, which the buffered window can never fit.
const RELAY_STREAM_WAIT_MS = 110_000
// One wait slice, and one keepalive comment per slice. Kept at the queue's own
// blocking cap so each slice is a single Redis command.
const RELAY_SLICE_MS = 15_000
const MAX_JOB_BYTES = 32 * 1024

// Upper bound on the raw request body, enforced before any parse or upstream
// fetch. The proxy re-serialises the body and ships it to a provider, so an
// oversized payload is both an amplification vector and a way to burn function
// time on JSON.parse. 256KB is far past any legitimate chat request (the relay
// caps its own message payload at 32KB) and rejects the rest cleanly.
//
// Counted in bytes, which is what the name says and what the cost is. This was
// measured on a JS string's .length, and that counts UTF-16 code units: every
// CJK character is one unit and three bytes, so the real ceiling was 768KB, and
// past the pool walk that is eight outbound copies of it. api/work/complete.ts
// already did this correctly with a TextEncoder; these two did not.
export const MAX_BODY_BYTES = 256 * 1024

/**
 * A supporter's reported cost, in the shape OpenAI clients read.
 *
 * Zeros when a node reported nothing. That is the honest answer rather than a
 * guess: the relay never sees the model call, so there is nothing here to
 * estimate from, and a character-count approximation dressed as a token count
 * is worse than a zero in a product whose whole point is cost.
 *
 * cost_usd is Relaybee's own field, because OpenAI has no place for a number
 * the upstream actually knows. A client that ignores it loses nothing.
 */
function openaiUsage(u: Usage | undefined) {
  if (!u) return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  return {
    prompt_tokens: u.inputTokens,
    completion_tokens: u.outputTokens,
    total_tokens: u.inputTokens + u.outputTokens,
    cost_usd: u.costUsd,
  }
}

/** OpenAI content can be a string or an array of typed parts; jobs carry plain text. */
function flatten(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('')
  }
  return ''
}

async function relayCompletion(body: ChatRequest, owner: string, headers: Record<string, string>): Promise<Response> {
  const pool = poolFor(body.model)
  // Message elements are unknown-typed from the wire; a null or non-object entry
  // would throw on property access, so coerce defensively rather than trust them.
  const messages: Job['messages'] = body.messages.map((m) => ({
    role: String((m as { role?: unknown })?.role ?? 'user'),
    content: flatten((m as { content?: unknown })?.content),
  }))
  if (!messages.some((m) => m.content.trim() !== '')) {
    return err(400, 'No text content to relay. The claude-code model needs at least one message with text.', 'invalid_request_error', headers)
  }
  const payload = JSON.stringify(messages)
  if (new TextEncoder().encode(payload).length > MAX_JOB_BYTES) {
    return err(400, `Request too large for the relay: cap is ${MAX_JOB_BYTES / 1024}KB of messages.`, 'invalid_request_error', headers)
  }

  let job: Job
  try {
    job = await submitJob(body.model, messages, owner, pool)
  } catch {
    // A queue-backend hiccup (e.g. transient Upstash 5xx) must not escape as a
    // bare platform 500 with no CORS or error envelope.
    return err(502, 'The relay queue is temporarily unavailable. Try again shortly.', 'api_error', headers)
  }

  const created = Math.floor(Date.now() / 1000)
  const relayHeaders = { ...headers, 'x-relaybee-provider': RELAY_PROVIDER }

  if (body.stream) return relayStream(job, body, owner, pool, created, relayHeaders)

  let result: Awaited<ReturnType<typeof awaitResult>>
  try {
    result = await awaitResult(job.id, RELAY_WAIT_MS)
  } catch {
    return err(502, 'The relay queue is temporarily unavailable. Try again shortly.', 'api_error', headers)
  }
  if (result === null) {
    // Nobody is waiting for this any more. Leaving it queued means the next
    // supporter to connect spends real model time on an answer no one reads.
    await cancelJob(job, owner, pool).catch(() => {})
    return err(504, await timedOutMessage(owner, pool), 'api_error', headers)
  }

  return new Response(
    JSON.stringify({
      id: `chatcmpl-${job.id}`, object: 'chat.completion', created, model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: result.text }, finish_reason: 'stop' }],
      usage: openaiUsage(result.usage),
    }),
    { headers: { 'content-type': 'application/json', ...CORS, ...relayHeaders } },
  )
}

/**
 * Why the wait ended with nothing. "Nobody is here" and "someone is here and
 * still writing" are different problems with opposite advice, and telling a
 * caller to retry while a supporter is mid answer just queues the same prompt
 * twice and spends their tokens twice.
 */
async function timedOutMessage(owner: string, pool: Pool, known?: Serving): Promise<string> {
  const serving = known ?? (await anyoneCanServe(owner, pool))
  if (serving === 'yes') {
    return `A supporter took this and did not finish inside ${RELAY_WAIT_MS / 1000}s. Send "stream": true and Relaybee holds the connection open while they work, which is what long answers need.`
  }
  return pool === 'public'
    ? 'No node is watching the public pool right now. Run one yourself, or drop the "/public" suffix to use your own.'
    : `No node of your own is online. "${RELAY_PROVIDER}" is served by machines running a supporter node under this same API key, so start one, or send "${RELAY_PROVIDER}/${PUBLIC_SUFFIX}" to offer the job to anyone who has opted into the shared pool.`
}

/**
 * Whether any node could take this particular job.
 *
 * A job goes to exactly one queue, so the presence that decides its fate is
 * per-pool. The global count cannot answer for "/public": every node marks
 * itself live whether or not it opted in, so a count above zero would report
 * one own-only node anywhere in the world as capacity for a public caller and
 * hold them for the whole streaming window on the strength of it. The opt-in is
 * recorded where a node opts in, in api/work/next.ts, and read back here.
 * Either way this is one presence command.
 */
type Serving = 'yes' | 'no'

async function anyoneCanServe(owner: string, pool: Pool): Promise<Serving> {
  try {
    if (pool !== 'public') return (await isLive(owner)) ? 'yes' : 'no'
    return (await countLivePublic()) > 0 ? 'yes' : 'no'
  } catch {
    return 'no'
  }
}

/**
 * Streaming relay. The first chunk goes out immediately, which is what buys the
 * long wait: Edge only requires that a response START within 25s. After that we
 * wait in slices, sending an SSE comment between them so nothing along the path
 * decides the connection is idle.
 */
function relayStream(job: Job, body: ChatRequest, owner: string, pool: Pool, created: number, relayHeaders: Record<string, string>): Response {
  const includeUsage = (body.stream_options as { include_usage?: unknown } | undefined)?.include_usage === true
  const encoder = new TextEncoder()
  const frame = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`
  const chunk = (delta: unknown, finish: string | null) => ({
    id: `chatcmpl-${job.id}`, object: 'chat.completion.chunk', created, model: body.model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })

  const stream = new ReadableStream({
    async start(controller) {
      const send = (s: string) => controller.enqueue(encoder.encode(s))
      send(frame(chunk({ role: 'assistant' }, null)))

      const deadline = Date.now() + RELAY_STREAM_WAIT_MS
      let result: Awaited<ReturnType<typeof awaitResult>> = null
      let online: Serving | undefined
      let checked = false

      while (Date.now() < deadline) {
        const slice = Math.min(RELAY_SLICE_MS, deadline - Date.now())
        try {
          result = await awaitResult(job.id, slice)
        } catch {
          break
        }
        if (result !== null) break
        // One presence check, after the first empty slice. If nothing is polling
        // the queue then no answer is coming, and holding the caller for the
        // full window would be a worse experience than the old 20s cap. Only a
        // definite "no" ends the wait: an unresolved public pool still has a
        // node that may be mid answer, and cutting that caller off at 15s is the
        // exact failure the 110s window exists to prevent.
        if (!checked) {
          checked = true
          online = await anyoneCanServe(owner, pool)
          if (online === 'no') break
        }
        send(': waiting for a supporter\n\n')
      }

      if (result === null) {
        await cancelJob(job, owner, pool).catch(() => {})
        send(frame({ error: { message: await timedOutMessage(owner, pool, online), type: 'api_error' } }))
      } else {
        send(frame(chunk({ content: result.text }, null)))
        send(frame(chunk({}, 'stop')))
        // OpenAI convention, and the same one the provider path already follows:
        // a trailing usage chunk only when the caller opted in. Its choices array
        // is empty, which is what tells a client the chunk is accounting.
        if (includeUsage) {
          send(frame({
            id: `chatcmpl-${job.id}`, object: 'chat.completion.chunk', created, model: body.model,
            choices: [], usage: openaiUsage(result.usage),
          }))
        }
      }
      send('data: [DONE]\n\n')
      controller.close()
    },
  })

  return new Response(stream, {
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', ...CORS, ...relayHeaders },
  })
}

export async function chatCompletions(req: Request): Promise<Response> {
  try {
    return await chatCompletionsInner(req)
  } catch {
    // Last line of defence: anything unforeseen becomes a clean OpenAI-shaped
    // 500 with CORS, never a bare platform error page.
    return err(500, 'Internal error handling the request.', 'api_error')
  }
}

async function chatCompletionsInner(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return preflight()
  if (req.method !== 'POST') return err(405, 'Use POST for /api/v1/chat/completions')

  const g = await gate(req)
  if (g.fail) return g.fail
  const { auth, headers } = g

  // Read the body once as text so we can bound its size before parsing or
  // touching any upstream. An oversized payload is rejected here — before the
  // relay submit or any provider fetch — so it can never be amplified outward.
  // arrayBuffer, not text: byteLength is the real size, and measuring it before
  // decoding also avoids materialising the string for a body we are rejecting.
  let rawBytes: ArrayBuffer
  try {
    rawBytes = await req.arrayBuffer()
  } catch {
    return err(400, 'Could not read the request body.', 'invalid_request_error', headers)
  }
  if (rawBytes.byteLength > MAX_BODY_BYTES) {
    return err(400, `Request body too large: cap is ${MAX_BODY_BYTES / 1024}KB.`, 'invalid_request_error', headers)
  }
  const rawBody = new TextDecoder().decode(rawBytes)

  let body: ChatRequest
  try {
    body = JSON.parse(rawBody) as ChatRequest
  } catch {
    return err(400, 'Request body must be valid JSON.', 'invalid_request_error', headers)
  }
  if (!body?.model) {
    return err(400, 'Field "model" is required, e.g. "anthropic/claude-opus-5".', 'invalid_request_error', headers)
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return err(400, 'Field "messages" must be a non-empty array.', 'invalid_request_error', headers)
  }

  if (body.model === RELAY_PROVIDER || body.model.startsWith(`${RELAY_PROVIDER}/`)) {
    return relayCompletion(body, auth.u, headers)
  }

  const routed = route(body.model)
  if (!routed) {
    return err(400, `Unknown model "${body.model}". Use "<provider>/<model>", one of: ${Object.keys(ADAPTERS).join(', ')}, ${RELAY_PROVIDER}.`, 'invalid_request_error', headers)
  }
  const { adapter, model } = routed

  // Opening the sealed connection blobs needs MASTER_ENCRYPTION_KEY. The relay
  // path above needs no blobs, so this only guards the provider-routed path.
  if (!hasSecrets('MASTER_ENCRYPTION_KEY')) return err(503, NOT_CONFIGURED, 'api_error', headers)

  // Connections are client-held sealed blobs. Sending several is the point:
  // relaybee rotates across them and fails over when one is rate-limited or dead.
  // x-fanout-connection is the pre-rename name. Configs holding it live in other
  // people's apps and env files, where nothing tells them the project changed
  // its name, so the old header keeps working.
  const header = req.headers.get('x-relaybee-connection') ?? req.headers.get('x-fanout-connection') ?? ''
  const raw = header.split(',').map((s) => s.trim()).filter(Boolean)
  if (raw.length === 0) {
    return err(400, 'Missing X-Relaybee-Connection header. Create one at POST /api/connect.', 'invalid_request_error', headers)
  }
  if (raw.length > MAX_POOL) {
    return err(400, `Too many connections: ${raw.length}. At most ${MAX_POOL} may be pooled in one request.`, 'invalid_request_error', headers)
  }

  const conns: Connection[] = []
  for (const blob of raw) {
    const c = await open(blob, auth.u)
    if (c && c.provider === adapter.id) conns.push(c)
  }
  if (conns.length === 0) {
    return err(403, `No valid ${adapter.id} connection for this key. Blobs are bound to the user who created them.`, 'permission_error', headers)
  }

  // A pooled request is metered for what it is about to do, not for being one
  // request. Walking N connections means up to N upstream calls, and pricing
  // that at 1 turned /api/connect plus the pool walk into a cheap batch oracle
  // for provider keys: seal 8 candidates, send one request, read each one's real
  // upstream status out of x-relaybee-pool-health. Failover is untouched for
  // anyone using it honestly; it just costs what it costs.
  if (conns.length > 1) {
    const extra = check(`ip:${clientIp(req)}`, IP_PROXY_LIMIT, conns.length - 1)
    if (!extra.ok) {
      return err(429, `Rate limit exceeded for this source. A pooled request is metered per connection, and this one asked for ${conns.length}.`, 'rate_limit_error', headers)
    }
  }

  // Start at a random offset so load spreads across the pool instead of always
  // hammering whichever connection happens to be first in the header.
  const start = Math.floor(Math.random() * conns.length)
  const upstreamBody = JSON.stringify(adapter.translateRequest(body, model))

  let lastStatus = 502
  let lastText = JSON.stringify({ error: { message: 'All upstream connections failed.', type: 'api_error' } })

  // Per-attempt outcomes, in the order tried: "label:ok", "label:429",
  // "label:unreachable". Callers debugging a half-dead pool need to see which
  // connections failed, not just which one finally answered.
  const health: string[] = []
  // Both pool headers come from here so every exit carries both. They used to
  // diverge: only the success path reported the size, so a request that failed
  // on its first attempt looked identical to one whose pool was that single
  // connection. Those are opposite problems. One caller has untried keys left,
  // the other pasted blobs the routed adapter never matched, and lib/seal.ts
  // drops an unopenable blob silently, so the size is the only thing that tells
  // them apart from outside.
  const poolMeta = () => ({
    'x-relaybee-pool-size': String(conns.length),
    'x-relaybee-pool-health': health.join(', '),
  })

  for (let i = 0; i < conns.length; i++) {
    const conn = conns[(start + i) % conns.length]

    let upstream: Response
    try {
      upstream = await fetch(adapter.endpoint, {
        method: 'POST',
        headers: adapter.headers(conn.apiKey),
        body: upstreamBody,
      })
    } catch {
      lastStatus = 502
      lastText = JSON.stringify({ error: { message: `Could not reach ${adapter.id}.`, type: 'api_error' } })
      health.push(`${conn.label ?? 'unnamed'}:unreachable`)
      continue
    }

    if (!upstream.ok) {
      lastStatus = upstream.status
      lastText = await upstream.text().catch(() => '{"error":{"message":"Upstream error."}}')
      health.push(`${conn.label ?? 'unnamed'}:${upstream.status}`)
      if (shouldFailover(upstream.status) && i < conns.length - 1) continue
      // Non-retryable (a malformed request, say) — surface it verbatim so the
      // caller sees the provider's own explanation.
      return new Response(lastText, {
        status: upstream.status,
        headers: { 'content-type': 'application/json', ...CORS, ...headers, 'x-relaybee-attempts': String(i + 1), ...poolMeta() },
      })
    }

    health.push(`${conn.label ?? 'unnamed'}:ok`)
    const served = {
      'x-relaybee-provider': adapter.id,
      'x-relaybee-connection-label': conn.label ?? 'unnamed',
      'x-relaybee-attempt': String(i + 1),
      ...poolMeta(),
    }

    if (body.stream && upstream.body) {
      // OpenAI convention: emit a trailing usage chunk only when the caller
      // opted in via stream_options.include_usage.
      const includeUsage = (body.stream_options as { include_usage?: unknown } | undefined)?.include_usage === true
      return new Response(adapter.translateStream(upstream.body, body.model, includeUsage), {
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          ...CORS,
          ...headers,
          ...served,
        },
      })
    }

    const json = await upstream.json()
    return new Response(JSON.stringify(adapter.translateResponse(json, body.model)), {
      headers: { 'content-type': 'application/json', ...CORS, ...headers, ...served },
    })
  }

  return new Response(lastText, {
    status: lastStatus,
    headers: { 'content-type': 'application/json', ...CORS, ...headers, 'x-relaybee-attempts': String(conns.length), ...poolMeta() },
  })
}
