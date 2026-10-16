// Admin v1 (spec §12, §8.6): read-only views for Felix. Every route here is
// declared with auth: "admin" — the Access JWT is verified before the handler
// runs (src/admin/access.js). V2 fields (membership, credits, next charge)
// are present and null, so the page does not change shape when V2 lands.

import { badRequest, notFound } from "../http/errors.js";
import { computeMetrics, parseRange } from "../admin/metrics.js";

const PAGE_SIZE = 50;
const LOG_LIMIT = 100;

async function audit(ctx, action, target, payload = null) {
  await ctx.env.DB.prepare(
    "INSERT INTO admin_audit (id, actor_email, action, target, payload_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)"
  ).bind(ctx.newId(), ctx.admin.email, action, target, payload ? JSON.stringify(payload) : null, ctx.nowIso()).run();
}

const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export async function listMembers(ctx) {
  const { env, url, json } = ctx;
  const q = (url.searchParams.get("q") || "").trim().slice(0, 100);
  const tier = url.searchParams.get("tier") || "";
  if (tier && !["club", "vip"].includes(tier)) throw badRequest("invalid_tier", "Unknown tier.");
  const page = Math.max(1, Math.min(1000, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1));

  const where = ["deleted_at IS NULL"];
  const args = [];
  if (q) {
    args.push(`%${escapeLike(q)}%`);
    const n = args.length;
    where.push(`(email LIKE ?${n} ESCAPE '\\' OR first_name LIKE ?${n} ESCAPE '\\' OR last_name LIKE ?${n} ESCAPE '\\'
      OR (COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')) LIKE ?${n} ESCAPE '\\')`);
  }
  if (tier) {
    args.push(tier);
    where.push(`tier = ?${args.length}`);
  }
  args.push(PAGE_SIZE + 1, (page - 1) * PAGE_SIZE);
  const { results } = await env.DB.prepare(
    `SELECT id, email, first_name, last_name, tier, created_at, last_login_at FROM users
     WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?${args.length - 1} OFFSET ?${args.length}`
  ).bind(...args).all();

  const members = results.slice(0, PAGE_SIZE).map((u) => ({
    id: u.id, email: u.email, first_name: u.first_name, last_name: u.last_name,
    tier: u.tier, status: null, since: u.created_at, last_login_at: u.last_login_at,
    credits_balance_cents: null, next_charge_at: null,
  }));
  return json({ members, page, has_more: results.length > PAGE_SIZE });
}

// https://admin.shopify.com/store/<handle>/customers/<numeric id>
function shopifyAdminUrl(env, customerGid) {
  const id = /\/Customer\/(\d+)$/.exec(customerGid || "");
  const handle = String(env.SHOPIFY_SHOP || "").replace(/\.myshopify\.com$/, "");
  return id && handle ? `https://admin.shopify.com/store/${handle}/customers/${id[1]}` : null;
}

export async function getMember(ctx) {
  const { env, params, json } = ctx;
  const user = await env.DB.prepare(
    `SELECT id, email, email_verified_at, first_name, last_name, shopify_customer_id, tier, seasonal_email_opt_in,
            circle_teaser_snoozed_until, created_at, last_login_at, deleted_at FROM users WHERE id = ?1`
  ).bind(params.id).first();
  if (!user) throw notFound();
  const nowIso = ctx.nowIso();
  const all = (sql, ...a) => env.DB.prepare(sql).bind(...a).all().then((r) => r.results);

  const [consents, sessions, passkeys, saved, holds, emails, events] = await Promise.all([
    all("SELECT kind, document_version, granted, created_at FROM consents WHERE user_id = ?1 ORDER BY created_at DESC", user.id),
    all(`SELECT auth_method, ua_summary, geo_city, created_at, last_seen_at FROM sessions
         WHERE user_id = ?1 AND revoked_at IS NULL AND idle_expires_at > ?2 AND absolute_expires_at > ?2
         ORDER BY last_seen_at DESC`, user.id, nowIso),
    all("SELECT device_label, created_at, last_used_at FROM passkeys WHERE user_id = ?1 ORDER BY created_at", user.id),
    all("SELECT product_handle, created_at FROM wishlist_items WHERE user_id = ?1 ORDER BY created_at DESC", user.id),
    all("SELECT kind, product_handle, source, status, created_at FROM holds WHERE user_id = ?1 ORDER BY created_at DESC", user.id),
    all("SELECT template, status, created_at FROM email_log WHERE user_id = ?1 ORDER BY created_at DESC LIMIT 20", user.id),
    all("SELECT name, props_json, created_at FROM events WHERE user_id = ?1 ORDER BY created_at DESC LIMIT 20", user.id),
  ]);

  await audit(ctx, "member_viewed", user.id);
  return json({
    user, membership: null, credits: null,
    shopify_admin_url: shopifyAdminUrl(env, user.shopify_customer_id),
    consents, sessions, passkeys, saved, holds, emails, events,
  });
}

const WEBHOOK_STATUSES = ["received", "processed", "failed", "ignored"];

export async function listWebhooks(ctx) {
  const status = ctx.url.searchParams.get("status") || "";
  if (status && !WEBHOOK_STATUSES.includes(status)) throw badRequest("invalid_status", "Unknown status.");
  const stmt = status
    ? ctx.env.DB.prepare(`SELECT event_id, source, type, received_at, processed_at, status, error FROM webhook_events
        WHERE status = ?1 ORDER BY received_at DESC LIMIT ${LOG_LIMIT}`).bind(status)
    : ctx.env.DB.prepare(`SELECT event_id, source, type, received_at, processed_at, status, error FROM webhook_events
        ORDER BY received_at DESC LIMIT ${LOG_LIMIT}`);
  return ctx.json({ webhooks: (await stmt.all()).results });
}

export async function listEmails(ctx) {
  const { results } = await ctx.env.DB.prepare(
    `SELECT e.template, e.status, e.created_at, e.user_id, u.email FROM email_log e LEFT JOIN users u ON u.id = e.user_id
     ORDER BY e.created_at DESC, e.id DESC LIMIT ${LOG_LIMIT}`
  ).all();
  return ctx.json({ emails: results });
}

export async function listAudit(ctx) {
  const { results } = await ctx.env.DB.prepare(
    `SELECT actor_email, action, target, payload_json, created_at FROM admin_audit ORDER BY created_at DESC, id DESC LIMIT ${LOG_LIMIT}`
  ).all();
  return ctx.json({ audit: results });
}

export async function getMetrics(ctx) {
  const range = parseRange(ctx.url.searchParams, ctx.now());
  return ctx.json(await computeMetrics(ctx.env.DB, range));
}

// The admin page: files under public/admin/ (Workers Static Assets, binding
// ASSETS). wrangler.toml sends /admin* to the Worker first, so the gate runs
// before any file is served.
const ADMIN_FILE = /^[a-z0-9-]+\.(html|js|css|svg)$/;
const ADMIN_CSP = [
  "default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:",
  "connect-src 'self'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
].join("; ");

export async function serveAdmin(ctx) {
  const file = ctx.params.file || "index.html";
  if (!ADMIN_FILE.test(file) || !ctx.env.ASSETS) throw notFound();
  const res = await ctx.env.ASSETS.fetch(new Request(new URL(`/admin/${file}`, ctx.url), { method: "GET" }));
  if (!res.ok) throw notFound();
  const out = new Response(res.body, res);
  out.headers.set("Content-Security-Policy", ADMIN_CSP);
  out.headers.set("X-Frame-Options", "DENY");
  return out;
}
