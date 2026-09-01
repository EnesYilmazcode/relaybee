// Runs the real edge handlers on a local port, so a test can drive them over
// real HTTP instead of calling them as functions.
//
// This existed three times: test/e2e.mts and test/agent-harness.mts each had a
// copy, and test/adversary.mts added a third. All three were the same twenty
// lines of adapting Node's req/res to the Web Request/Response the handlers
// speak, which is exactly the kind of thing that drifts one copy at a time.

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export type Handler = (req: Request) => Promise<Response> | Response
export type Routes = Record<string, Handler>

/** Node's incoming request as the Web Request an edge handler expects. */
export async function toRequest(req: IncomingMessage, base: string): Promise<Request> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  const body = chunks.length ? Buffer.concat(chunks) : undefined
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v)
  return new Request(base + req.url, { method: req.method, headers, body: body as unknown as BodyInit })
}

/** A handler's Web Response back onto Node's socket, streaming and all. */
export async function writeResponse(res: Response, out: ServerResponse): Promise<void> {
  out.statusCode = res.status
  res.headers.forEach((v, k) => out.setHeader(k, v))
  if (res.body) {
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      out.write(Buffer.from(value))
    }
  }
  out.end()
}

export type ServeOptions = {
  /** Headers to add when the caller did not send them. Used to pin a source IP. */
  defaultHeaders?: Record<string, string>
  /** Keep the process alive while this server is listening. Default false. */
  keepAlive?: boolean
}

/**
 * Serve a route table on an ephemeral port.
 *
 * Ephemeral rather than fixed on purpose: a stale server left listening on a
 * hardcoded port answers the next run's requests, and on Windows it does so
 * without the new bind failing, so the run reports failures that belong to code
 * that is no longer there. That happened; hence port 0.
 */
export async function serveRoutes(routes: Routes, opts: ServeOptions = {}): Promise<{
  base: string
  server: Server
  close: () => Promise<void>
}> {
  const server = createServer(async (req, res) => {
    const port = (server.address() as AddressInfo).port
    const base = `http://127.0.0.1:${port}`
    const path = (req.url ?? '/').split('?')[0]
    const handler = routes[`${req.method} ${path}`]
    if (!handler) {
      res.statusCode = 404
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ error: { message: `No route for ${req.method} ${path}.` } }))
      return
    }
    try {
      const request = await toRequest(req, base)
      for (const [k, v] of Object.entries(opts.defaultHeaders ?? {})) {
        if (!request.headers.has(k)) request.headers.set(k, v)
      }
      await writeResponse(await handler(request), res)
    } catch (e) {
      res.statusCode = 500
      res.end(String(e))
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  if (!opts.keepAlive) server.unref()
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    server,
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}
