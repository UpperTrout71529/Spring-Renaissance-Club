// The members' object — member and admin endpoints (docs/tz-v2-circle.md
// §5.1, §5.3, §8). The client only ever sends a release id: variant, price and
// quantity always come from D1.

import { readJson } from "../http/body.js";
import { HttpError, badRequest, conflict, notFound } from "../http/errors.js";
import { loadSettings } from "../circle/economics-store.js";
import { minObjectPrice, objectCheck } from "../circle/economics.js";
import { claimRelease, objectView, releaseCounts, runGuard } from "../circle/member-object.js";

const GID_PRODUCT = /^gid:\/\/shopify\/Product\/\d+$/;
const GID_VARIANT = /^gid:\/\/shopify\/ProductVariant\/\d+$/;
const REQUIRED_TO_OPEN = ["price_cents", "edition_size", "unit_cost_cents", "shipping_class", "reserve_hours", "opens_at", "closes_at"];
const LOCKED_WHEN_OPEN = ["product_gid", "variant_gid", "price_cents", "edition_size", "unit_cost_cents", "shipping_class", "reserve_hours", "opens_at", "kind"];

// ---- member --------------------------------------------------------------------

export async function getObject(ctx) {
  return ctx.json(await objectView(ctx, "members_object"));
}

export async function postObjectClaim(ctx) {
  const body = await readJson(ctx.request);
  if (typeof body.release_id !== "string") throw badRequest("invalid_request", "Which release?");
  const out = await claimRelease(ctx, { releaseId: body.release_id, kind: "members_object" });
  const c = out.claim;
  return ctx.json({ status: c.status, invoice_url: c.status === "invoiced" ? c.invoice_url : null,
    reserved_until: c.status === "invoiced" ? c.reserved_until : null }, out.status);
}

// ---- admin ----------------------------------------------------------------------

async function audit(ctx, action, target, payload = null) {
  await ctx.env.DB.prepare(
    "INSERT INTO admin_audit (id, actor_email, action, target, payload_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)"
  ).bind(ctx.newId(), ctx.admin.email, action, target, payload ? JSON.stringify(payload) : null, ctx.nowIso()).run();
}

const isoOrNull = (v, key) => {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string" || Number.isNaN(Date.parse(v))) throw badRequest("invalid_date", `${key} must be a date.`);
  return new Date(v).toISOString();
};
const intOrNull = (v, key, min = 0) => {
  if (v === null || v === undefined) return null;
  if (!Number.isInteger(v) || v < min) throw badRequest("invalid_number", `${key} must be a whole number.`);
  return v;
};

function normalise(body, base = {}) {
  const r = { ...base };
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  if (has("kind")) {
    if (!["members_object", "early_access"].includes(body.kind)) throw badRequest("invalid_kind", "Unknown kind.");
    r.kind = body.kind;
  }
  if (has("label")) {
    const l = typeof body.label === "string" ? body.label.trim() : "";
    if (!l || l.length > 120) throw badRequest("invalid_label", "A label of up to 120 characters.");
    r.label = l;
  }
  for (const k of ["public_title", "description", "ships_note"]) {
    if (has(k)) r[k] = body[k] === null ? null : String(body[k]).trim().slice(0, k === "description" ? 2000 : 200) || null;
  }
  if (has("image_url")) {
    if (body.image_url !== null && !/^https:\/\/[^\s"'<>]+$/.test(String(body.image_url))) throw badRequest("invalid_image", "An https image link.");
    r.image_url = body.image_url;
  }
  if (has("product_gid")) {
    if (!GID_PRODUCT.test(String(body.product_gid))) throw badRequest("invalid_product", "A Shopify product id.");
    r.product_gid = body.product_gid;
  }
  if (has("variant_gid")) {
    if (!GID_VARIANT.test(String(body.variant_gid))) throw badRequest("invalid_variant", "A Shopify variant id.");
    r.variant_gid = body.variant_gid;
  }
  if (has("price_cents")) r.price_cents = intOrNull(body.price_cents, "price_cents", 1);
  if (has("edition_size")) r.edition_size = intOrNull(body.edition_size, "edition_size", 1);
  if (has("unit_cost_cents")) r.unit_cost_cents = intOrNull(body.unit_cost_cents, "unit_cost_cents", 0);
  if (has("reserve_hours")) r.reserve_hours = intOrNull(body.reserve_hours, "reserve_hours", 1);
  if (has("shipping_class")) {
    if (body.shipping_class !== null && !["S", "M", "L"].includes(body.shipping_class)) throw badRequest("invalid_shipping_class", "S, M or L.");
    r.shipping_class = body.shipping_class;
  }
  for (const k of ["opens_at", "closes_at", "public_release_at"]) if (has(k)) r[k] = isoOrNull(body[k], k);
  if (has("show_remaining")) r.show_remaining = body.show_remaining === true ? 1 : 0;
  for (const k of ["label", "product_gid", "variant_gid"]) if (!r[k]) throw badRequest("missing_field", `${k} is required.`);
  r.kind = r.kind || "members_object";
  return r;
}

async function enrich(env, settings, rel) {
  const min = minObjectPrice({ costCents: rel.unit_cost_cents, shippingClass: rel.shipping_class }, settings);
  return {
    ...rel, show_remaining: !!rel.show_remaining, guard_ok: !!rel.guard_ok,
    guard_reasons: rel.guard_reasons ? JSON.parse(rel.guard_reasons) : [],
    min_price_cents: min, claims: await releaseCounts(env, rel.id),
  };
}

export async function listReleases(ctx) {
  const { env, json } = ctx;
  const { settings } = await loadSettings(env);
  const { results } = await env.DB.prepare("SELECT * FROM member_object_releases ORDER BY created_at DESC").all();
  return json({ releases: await Promise.all(results.map((r) => enrich(env, settings, r))) });
}

const COLUMNS = ["kind", "label", "public_title", "description", "image_url", "product_gid", "variant_gid", "price_cents", "edition_size",
  "unit_cost_cents", "shipping_class", "reserve_hours", "opens_at", "closes_at", "show_remaining", "public_release_at", "ships_note"];

export async function createRelease(ctx) {
  const { env } = ctx;
  const r = normalise(await readJson(ctx.request));
  const id = ctx.newId();
  const nowIso = ctx.nowIso();
  await env.DB.prepare(
    `INSERT INTO member_object_releases (id, ${COLUMNS.join(", ")}, status, created_at, updated_at)
     VALUES (?1, ${COLUMNS.map((_, i) => `?${i + 2}`).join(", ")}, 'draft', ?${COLUMNS.length + 2}, ?${COLUMNS.length + 2})`
  ).bind(id, ...COLUMNS.map((k) => (r[k] === undefined ? (k === "show_remaining" ? 0 : null) : r[k])), nowIso).run();
  await audit(ctx, "release_created", id, r);
  const rel = await env.DB.prepare("SELECT * FROM member_object_releases WHERE id = ?1").bind(id).first();
  return ctx.json({ release: rel }, 201);
}

export async function patchRelease(ctx) {
  const { env, params } = ctx;
  const rel = await env.DB.prepare("SELECT * FROM member_object_releases WHERE id = ?1").bind(params.id).first();
  if (!rel) throw notFound();
  const body = await readJson(ctx.request);
  if (rel.status !== "draft") {
    const locked = Object.keys(body).filter((k) => LOCKED_WHEN_OPEN.includes(k));
    if (locked.length) throw conflict("release_locked", `These cannot change after opening: ${locked.join(", ")}.`);
  }
  const r = normalise(body, rel);
  await env.DB.prepare(
    `UPDATE member_object_releases SET ${COLUMNS.map((k, i) => `${k} = ?${i + 1}`).join(", ")}, updated_at = ?${COLUMNS.length + 1}
     WHERE id = ?${COLUMNS.length + 2}`
  ).bind(...COLUMNS.map((k) => (r[k] === undefined ? null : r[k])), ctx.nowIso(), rel.id).run();
  await audit(ctx, "release_updated", rel.id, body);
  return ctx.json({ release: await env.DB.prepare("SELECT * FROM member_object_releases WHERE id = ?1").bind(rel.id).first() });
}

export async function openReleaseNow(ctx) {
  const { env, params } = ctx;
  const rel = await env.DB.prepare("SELECT * FROM member_object_releases WHERE id = ?1").bind(params.id).first();
  if (!rel) throw notFound();
  if (rel.status === "open") throw conflict("already_open", "This release is open.");
  const missing = REQUIRED_TO_OPEN.filter((k) => rel[k] === null || rel[k] === undefined);
  if (missing.length) {
    const e = new HttpError(422, "release_incomplete", "Fill in every figure before opening.");
    e.explanation = { missing };
    throw e;
  }
  if (rel.closes_at <= rel.opens_at) throw new HttpError(422, "release_incomplete", "The release must close after it opens.");
  const { settings } = await loadSettings(env);
  const check = objectCheck({ priceCents: rel.price_cents, costCents: rel.unit_cost_cents, shippingClass: rel.shipping_class }, settings);
  if (!check.ok) {
    const e = new HttpError(422, "price_below_minimum", "At this price the piece would not keep the minimum margin.");
    e.explanation = { ...check, min_price_cents: minObjectPrice({ costCents: rel.unit_cost_cents, shippingClass: rel.shipping_class }, settings) };
    throw e;
  }
  const g = await runGuard(ctx, rel);
  if (!g.ok) {
    const e = new HttpError(422, "guard_failed", "The product is not safe to sell only through the portal yet.");
    e.explanation = { reasons: g.reasons };
    throw e;
  }
  const year = rel.opens_at.slice(0, 4);
  const other = await env.DB.prepare(
    "SELECT 1 AS yes FROM member_object_releases WHERE id <> ?1 AND kind = ?2 AND status IN ('open','closed') AND substr(opens_at, 1, 4) = ?3 LIMIT 1"
  ).bind(rel.id, rel.kind, year).first();
  await env.DB.prepare("UPDATE member_object_releases SET status = 'open', guard_ok = 1, guard_checked_at = ?1, guard_reasons = '[]', updated_at = ?1 WHERE id = ?2")
    .bind(ctx.nowIso(), rel.id).run();
  await audit(ctx, "release_opened", rel.id, null);
  return ctx.json({ status: "open", warning: other && rel.kind === "members_object" ? "This is the second release this year (the object is one a year)." : null });
}

export async function closeRelease(ctx) {
  const { env, params } = ctx;
  const res = await env.DB.prepare("UPDATE member_object_releases SET status = 'closed', updated_at = ?1 WHERE id = ?2 AND status = 'open'")
    .bind(ctx.nowIso(), params.id).run();
  if (!res.meta || res.meta.changes !== 1) throw conflict("not_open", "This release is not open.");
  await audit(ctx, "release_closed", params.id, null);
  return ctx.json({ status: "closed" });
}

export async function getReleaseGuard(ctx) {
  const { env, url } = ctx;
  const rel = await env.DB.prepare("SELECT * FROM member_object_releases WHERE id = ?1").bind(url.searchParams.get("release") || "").first();
  if (!rel) throw notFound();
  return ctx.json(await runGuard(ctx, rel));
}
