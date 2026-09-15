# Contributing to Relaybee

Thanks for helping out. Relaybee is a small, deliberately dependency-free codebase, so
contributions are easy to run and review. Please read this whole page before you open a PR.

## Getting set up

```bash
npm install
npm run check
```

`npm run check` is the complete local gate. It runs the typecheck, smoke suite, Upstash queue
suite, end-to-end HTTP suite and adversary suite, in that order. It must pass before every commit.
Add assertions when you add behavior.

Each suite can still be run by itself while iterating:

```bash
npm test
npm run test:upstash
npm run test:e2e
npm run test:adversary
```

CI runs `npm run check` on every push to `main` and every PR (`.github/workflows/ci.yml`). A PR
that is not green does not merge.

## Architecture invariants

These are load-bearing. A change that breaks one of them will not be merged. They are documented
in full in `CLAUDE.md`; the short version:

- **No database on the hot path.** Keys are HMAC signatures over their own payload; connections
  are AES-256-GCM blobs the client holds. Verification is a recompute, not a lookup. The relay
  queue is the only stateful piece.
- **Connection blobs are bound to their owner** as AES-GCM additional data. A blob is unusable by
  anyone but the user who sealed it. This is deliberate and security-reviewed. Never remove it.
- **Zero runtime dependencies, Edge runtime, WebCrypto only.** No npm packages in `lib/` or
  `api/`.
- **Strict CSP on every HTML page.** No inline script or style, same-origin only. Keep JS and CSS
  in external files.
- **The relay is a disclosed plaintext-trust relationship.** Supporters see prompts, users see
  answers. Say so where a supporter starts.

## Branch and PR flow

1. Branch off `main`. Use a short descriptive name, for example `feat/retry-budget` or
   `fix/pool-cap`.
2. Make the change scoped to one issue. No unrelated refactors in the same PR.
3. Run `npm run check`.
4. Commit with a clear message. Keep the subject line short and in the imperative mood.
5. Open a PR against `main` and fill in the pull request template.
6. CI must be green. `main` deploys to production automatically, so merging ships.

## Style

- Plain, direct prose in docs and comments. No em dashes.
- Match the surrounding code. The project has no formatter config, so follow what is already
  there.
- Update `PROJECT.md` in the same commit as any change it describes, so the board is never stale.

## Reporting security issues

Do not open a public issue for a vulnerability. See `SECURITY.md` for the private reporting route.
