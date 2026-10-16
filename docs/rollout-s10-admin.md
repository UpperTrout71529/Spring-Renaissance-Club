# S10 rollout — admin behind Cloudflare Access, Shopify orders webhook

Nothing here has been done. Each step changes Cloudflare or Shopify, so Felix
does it (or says "yes" for Claude to walk through it). Code is ready in
`feat/lk-v1`; it fails closed until the steps are done (admin → 403, webhook →
401).

Prerequisite: P0.2, the Worker on `api.springrenaissance.store` (Custom
Domain). Access protects a hostname, and the admin lives on that hostname.

## 1. Cloudflare Access application (P0.8)

Docs: <https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/>
and validating the JWT: <https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/>

1. Zero Trust → Access → Applications → add a **self-hosted** application
   named "SR Admin" with two public hostnames on
   `api.springrenaissance.store`: path `admin` and path `api/admin`
   (`/admin*` and `/api/admin/*` must both be covered — the Worker checks
   both, but Access is what shows the sign-in page).
2. Policy (reusable, Allow): **Emails** = Felix's address. Login method:
   one-time PIN (§12). Session duration: Felix's choice (24 hours is usual).
3. Copy the application's **AUD tag** (application → Overview / Basic
   information) and the **team domain** (`https://<team>.cloudflareaccess.com`,
   Zero Trust → Settings).
4. Worker → Settings → Variables (plain text, not secret):
   - `ACCESS_TEAM_DOMAIN` = `https://<team>.cloudflareaccess.com`
   - `ACCESS_AUD` = the AUD tag
   - `ADMIN_EMAILS` = Felix's address (comma-separate more if ever needed)
   Or add them to `[vars]` in `wrangler.toml` before the deploy — they are not
   secret.

Check after the S11 deploy:
- `https://api.springrenaissance.store/admin` asks for the email code, then
  shows Overview.
- `curl -i https://<worker>.workers.dev/api/admin/members` → **403**
  (no Access there, the Worker refuses on its own).

## 2. Shopify `orders/create` webhook

Docs: <https://shopify.dev/docs/apps/build/webhooks/subscribe>

The Worker must be deployed first (S11), or Shopify's deliveries fail and it
eventually drops the subscription.

Either way works; the signing secret differs:

- **A. Store webhook** — Shopify admin → Settings → Notifications →
  Webhooks → Create webhook: event *Order creation*, format JSON, URL
  `https://api.springrenaissance.store/webhooks/shopify`, latest API version.
  The page shows the signing key → `wrangler secret put SHOPIFY_WEBHOOK_SECRET`.
- **B. App subscription** — through the "Claude Sync" app (its app config or
  `webhookSubscriptionCreate`). Shopify then signs with the app's **client
  secret** → `SHOPIFY_WEBHOOK_SECRET` = the same value as
  `SHOPIFY_CLIENT_SECRET`.

Scopes needed by the handler (already granted to Claude Sync): `read_orders`,
`read_customers`, `read_products`.

Check: place a test order (or "Send test notification" for A — that one is
signed but its order does not exist, so it ends as `failed` in Admin → System,
which also proves the signature check passed). A real order shows in Admin →
Overview → Orders and in System → Webhooks as `processed`.

## Rollback

- Admin: remove the Access application → the Worker answers 403 on every
  admin path (it needs the JWT); nothing else depends on it.
- Webhook: delete the subscription. Rows already written (`order_placed`
  events, `webhook_events`) stay; they are analytics only.
