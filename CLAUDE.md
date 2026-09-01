# Relaybee — working notes for Claude

Relaybee is one OpenAI-shaped endpoint with two ways to get an answer:
1. **Bring your own keys** — route to Anthropic / OpenAI / Groq with credentials the caller
   supplies, sealed into client-held blobs, pooled with failover.
2. **Supporter relay** — `claude-code` reaches supporter nodes running under the caller's own key
   (a pasted worker loop), so the job is only ever offered to their own machines.
   `claude-code/public` is the opt-in escape hatch that offers it to anyone who has opted a node
   into the shared pool, which is how a stranger's machine answers. No provider key needed on the
   caller's side either way.

The homepage (`public/index.html` + `app.css` + `app.js`) auto-mints a key on load, offers a
copy/regenerate box, a supporter toggle with a live "N supporters online" count, and a worker
brief to paste into Claude Code / Codex. `public/docs.html` is the caller-facing API reference: it
reads the key out of localStorage and substitutes it into every example, and runs a live streaming
relay call from the page. There are two pages and a 404, and that is the whole site: the old
interactive demo at `/demo.html` was removed on 2026-08-02. Bring-your-own-keys is still a real
path through the API and is documented on the docs page; it just has no UI.

## Architecture invariants — do not quietly break these

- **No database on the hot path.** Keys are HMAC signatures over their own payload (`lib/auth.ts`);
  connections are AES-256-GCM blobs the client holds (`lib/seal.ts`). Verification is a recompute,
  not a lookup. The relay queue (`lib/queue.ts`) uses Upstash Redis when `UPSTASH_REDIS_REST_*`
  are set and a per-instance in-memory fallback otherwise — that is the only stateful piece.
- **Delivery is gated on a ticket, not on the job id.** `/api/work/complete` requires the HMAC over
  (jobId, poppingNodeUserId) that `/api/work/next` issued with the job, recomputed on the way in.
  The id alone is not a capability: the gateway hands it back to the caller as `chatcmpl-<id>`, so
  it leaks by design.
- **Presence is per pool.** A node opts in by posting `{"pool":"public"}` to `/api/work/next`,
  `markLive(userId, watchesPublic)` records that in a second sorted set, and `lib/gateway.ts` reads
  `countLivePublic()` for a "/public" caller. Its fate depends on the opt-in count, not the global
  one, which would otherwise hold it on the strength of an unrelated own-only node.
- **Connection blobs are bound to their owner** as AES-GCM additional data. A blob is unusable by
  anyone but the user who sealed it. This is deliberate and security-reviewed; never remove it.
- **Zero runtime dependencies, Edge runtime, WebCrypto only.** No npm packages in `lib/` or `api/`.
- **Strict CSP on every HTML page** (no inline script/style, same-origin only). A bearer key in
  localStorage means any XSS is key theft. Keep JS/CSS in external files.
- **The relay is a disclosed plaintext-trust relationship.** In the public pool a supporter reads a
  stranger's prompt and that stranger reads the supporter's answer, and the two risks a supporter
  carries are that the prompt is untrusted input reaching their agent and that a consumer
  subscription is licensed to its holder. The full disclosure lives in `public/llms.txt`, which is
  the file the connect line makes an agent read before it runs anything, so the note sits on the
  path a supporter actually takes. **Keep it there**, and keep the connect line pointing at it; if
  that link goes, nothing discloses anything. Anything the board concludes about supporter risk
  belongs where a supporter will read it, not only in `PROJECT.md`.
  The long note came off the homepage on 2026-08-02 by the owner's decision. On 2026-08-04 a single
  sentence went back, and only because the connect line now says "I have read and accepted the
  supporter terms" on the reader's behalf — an agent stalls without it, waiting for a human who is
  not there mid-setup. That claim has to be made true somewhere the human sees before copying, so
  the homepage names the two risks in one line and links `/llms.txt` for the rest. If the connect
  line ever stops asserting acceptance, this sentence can come off again.

## Testing & deploy

- **Supporter onboarding is measured, not argued.** `test/agent-harness.mts <port>` boots the real
  edge handlers plus `public/` on a local port and rewrites every production URL out of the files
  it serves, so a real `claude -p` can be pointed at it without any chance of answering
  production's callers. `/_h/log` reports which endpoints a trial actually hit, which is the only
  trustworthy signal: agents report "supporter is running, pid 20196" for nodes that never came
  up. It is deliberately not part of `npm run check` (it needs a live agent and real minutes).
  Run it before changing the connect line in `app.js` or the wording of `llms.txt` — both are
  load-bearing and the obvious phrasing measurably does not work. An agent's fetch tool caches,
  so use a fresh port per batch or you are measuring the previous edit.
- `npm run coverage` runs the whole gate under c8 and prints what never executed. Use it before
  claiming anything is dead: grep answers "nothing references this name", which is a different
  question from "this never runs". Measured 2026-08-20: **95.9% of statements, 99.2% of functions**,
  and every function that never runs is an `export const config` marker Vercel reads at build time.
  There is no dead code in `lib/` or `api/`; uncovered lines are reachable error paths, so treat a
  new one as a missing test rather than as something to delete.
- `npm run test:adversary` mints its own keys and attacks the service. Every check passes only when
  an attack **fails**. It boots the handlers on an ephemeral port, needs no credential and makes no
  model calls, so it runs in the gate.
- `npm run check` = `tsc --noEmit` + `test/smoke.mts` + `test/upstash.mts` (the real Upstash
  path against a fake REST server that counts Redis commands, so cost claims are asserted, not
  argued) + `test/e2e.mts` (the handlers over real HTTP, including a worker loop that pops a job,
  keeps its ticket and answers it) + `test/adversary.mts`. It must pass before any commit. Add
  assertions when you add behavior. Exact counts live in the `PROJECT.md` changelog, where they are
  a snapshot rather than a claim about now.
- Deploy is automatic: Vercel builds every push. **`main` → production** (`relaybee.vercel.app`);
  every PR gets a preview URL. So merging to `main` ships.
- GitHub Actions (`.github/workflows/ci.yml`) runs `npm run check` on pushes and PRs.

## Endpoints

`POST /api/keys/issue`, `POST /api/connect`, `POST /api/v1/chat/completions`, `GET /api/v1/models`,
`POST /api/work/next`, `POST /api/work/complete`, `GET /api/work/status`, `GET /api/health`.

## Status & roadmap

`PROJECT.md` is the living board — read it first, and update it in the same commit as any change.
The design review that set direction (personal capacity router, not a marketplace) is under
`docs/design/`.
