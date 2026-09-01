// Agent harness: does a real headless agent, given the connect line, actually
// set up a supporter node, or does it refuse?
//
// That question cannot be answered by reading llms.txt. It has to be measured,
// so this boots the REAL edge handlers plus the REAL public/ files on a local
// port and lets `claude -p` loose on them.
//
//   npx tsx test/agent-harness.mts [port]
//
// Two safety properties matter here:
//
//  1. Every absolute reference to the production origin is rewritten to this
//     server on the way out, so an agent that follows the file cannot end up
//     answering production's callers with the tester's subscription. The
//     rewrite is asserted at boot; if the file stops matching, we refuse to
//     serve rather than serve something that points at prod.
//  2. Nothing here needs real provider credentials. Throwaway secrets, memory
//     queue, no upstream calls.
//
// GET /_h/log      -> every request seen, so a trial can be classified by what
//                     the agent actually DID rather than by what it said.
// POST /_h/reset   -> clear the log between trials.
// POST /_h/job     -> act as a caller: send a claude-code request and return
//                     whatever the supporter answered. This is the mechanics
//                     check, separate from the willingness check.

import { createServer, type ServerResponse } from 'node:http'
// The req/res-to-Web-Request adapter used to be copied into this file. It is
// shared now; this harness still needs its own server callback for the request
// log, the origin rewriting and the static files, but not its own plumbing.
import { toRequest, writeResponse } from './local-server.mts'
import { readFileSync, existsSync } from 'node:fs'
import type { AddressInfo } from 'node:net'

process.env.MASTER_SECRET = 'agent-harness-secret-not-real'
process.env.MASTER_ENCRYPTION_KEY = Buffer.from(new Uint8Array(32).fill(7)).toString('base64url')

const issue = (await import('../api/keys/issue.ts')).default
const chat = (await import('../api/v1/chat/completions.ts')).default
const workNext = (await import('../api/work/next.ts')).default
const workComplete = (await import('../api/work/complete.ts')).default
const workStatus = (await import('../api/work/status.ts')).default
const health = (await import('../api/health.ts')).default

type Handler = (req: Request) => Promise<Response> | Response
const routes: Record<string, Handler> = {
  'POST /api/keys/issue': issue,
  'POST /api/v1/chat/completions': chat,
  'POST /api/work/next': workNext,
  'POST /api/work/complete': workComplete,
  'GET /api/work/status': workStatus,
  'GET /api/health': health,
}

const PROD = 'https://relaybee.vercel.app'
const PORT = Number(process.argv[2] ?? 8787)
const BASE = `http://127.0.0.1:${PORT}`

// --- request log -------------------------------------------------------------
// The point of the log: an agent can say "I've set up the worker" and not have
// done it, or refuse in prose while a background loop is already polling. The
// only trustworthy signal is which endpoints were actually hit.

type Hit = { at: number; method: string; path: string; ua: string }
let log: Hit[] = []
const t0 = Date.now()

// --- static, with the origin rewritten --------------------------------------

const types: Record<string, string> = {
  '.txt': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
}

function publicFile(path: string): { body: string; type: string } | null {
  const rel = path === '/' ? '/index.html' : path
  if (rel.includes('..')) return null
  const url = new URL('../public' + rel, import.meta.url)
  if (!existsSync(url)) return null
  const ext = rel.slice(rel.lastIndexOf('.'))
  let body = readFileSync(url, 'utf8')
  // Point everything at this server. An agent that follows the file must not be
  // able to reach production from a test run.
  body = body.split(PROD).join(BASE)
  return { body, type: types[ext] ?? 'application/octet-stream' }
}

// Boot-time guard for safety property (1). If llms.txt ever stops naming the
// production origin the way we expect, the rewrite has silently stopped working
// and a trial would hit prod for real.
{
  const raw = readFileSync(new URL('../public/llms.txt', import.meta.url), 'utf8')
  if (!raw.includes(PROD)) {
    console.error(`refusing to start: public/llms.txt no longer contains ${PROD}, so the rewrite cannot be verified`)
    process.exit(1)
  }
  const served = publicFile('/llms.txt')!.body
  if (served.includes(PROD)) {
    console.error('refusing to start: rewritten llms.txt still points at production')
    process.exit(1)
  }
}

const json = (out: ServerResponse, status: number, body: unknown) => {
  out.statusCode = status
  out.setHeader('content-type', 'application/json')
  out.end(JSON.stringify(body))
}

const server = createServer(async (req, res) => {
  const url = new URL(BASE + req.url)
  log.push({
    at: Date.now() - t0,
    method: req.method ?? '?',
    path: url.pathname,
    ua: String(req.headers['user-agent'] ?? ''),
  })

  // --- harness control surface ---
  if (url.pathname === '/_h/log') return json(res, 200, { since: t0, hits: log })
  if (url.pathname === '/_h/reset') { log = []; return json(res, 200, { ok: true }) }
  if (url.pathname === '/_h/job') {
    // Be a caller. Uses the real relay path, so a pass here means a real
    // supporter really answered.
    const prompt = url.searchParams.get('q') ?? 'Reply with exactly the word: PONG'
    try {
      const key = (await (await fetch(BASE + '/api/keys/issue', {
        method: 'POST', headers: { 'x-forwarded-for': '10.0.0.9' },
      })).json()).key
      // Stream, for the reason the docs give callers: a real supporter runs
      // `claude -p` and takes far longer than the ~20s a buffered relay request
      // can wait, so a buffered check here would 504 on a node that works.
      const r = await fetch(BASE + '/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, 'x-forwarded-for': '10.0.0.9' },
        body: JSON.stringify({ model: 'claude-code', stream: true, messages: [{ role: 'user', content: prompt }] }),
      })
      if (!r.ok || !r.body) return json(res, 200, { status: r.status, answer: null, body: await r.text() })

      let answer = ''
      let streamError: string | null = null
      const reader = r.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let i
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const raw = buf.slice(0, i)
          buf = buf.slice(i + 2)
          const data = raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('')
          if (!data || data === '[DONE]') continue
          try {
            const ev = JSON.parse(data)
            // The relay reports a timeout inside a 200 stream; headers were
            // already sent by the time it knew nobody would answer.
            if (ev.error) streamError = ev.error.message
            answer += ev.choices?.[0]?.delta?.content ?? ''
          } catch { /* partial frame, next read completes it */ }
        }
      }
      return json(res, 200, { status: r.status, answer: answer || null, error: streamError })
    } catch (e) {
      return json(res, 500, { error: String(e) })
    }
  }

  // --- real API ---
  const handler = routes[`${req.method} ${url.pathname}`]
  if (handler) {
    try {
      await writeResponse(await handler(await toRequest(req, BASE)), res)
    } catch (e) {
      res.statusCode = 500
      res.end(String(e))
    }
    return
  }

  // --- real static files, origin-rewritten ---
  const file = publicFile(url.pathname)
  if (file) {
    res.statusCode = 200
    res.setHeader('content-type', file.type)
    res.setHeader('access-control-allow-origin', '*')
    // An agent's fetch tool caches. A trial that replays a copy taken before
    // the last edit is measuring the wrong file, and it looks like a real
    // result, so say no-store and run each batch on a fresh port as well.
    res.setHeader('cache-control', 'no-store, max-age=0')
    res.end(file.body)
    return
  }

  res.statusCode = 404
  res.end('not found')
})

await new Promise<void>((r) => server.listen(PORT, '127.0.0.1', r))
console.log(`harness up at ${BASE} (pid ${process.pid})`)
console.log(`llms.txt rewritten to this origin; production is unreachable from a trial`)
console.log(`  log:   curl -s ${BASE}/_h/log`)
console.log(`  reset: curl -s -X POST ${BASE}/_h/reset`)
console.log(`  job:   curl -s -X POST ${BASE}/_h/job`)
