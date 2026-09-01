// Cross-origin policy for the endpoints that hand out or consume a capability.
//
// These used to answer every origin with `*`. Nothing first-party needed that:
// the site fetches its own origin, and a same-origin request needs no CORS
// header at all. What the wildcard did buy was a drive-by. Any page a visitor
// loaded could mint a key in their browser and poll the relay from their IP,
// with no interaction, because `/api/keys/issue` is an unauthenticated simple
// POST and so never triggers a preflight to be refused.
//
// That is a hardening item rather than the prompt theft it resembles. The relay
// is a disclosed trust relationship and a plain curl already reaches it, so the
// only thing removed here is the browser amplifier. Returning a bearer token
// under `*` is also a scanner smell even when it is defused, and nothing
// legitimate is asking for it.
//
// The proxy path (`/api/v1/*`) and `/api/health` keep their wildcard on
// purpose: they are the public API surface, callers are expected to be
// arbitrary origins, and neither hands back a credential.

/**
 * Extra origins allowed to read these responses, comma separated, e.g. a
 * staging front end on another domain. Empty by default, which means
 * same-origin only. Read at call time rather than at module scope so a warm
 * instance picks up a change, matching hasSecrets in lib/config.ts.
 */
export function allowedOrigins(): string[] {
  return (process.env.RELAYBEE_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * Build the CORS headers for one request. An allow-listed origin is reflected;
 * anything else gets no `access-control-allow-origin` at all, so a browser
 * refuses to expose the body while a same-origin fetch is unaffected.
 *
 * `vary: origin` is not optional here. Without it a shared cache could serve
 * one origin's reflected header to another.
 */
export function corsFor(req: Request | undefined, base: Record<string, string>): Record<string, string> {
  let origin = ''
  // Tests drive these handlers with hostile Request stubs whose header access
  // throws, and a CORS envelope is exactly what those paths exist to preserve.
  try {
    origin = req?.headers.get('origin') ?? ''
  } catch { /* treat an unreadable origin as absent */ }
  const headers: Record<string, string> = { ...base, vary: 'origin' }
  if (origin && allowedOrigins().includes(origin)) {
    headers['access-control-allow-origin'] = origin
  }
  return headers
}
