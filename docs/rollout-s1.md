# Portal API rollout: migrations 0000–0004 + Worker `src/index.js`

(Written for S1; S4 added `0004_auth_challenges.sql` and the secrets for
passkeys. The order and the rollback below cover both.)

**Nothing here has been run against production. Every step below happens
only after Felix's explicit "yes".**

## Why the order matters

Migration `0001_users.sql` renames `users` → `legacy_users`, and the legacy
code in `worker.js` now reads `legacy_users`. The schema and the code must
change together:

| D1 | Worker | Result |
|---|---|---|
| not migrated | old (current prod) | works (today) |
| **migrated** | **old** | **broken**: every legacy endpoint and the Stripe webhook fail, `no such table: users` |
| **not migrated** | **new** | **broken**: legacy endpoints fail, `no such table: legacy_users`; `/api/me` fails |
| migrated | new | works (target) |

So: migrations and deploy go back to back, never one without the other. The
gap between them is seconds; requests in it get a 500 (Stripe retries
webhooks, and the webhook handler is idempotent). Production D1 held 0 rows
in every table on 2026-10-15, so there is no data at risk in the gap.

## Rollout (only with Felix's "yes")

0. `wrangler whoami` — the account that owns `stripe-magiclink`.
1. Record the rollback points:
   - `wrangler deployments list` → note the current version id (`V_OLD`).
   - `wrangler d1 time-travel info spring-renaissance` → note the bookmark
     (`B_OLD`). Retention is 7 days on the Free plan: a Time Travel rollback
     must happen within a week.
2. Secrets: `SESSION_PEPPER` (random, 32+ bytes; without it any request with
   a session cookie gets 503 `auth_unavailable`), `TURNSTILE_SECRET`,
   `SHOPIFY_ADMIN_TOKEN`. `SHOPIFY_SHOP` ships in `wrangler.toml` `[vars]`.
3. `wrangler d1 migrations apply spring-renaissance --remote` — lists
   0000–0004 as pending; 0000 is a no-op on the existing tables.
4. **Immediately** `wrangler deploy`.
5. Smoke checks:
   - `GET https://api.springrenaissance.store/health` → `200 {"status":"ok"}`
   - `GET https://api.springrenaissance.store/api/user?auth_token=x` →
     `401 {"error":"Session expired"}` (legacy path alive, reads `legacy_users`)
   - `GET https://api.springrenaissance.store/api/me` → `401` in the
     `{ "error": { "code": "unauthenticated", … } }` shape
   - Stripe Dashboard (test mode) → send a test event to the webhook → 2xx
     or the handler's expected `ignored` answer, not a 500.

## Rollback

Do both halves back to back, for the same reason as above.

**A. Preferred — Time Travel + previous Worker version:**
```bash
wrangler rollback V_OLD
wrangler d1 time-travel restore spring-renaissance --bookmark=B_OLD
```
Restores the whole database to the moment before step 3; anything written
since is lost.

**B. Right after rollout, if Time Travel is unavailable** (drops the new,
still-empty portal tables and renames `legacy_users` back):
```bash
wrangler d1 execute spring-renaissance --remote --file=scripts/rollback/s1_down.sql
wrangler rollback V_OLD
```
`scripts/rollback/s1_down.sql` is covered by test S1-M6 and was checked
locally with wrangler 4.129.0 (rollback, then migrate forward again).

## Local verification done (2026-10-15)

With `npx wrangler@4.129.0`, `--local` only, state in a temp directory:
- clean database: `d1 migrations apply --local` applies 0000–0003; all
  12 portal tables and the 5 legacy tables (`legacy_users` included) exist;
- production-shaped database (0000 applied by `d1 execute`, no
  `d1_migrations`, a row in `users` and in `processed_events`):
  `migrations apply --local` applies 0000–0003, the row is in `legacy_users`
  with its credits and Stripe id, `processed_events` is untouched, the
  customer index moved to `legacy_users`;
- rollback script, then `migrations apply` again: both clean.
