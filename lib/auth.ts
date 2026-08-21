// Self-verifying API keys. The key IS the record — there is no user table.
//
//   rb_live_<base64url(payload)>.<base64url(hmac_sha256(payload))>
//
// Verification is a single HMAC recompute: no database round trip, ~microseconds,
// and it works on the Edge runtime via WebCrypto.

import { bytesToB64u, b64uToBytes, b64uToJson, jsonToB64u, enc } from './b64'

export type KeyPayload = {
  u: string // user id
  t: 'free' // tier. There has only ever been one; see LIMITS in ratelimit.ts.
  v: number // key version, for rotation
  i: number // issued at (unix seconds)
  e: number // expires at (unix seconds)
}

const PREFIX = 'rb_live_'
// The project was called Fanout until 2026-08-01 and minted fo_live_ keys. Keys
// last 90 days and there is no database to migrate them in, so the only way not
// to break every key already in someone's browser or supporter loop is to keep
// verifying the old prefix. Both are signed by the same MASTER_SECRET; the
// prefix is a label, not part of the signed payload.
const LEGACY_PREFIXES = ['fo_live_']
const KEY_VERSION = 1
const TTL_SECONDS = 90 * 24 * 60 * 60

// Keyed by the secret, not just "have we imported one yet".
//
// Rotating MASTER_SECRET is the only kill switch this project has, and there is
// no key database to revoke against, so the docs point at rotation as the answer
// to a leaked key. A cache that only checks for absence quietly broke that: an
// instance that had already served one request kept verifying under the old
// secret until it went cold, so the rotation appeared to do nothing for as long
// as traffic kept instances warm.
let cachedKey: { secret: string; key: CryptoKey } | null = null

async function hmacKey(): Promise<CryptoKey> {
  const secret = process.env.MASTER_SECRET
  if (!secret) throw new Error('MASTER_SECRET is not set')
  if (cachedKey && cachedKey.secret === secret) return cachedKey.key
  cachedKey = {
    secret,
    key: await crypto.subtle.importKey(
      'raw',
      enc.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify'],
    ),
  }
  return cachedKey.key
}

export async function issueKey(userId: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const payload: KeyPayload = { u: userId, t: 'free', v: KEY_VERSION, i: now, e: now + TTL_SECONDS }
  const body = jsonToB64u(payload)
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(), enc.encode(body))
  return `${PREFIX}${body}.${bytesToB64u(new Uint8Array(sig))}`
}

export async function verifyKey(raw: string | null): Promise<KeyPayload | null> {
  if (!raw) return null
  const prefix = [PREFIX, ...LEGACY_PREFIXES].find((p) => raw.startsWith(p))
  if (!prefix) return null
  // Exactly two parts, and each in its own canonical base64url spelling.
  //
  // The old parse destructured [body, sig] and dropped everything after a second
  // dot, and the signature was compared as DECODED BYTES after a forgiving atob.
  // Between them, one issued key had unlimited valid spellings: trailing junk,
  // spliced whitespace, a stray '=', and several alternate final characters all
  // authenticated as the same key. Nothing here grants privilege, since every
  // variant resolves to the same payload, but "the token is the record" only
  // holds if the token has one spelling, and anything built later that counts,
  // logs or denylists a raw key string would silently be looking at one of many.
  const parts = raw.slice(prefix.length).split('.')
  if (parts.length !== 2) return null
  const [body, sig] = parts
  if (!body || !sig) return null
  if (!isCanonicalB64u(body) || !isCanonicalB64u(sig)) return null

  let ok: boolean
  try {
    ok = await crypto.subtle.verify('HMAC', await hmacKey(), b64uToBytes(sig), enc.encode(body))
  } catch {
    return null
  }
  if (!ok) return null

  let payload: KeyPayload
  try {
    payload = b64uToJson<KeyPayload>(body)
  } catch {
    return null
  }

  if (payload.v !== KEY_VERSION) return null
  if (payload.e < Math.floor(Date.now() / 1000)) return null
  return payload
}

/**
 * Is this the one base64url spelling of the bytes it decodes to?
 *
 * atob accepts padding, whitespace and spare low bits in the final character,
 * so several strings decode to identical bytes. Re-encoding and comparing is the
 * cheapest way to insist on the one that this service would have produced.
 */
function isCanonicalB64u(s: string): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return false
  try {
    return bytesToB64u(b64uToBytes(s)) === s
  } catch {
    return false
  }
}

/** Bearer token out of an Authorization header. */
export function bearer(req: Request): string | null {
  const h = req.headers.get('authorization')
  if (!h) return null
  const m = /^Bearer\s+(.+)$/i.exec(h.trim())
  return m ? m[1] : null
}
