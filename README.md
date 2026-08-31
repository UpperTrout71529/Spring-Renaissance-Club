# Spring-Renaissance-Club

Private client portal for Spring Renaissance. `worker.js` is the Cloudflare
Worker (`stripe-magiclink`); `index.html` is the single-file client portal.

## State: what lives where

Concurrently mutated state is in **D1**. State that is written once and read by
key stays in **KV**.

| Store | Data | Why |
|---|---|---|
| D1 `users` | status, credits, skipped, Stripe ids, revocation stamp | Mutated by two handlers and four webhook branches at once. Every write is a guarded `UPDATE`, so `meta.changes` answers "did it apply" exactly. |
| D1 `chat_sessions` / `chat_messages` | curator transcript, takeover window | One row per message. An append is an `INSERT`, so a curator and a client writing at the same instant cannot overwrite each other. |
| D1 `processed_events` | webhook idempotency | The `PRIMARY KEY` conflict *is* the "already processed" answer, so check-and-reserve is one atomic statement. |
| D1 `rate_events` | chat + link rate limits | Sliding window, insert-then-count. Rows expire via a `DELETE` in the same batch — no cron. |
| KV `magic_<token>` | portal sessions | Written once, read by key, never races. KV's TTL is a free and reliable expiry mechanism; reimplementing it in SQL would buy nothing. |
| KV `cust_<id>` | Stripe customer → email index | Same: write-once, read by key. |
| KV `user_<email>`, `curator_<email>` | **rollback mirror only** | Not read as the source of truth. See below. |

The reason for the move is a class of bug, not a single defect: the KV code
read a record, changed it in JavaScript, and wrote the whole thing back. Two
writers both read the old value and the second silently erased the first. The
mitigations applied in earlier audits (merge-on-write, re-reading immediately
before the put, deduplicating by id) narrowed the window to milliseconds but
could not close it. `UPDATE … WHERE` closes it.

D1 has no interactive transactions — a connection is not held across `await` —
so "atomic" here means one guarded statement or one `env.DB.batch([...])`,
never a read-modify-write in JS.

## Setup

```bash
wrangler d1 create spring-renaissance      # put the id into wrangler.toml
wrangler d1 execute spring-renaissance --local  --file=./schema.sql
wrangler d1 execute spring-renaissance --remote --file=./schema.sql
wrangler deploy                            # schema FIRST, then the worker
```

**Order matters on every deploy that changes `schema.sql`.** The rate limiter's
cleanups depend on `idx_rate_events_created` and `idx_processed_events_at`; ship
the worker before the indexes and the first request full-scans live data, on the
one code path an unauthenticated caller can reach.

`wrangler.toml` carries the bindings. Secrets are set only with
`wrangler secret put`: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
`GEMINI_API_KEY`, `RESEND_API_KEY`, `ADMIN_SECRET`, `PORTAL_ORIGIN`.

## Tests

```bash
node --test test/*.test.mjs                       # everything
for i in $(seq 1 20); do node --test test/atomicity.test.mjs || break; done
```

The suite runs against a D1 emulation over `node:sqlite` that applies this
repository's own `schema.sql`, so schema drift fails the tests rather than
passing quietly. The `interleave` variants in `atomicity.test.mjs` force a
macrotask turn before every statement; without that the emulator is too
well-behaved to expose a lost update, and a read-modify-write would pass a
concurrency test it would fail in production.

## Migration and rollback

Migration is **lazy**: no backfill script and no downtime. On a D1 miss the
worker reads the legacy `user_<email>` record from KV, does `INSERT OR IGNORE`,
and re-reads. Two concurrent first-touches are safe — one wins, the other reads
the winner's row. A client who never opens the portal migrates on their first
webhook.

Every mutation is also projected back into `user_<email>` / `curator_<email>`
in the pre-migration KV shape. Those keys are never read as truth; they exist
so this deploy can be rolled back.

**To roll back:** redeploy the previous Worker revision. The KV records are
current as of the last mutation, so nothing is lost. Do not delete the D1
database — rolling forward again should not have to re-migrate.

Removing the mirror is a separate task, after D1 has been the source of truth
for a week.

## Webhook idempotency and isolate death

A reservation is committed to `processed_events` *before* the credit is applied,
which is what makes A-1 (two concurrent deliveries both crediting) impossible.
The cost is that an isolate dying in between — CPU limit, eviction, OOM — runs
no `catch` and no `finally`, so the reservation outlives the invocation that
took it. Stripe's retry then hits the primary key, is answered
`{duplicate: true}`, stops retrying, and the payment is lost with nothing
logged. The window is not instantaneous: a cold `cust_` index puts a live
Stripe lookup, capped at 15s, inside it.

`completed_at` closes this. It is NULL from the moment the reservation is taken
until the handler finishes; a reservation that is both still pending and older
than `RESERVATION_STALE_MS` (120s) is reclaimed by the next retry. Completion is
marked in the `finally` of `fetch()` — the one place that sees every applied
branch — because `reservedEventId` is non-null there exactly when the event was
reserved and applied. Marking it at each `return` instead would work until
someone adds a branch and forgets, and a reservation that never completes is
re-creditable once it ages.

Reclaim is guarded on both conditions, and both matter:
`completed_at IS NULL` alone would re-credit every settled payment once it aged;
`processed_at < ?` alone would reclaim a reservation whose handler is still
running, which double-credits. Both directions have a test.

## Known limits

- **Rate limiting is approximate under a simultaneous burst.** Insert-then-count
  means a client firing 15 requests in the same instant may have all 15 refused
  rather than 10 admitted. That is the safe direction and it is why the insert
  comes first: count-then-insert lets concurrent callers all observe `limit - 1`
  and all proceed. Sequential traffic admits exactly the limit. A refused
  request withdraws its own row, so a burst no longer extends its own penalty.
- **`/api/auth/request-link` checks the IP budget before the email budget, in
  sequence.** The endpoint takes no session, and insert-then-count writes before
  it reads, so a parallel check billed every probe to *both* buckets. An
  attacker cycling fresh addresses never tripped the per-email limit, and each
  request bought two rows in a table only they were growing — enough to exhaust
  the free-tier write budget, at which point the limiter's fail-open `catch`
  disables every limit in the system. Sequential and IP-first bounds it.
- **`/api/auth/request-link` does not equalise timing.** It always answers
  `202 {"ok":true}` — for a member, a stranger, a cancelled account, a malformed
  address, and a caller over the limit — so the response cannot be used to
  enumerate the client base. The path that sends an email is still measurably
  slower. Closing that would need a queue; the one-link-per-address-per-two-
  minutes limit makes the timing oracle impractical instead.
- **Admin auth is an MVP shared secret**, behind the `authorizeAdmin` seam. It
  is unusable for a browser admin console, which would have to ship the secret
  to the client. The target is Cloudflare Access in front of the admin paths, or
  short-lived scoped tokens — swapped in one piece, behind that function.
- **The CSP script hash is enforced by the test suite**, not by a CI step
  (there is no CI in this repository). Editing the inline script without
  updating the `sha256-` in the meta tag fails `AC-20` rather than silently
  blanking the page in production.
