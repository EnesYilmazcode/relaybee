#!/usr/bin/env node
// The terminal half of the setup page: mint a key, seal a provider connection,
// and print a config block to paste into whatever you are wiring up.
//
// Zero dependencies and Node built-ins only, like the other two scripts here.
// It talks to the deployed HTTP API rather than importing lib/, deliberately:
// lib/ is Edge-only and CLAUDE.md forbids npm packages there, and the sealing
// key never leaves the server, so a local seal is not possible anyway.
//
//   node scripts/relaybee.mjs mint
//   printf '%s' "$ANTHROPIC_API_KEY" | node scripts/relaybee.mjs connect --provider anthropic
//   node scripts/relaybee.mjs config --shape curl
//
// The store lives at ~/.relaybee/credentials.json, or $RELAYBEE_HOME if set.

import { parseArgs } from 'node:util'
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const DEFAULT_BASE = 'https://relaybee.vercel.app'
// Mirrors MAX_POOL in lib/gateway.ts. Composing a header above it produces a
// config the gateway answers 400 to, which is worse than refusing to compose it.
const MAX_POOL = 8

const USAGE = `relaybee - mint a key, seal a provider connection, print a config block

  mint                       mint an API key and store it
  connect --provider <name>  seal a provider key, read from stdin
  config [--shape <shape>]   print a ready-to-paste config block
  where                      print the path of the store

Options
  --base <url>       gateway to talk to (default ${DEFAULT_BASE}, or $RELAYBEE_BASE_URL)
  --label <name>     label for a connection, shown in pool-health headers
  --shape <shape>    env (default), curl, js, python
  --force            let mint replace a key that already exists
`

const out = (s) => process.stdout.write(s + '\n')
const note = (s) => process.stderr.write(s + '\n')

/**
 * Exit with a message on stderr. The write callback is what makes this safe:
 * stdio to a pipe is async on POSIX, and CI runs on ubuntu, so calling
 * process.exit straight after a write truncates or loses the message.
 */
function die(msg) {
  process.stderr.write(msg + '\n', () => process.exit(1))
}

const storeDir = () => process.env.RELAYBEE_HOME || join(homedir(), '.relaybee')
const storePath = () => join(storeDir(), 'credentials.json')

async function readStore() {
  try {
    return JSON.parse(await readFile(storePath(), 'utf8'))
  } catch {
    return { connections: [] }
  }
}

async function writeStore(s) {
  await mkdir(storeDir(), { recursive: true })
  await writeFile(storePath(), JSON.stringify(s, null, 2) + '\n', 'utf8')
  // Best effort. Windows ACLs do not map onto a POSIX mode, so this is a no-op
  // there rather than a guarantee, and the file holds a bearer token.
  await chmod(storePath(), 0o600).catch(() => {})
}

async function call(base, path, body, key) {
  let res
  try {
    res = await fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(body),
    })
  } catch (e) {
    // "fetch failed" on its own does not say what was unreachable, and the base
    // is the thing most likely to be wrong.
    die(`Could not reach ${base}: ${e.cause?.code ?? e.message}`)
    return undefined
  }
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { /* keep the raw body for the message */ }
  if (!res.ok) {
    die(`${path} answered ${res.status}: ${json?.error?.message ?? text.slice(0, 200)}`)
    return undefined
  }
  return json
}

/** Read a provider key from stdin. Never from argv, which lands in shell history. */
async function readStdin() {
  if (process.stdin.isTTY) return ''
  let d = ''
  process.stdin.setEncoding('utf8')
  for await (const c of process.stdin) d += c
  return d.trim()
}

function configBlock(shape, base, key, conns) {
  const header = conns.join(',')
  const url = base + '/api/v1'
  if (shape === 'curl') {
    return [
      `curl ${url}/chat/completions \\`,
      `  -H "Authorization: Bearer ${key}" \\`,
      ...(header ? [`  -H "X-Relaybee-Connection: ${header}" \\`] : []),
      `  -H "Content-Type: application/json" \\`,
      `  -d '{"model":"anthropic/claude-opus-5","messages":[{"role":"user","content":"hello"}]}'`,
    ].join('\n')
  }
  if (shape === 'js') {
    return [
      `import OpenAI from 'openai'`,
      ``,
      `const client = new OpenAI({`,
      `  baseURL: '${url}',`,
      `  apiKey: '${key}',`,
      ...(header ? [`  defaultHeaders: { 'X-Relaybee-Connection': '${header}' },`] : []),
      `})`,
    ].join('\n')
  }
  if (shape === 'python') {
    return [
      `from openai import OpenAI`,
      ``,
      `client = OpenAI(`,
      `    base_url="${url}",`,
      `    api_key="${key}",`,
      ...(header ? [`    default_headers={"X-Relaybee-Connection": "${header}"},`] : []),
      `)`,
    ].join('\n')
  }
  return [
    `OPENAI_BASE_URL=${url}`,
    `OPENAI_API_KEY=${key}`,
    ...(header ? [`RELAYBEE_CONNECTION=${header}`] : []),
  ].join('\n')
}

const SHAPES = ['env', 'curl', 'js', 'python']

async function main() {
  let parsed
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        base: { type: 'string' }, provider: { type: 'string' }, label: { type: 'string' },
        shape: { type: 'string' }, force: { type: 'boolean' }, help: { type: 'boolean' },
      },
    })
  } catch (e) {
    return die(e.message + '\n\n' + USAGE)
  }
  const { values: v, positionals } = parsed
  const cmd = positionals[0]
  if (v.help || !cmd) { out(USAGE); return }

  const store = await readStore()
  const base = (v.base ?? process.env.RELAYBEE_BASE_URL ?? store.base ?? DEFAULT_BASE).replace(/\/$/, '')

  if (cmd === 'where') { out(storePath()); return }

  if (cmd === 'mint') {
    // Every mint gets a fresh random user id (api/keys/issue.ts), and a sealed
    // blob is bound to the id that sealed it, so a second mint does not refresh
    // a key. It creates a new identity and orphans every connection stored.
    if (store.key && !v.force) {
      return die(`A key is already stored at ${storePath()}.\n` +
        `Minting again creates a NEW identity, and the ${store.connections.length} stored connection(s) are\n` +
        `sealed to the old one, so they would stop working and cannot be recovered.\n` +
        `Re-run with --force to replace the key and drop them.`)
    }
    const r = await call(base, '/api/keys/issue', {})
    if (!r) return
    const dropped = store.key ? store.connections.length : 0
    await writeStore({ base, key: r.key, userId: r.user_id, connections: [] })
    out(r.key)
    note(`stored in ${storePath()}`)
    if (dropped) note(`dropped ${dropped} connection(s) sealed to the previous key`)
    return
  }

  if (cmd === 'connect') {
    if (!store.key) return die('No key yet. Run: node scripts/relaybee.mjs mint')
    if (!v.provider) return die('--provider is required, for example --provider anthropic')
    if (store.connections.length >= MAX_POOL) {
      return die(`The pool already holds ${MAX_POOL} connections, which is what the gateway accepts.\n` +
        `Remove one from ${storePath()} before adding another.`)
    }
    const apiKey = await readStdin()
    if (!apiKey) {
      return die('No provider key on stdin. Pipe it in so it stays out of your shell history:\n' +
        `  printf '%s' "$ANTHROPIC_API_KEY" | node scripts/relaybee.mjs connect --provider ${v.provider}`)
    }
    const r = await call(base, '/api/connect',
      { provider: v.provider, apiKey, label: v.label ?? v.provider }, store.key)
    if (!r) return
    store.base = base
    store.connections.push(r.connection)
    await writeStore(store)
    note(`sealed ${v.provider} as "${v.label ?? v.provider}", ${store.connections.length} in the pool`)
    out(r.connection)
    return
  }

  if (cmd === 'config') {
    if (!store.key) return die('No key yet. Run: node scripts/relaybee.mjs mint')
    const shape = v.shape ?? 'env'
    if (!SHAPES.includes(shape)) return die(`Unknown shape "${shape}". One of: ${SHAPES.join(', ')}`)
    out(configBlock(shape, base, store.key, store.connections))
    return
  }

  die(`Unknown command "${cmd}".\n\n${USAGE}`)
}

// Only run when this file IS the entrypoint, so a test can import configBlock
// without the CLI trying to parse the test runner's argv.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((e) => die(e.message))
}

export { configBlock, SHAPES, MAX_POOL }
