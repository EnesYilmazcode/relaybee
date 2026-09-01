# Security Policy

Relaybee is a small proxy with a deliberately narrow trusted surface. This file says how to report a
problem privately, what we consider in scope, and where the honest limits are.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately instead.

- Use GitHub's private advisory form: the "Report a vulnerability" button under the repository's
  Security tab. This keeps the report private until a fix is ready.

Tell us what you found, how to reproduce it, and what an attacker gains. A working proof of concept
helps but is not required. We will confirm we received the report, work the issue, and credit you
when a fix ships unless you ask us not to.

## In scope

These are the parts where a break matters, and where we want to hear from you.

### HMAC key signing

A Relaybee key is an HMAC signature over its own payload, verified by recompute, with no user table
behind it (`lib/auth.ts`). A forgery that verifies is a full break. That includes minting a valid
key without the master secret, swapping the payload while keeping a valid signature, changing the
tier field off the single `free` value the service issues, or moving the expiry.

### AES-GCM sealed connection blobs

A provider key is sealed into an AES-256-GCM blob that the client holds; Relaybee keeps no copy
(`lib/seal.ts`). Each blob is bound to the user who sealed it as AES-GCM
additional authenticated data, so it is unusable by anyone but its owner. In scope: decrypting a blob without the
encryption key, using one user's blob under another user's key, or any tampering with the IV,
ciphertext, or tag that the tag does not catch.

### The supporter relay

The `claude-code` model routes through a work queue (`lib/queue.ts`, `api/work/*`) to a node
running under the caller's own key. `claude-code/public` is the opt-in suffix that offers the job
to a stranger's machine instead. In scope: reading or completing a job you were not handed, forging or replaying a delivery ticket,
or completing a job under a key its ticket was not issued to. Jobs deliberately carry only the
model and the flattened messages, with no requester id or IP. The job id is not on its own a
capability: Relaybee publishes it to the caller as `chatcmpl-<id>`, so delivery is gated on an
HMAC ticket that `/api/work/next` issues over the job id and the polling node's user id, and
recomputes on delivery.

## Out of scope

- Denial of service through raw request volume. Rate limiting is per instance and approximate by
  design; see below.
- Anything requiring the server's environment secrets (`MASTER_SECRET`,
  `MASTER_ENCRYPTION_KEY`). If those leak, everything signed or sealed under them is void, and that
  is understood.
- Provider-side behavior once a request leaves Relaybee.

## Known limits

These are consequences of the design, not bugs. We list them so a report about one is not a
surprise, and so the trust model is clear before you rely on it.

- **A leaked key is valid until it expires.** Keys carry a 90 day expiry and there is no
  revocation list, because there is no database on the hot path. A key that leaks stays good until
  it expires. Rotating the master secret invalidates every key at once, which is the only lever.
  On Vercel that takes effect on the next deployment: instances already running keep the old secret
  until they are replaced, so a rotation alone looks like it did nothing while traffic keeps them
  warm.
- **Rate limiting is per instance and approximate.** The limiter is a sliding window held in the
  memory of one warm instance. It resets on a cold start and does not add up across regions. It
  protects Relaybee's own invocation quota against a single source. It does not stop a distributed
  caller and is not meant to.
- **The public relay pool is a plaintext trust relationship.** A node that opted into the shared
  pool reads the prompts it is handed, and the caller reads that node's answer. There is no
  encryption between the two and no vetting of either side. On the default own-key pool both ends
  are the same person, so this applies to `claude-code/public` rather than to `claude-code`. This is disclosed where a supporter
  turns the worker on. Do not send anything through the relay that you would not hand to a
  stranger.
