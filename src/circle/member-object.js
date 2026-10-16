// The members' object (docs/tz-v2-circle.md §8; Felix §19 #3/#4).
// Purchase only from the portal: active membership in D1 → one atomic insert
// (open release, room in the edition, one active claim per member) → a draft
// order at the D1 price with automatic discounts and codes refused → the
// invoice link. Expired reservations free their slot and the member may claim
// again; a paid claim is final. kind = 'early_access' reuses all of this (T21).

import { HttpError, conflict, forbidden, notFound } from "../http/errors.js";
import { shopifyConfigured } from "../shopify/admin.js";
import { createDraftOrder, deleteDraftOrder, draftOrderState } from "../shopify/draft-orders.js";
import { guardProduct } from "../shopify/object-guard.js";
import { shopifyGraphql } from "../shopify/admin.js";
import { emailUser, raiseFlag } from "./notify.js";
import { longDate } from "../email/templates/circle.js";

const HOUR_MS = 60 * 60 * 1000;
const ACTIVE = ["creating", "invoiced", "paid"];

export async function releaseCounts(env, releaseId) {
  const { results } = await env.DB.prepare("SELECT status, COUNT(*) AS n FROM member_object_claims WHERE release_id = ?1 GROUP BY status")
    .bind(releaseId).all();
  const out = { creating: 0, invoiced: 0, paid: 0, expired: 0, failed: 0, cancelled: 0 };
  for (const r of results) out[r.status] = r.n;
  return out;
}

const taken = (c) => c.creating + c.invoiced + c.paid;

// The release open now for this kind, if any.
export async function openRelease(env, kind, nowIso) {
  return env.DB.prepare(
    `SELECT * FROM member_object_releases WHERE kind = ?1 AND status = 'open' AND opens_at <= ?2 AND closes_at > ?2
      ORDER BY opens_at DESC LIMIT 1`
  ).bind(kind, nowIso).first();
}

async function liveStatus(env, userId) {
  const m = await env.DB.prepare(
    "SELECT status FROM memberships WHERE user_id = ?1 AND status IN ('pending','active','past_due','canceling') ORDER BY created_at DESC LIMIT 1"
  ).bind(userId).first();
  return m ? m.status : null;
}

function claimView(c) {
  if (!c) return null;
  return {
    status: c.status,
    reserved_until: c.status === "invoiced" ? c.reserved_until : null,
    invoice_url: c.status === "invoiced" ? c.invoice_url : null,
  };
}

async function latestClaim(env, releaseId, userId) {
  return env.DB.prepare("SELECT * FROM member_object_claims WHERE release_id = ?1 AND user_id = ?2 ORDER BY created_at DESC LIMIT 1")
    .bind(releaseId, userId).first();
}

export async function objectView(ctx, kind) {
  const { env, session } = ctx;
  const nowIso = ctx.nowIso();
  const rel = await openRelease(env, kind, nowIso);
  if (!rel) return { release: null, claim: null, can_claim: false, reason: "no_release" };
  const counts = await releaseCounts(env, rel.id);
  const left = Math.max(0, rel.edition_size - taken(counts));
  const claim = await latestClaim(env, rel.id, session.user.id);
  const status = await liveStatus(env, session.user.id);
  let reason = null;
  if (status !== "active") reason = "members_only";
  else if (claim && ACTIVE.includes(claim.status)) reason = "already_claimed";
  else if (!rel.guard_ok) reason = "paused";
  else if (left === 0) reason = "sold_out";
  const release = {
    id: rel.id, title: rel.public_title || null, description: rel.description, image_url: rel.image_url,
    price_cents: rel.price_cents, closes_at: rel.closes_at, sold_out: left === 0, one_per_member: true,
    ...(rel.show_remaining ? { remaining: left } : {}),
    ...(kind === "early_access" ? { public_release_at: rel.public_release_at, ships_note: rel.ships_note } : {}),
  };
  return { release, claim: claimView(claim), can_claim: reason === null, reason };
}

const unavailable = () => new HttpError(503, "object_unavailable", "We couldn't reserve the piece just now. Please try again in a moment.");

// Creates (or returns) the member's claim. extra: { lineOverride(rel) } for early access.
export async function claimRelease(ctx, { releaseId, kind, priceFor = (rel) => rel.price_cents, note = "Circle members' object", tags = ["circle-object"] }) {
  const { env, session } = ctx;
  const userId = session.user.id;
  const nowMs = ctx.now();
  const nowIso = ctx.nowIso();
  const rel = await env.DB.prepare("SELECT * FROM member_object_releases WHERE id = ?1 AND kind = ?2").bind(releaseId, kind).first();
  if (!rel) throw notFound();
  if (rel.status !== "open" || rel.opens_at > nowIso || rel.closes_at <= nowIso) throw conflict("release_closed", "This release has closed.");
  if ((await liveStatus(env, userId)) !== "active") throw forbidden("members_only", "This piece is for active members of the Circle.");
  const existing = await latestClaim(env, rel.id, userId);
  if (existing && ACTIVE.includes(existing.status)) return { status: 200, claim: existing };
  if (!rel.guard_ok) throw conflict("release_paused", "This release is paused for a moment.");
  if (!shopifyConfigured(env)) throw unavailable();

  const id = ctx.newId();
  const price = priceFor(rel);
  const reservedUntil = new Date(nowMs + rel.reserve_hours * HOUR_MS).toISOString();
  let ins;
  try {
    ins = await env.DB.prepare(
      `INSERT INTO member_object_claims (id, release_id, user_id, status, price_cents, reserved_until, created_at, updated_at)
       SELECT ?1, ?2, ?3, 'creating', ?4, ?5, ?6, ?6
        WHERE (SELECT COUNT(*) FROM member_object_claims WHERE release_id = ?2 AND status IN ('creating','invoiced','paid')) < ?7`
    ).bind(id, rel.id, userId, price, reservedUntil, nowIso, rel.edition_size).run();
  } catch (e) {
    if (/UNIQUE/i.test(String(e && e.message))) {
      const c = await latestClaim(env, rel.id, userId);
      if (c) return { status: 200, claim: c };
    }
    throw e;
  }
  if (!ins.meta || ins.meta.changes !== 1) throw conflict("sold_out", "All pieces in this edition have found homes.");

  const customer = await env.DB.prepare("SELECT shopify_customer_id FROM users WHERE id = ?1").bind(userId).first();
  let draft;
  try {
    draft = await createDraftOrder(env, ctx.fetch, {
      customerId: customer && customer.shopify_customer_id,
      lines: [{ variantId: rel.variant_gid, quantity: 1, priceOverrideCents: price }],
      shipping: null,
      shippingTitle: "Circle",
      tags: [...tags, `circle-claim-${id}`],
      note: `${note} · ${rel.label} · claim ${id}`,
      reserveUntil: reservedUntil,
    });
  } catch (e) {
    console.error("object draft failed", e && e.message);
    await env.DB.prepare("UPDATE member_object_claims SET status = 'failed', updated_at = ?1 WHERE id = ?2").bind(ctx.nowIso(), id).run();
    throw unavailable();
  }
  await env.DB.prepare(
    "UPDATE member_object_claims SET status = 'invoiced', draft_order_gid = ?1, invoice_url = ?2, updated_at = ?3 WHERE id = ?4 AND status = 'creating'"
  ).bind(draft.id, draft.invoiceUrl, ctx.nowIso(), id).run();
  ctx.waitUntil(emailUser(ctx, userId, "object_invoice", `object_invoice:${id}`,
    { invoiceUrl: draft.invoiceUrl, reservedUntil: longDate(reservedUntil.slice(0, 10)) }));
  return { status: 201, claim: { status: "invoiced", invoice_url: draft.invoiceUrl, reserved_until: reservedUntil } };
}

// ---- cron and webhooks --------------------------------------------------------------

const DRAFT_BY_TAG = `query CircleDraftByTag($query: String!) { draftOrders(first: 1, query: $query) { nodes { id status invoiceUrl order { id } } } }`;

// Every 5 minutes: paid drafts → paid; past their window → draft deleted,
// slot freed; a claim stuck in 'creating' (crash mid-way) is recovered by tag.
export async function expireClaims(svc) {
  const { env } = svc;
  if (!shopifyConfigured(env)) return { skipped: "shopify" };
  const nowIso = svc.nowIso();
  const due = (await env.DB.prepare(
    "SELECT * FROM member_object_claims WHERE status = 'invoiced' AND reserved_until <= ?1 ORDER BY reserved_until LIMIT 10"
  ).bind(nowIso).all()).results;
  let paid = 0;
  let expired = 0;
  for (const c of due) {
    try {
      const st = await draftOrderState(env, svc.fetch, c.draft_order_gid);
      if (st && st.orderId) {
        await env.DB.prepare("UPDATE member_object_claims SET status = 'paid', order_gid = ?1, updated_at = ?2 WHERE id = ?3 AND status = 'invoiced'")
          .bind(st.orderId, nowIso, c.id).run();
        paid++;
        continue;
      }
      if (st) await deleteDraftOrder(env, svc.fetch, c.draft_order_gid);
      await env.DB.prepare("UPDATE member_object_claims SET status = 'expired', updated_at = ?1 WHERE id = ?2 AND status = 'invoiced'")
        .bind(nowIso, c.id).run();
      expired++;
    } catch (e) {
      console.error("claim expiry failed", c.id, e && e.message);
    }
  }
  const stuck = (await env.DB.prepare(
    "SELECT * FROM member_object_claims WHERE status = 'creating' AND created_at <= ?1 LIMIT 5"
  ).bind(new Date(svc.now() - 10 * 60 * 1000).toISOString()).all()).results;
  for (const c of stuck) {
    try {
      const data = await shopifyGraphql(env, svc.fetch, DRAFT_BY_TAG, { query: `tag:circle-claim-${c.id}` });
      const d = data.draftOrders && data.draftOrders.nodes && data.draftOrders.nodes[0];
      if (d) {
        await env.DB.prepare("UPDATE member_object_claims SET status = 'invoiced', draft_order_gid = ?1, invoice_url = ?2, updated_at = ?3 WHERE id = ?4 AND status = 'creating'")
          .bind(d.id, d.invoiceUrl, nowIso, c.id).run();
      } else {
        await env.DB.prepare("UPDATE member_object_claims SET status = 'failed', updated_at = ?1 WHERE id = ?2 AND status = 'creating'").bind(nowIso, c.id).run();
      }
    } catch (e) {
      console.error("stuck claim check failed", c.id, e && e.message);
    }
  }
  return { paid, expired, stuck: stuck.length };
}

// draft_orders/update: a completed draft marks its claim paid.
export async function onDraftOrderUpdate(svc, draftGid) {
  const { env } = svc;
  const c = await env.DB.prepare("SELECT * FROM member_object_claims WHERE draft_order_gid = ?1").bind(draftGid).first();
  if (!c) return "ignored";
  if (c.status !== "invoiced") return "processed";
  const st = await draftOrderState(env, svc.fetch, draftGid);
  if (st && st.orderId) {
    await env.DB.prepare("UPDATE member_object_claims SET status = 'paid', order_gid = ?1, updated_at = ?2 WHERE id = ?3 AND status = 'invoiced'")
      .bind(st.orderId, svc.nowIso(), c.id).run();
  }
  return "processed";
}

// Daily, and before opening: the guard on every open release; a failure pauses claims.
export async function guardReleases(svc) {
  const { env } = svc;
  const open = (await env.DB.prepare("SELECT * FROM member_object_releases WHERE status = 'open'").all()).results;
  let failed = 0;
  for (const rel of open) {
    const g = await runGuard(svc, rel);
    await env.DB.prepare("UPDATE member_object_releases SET guard_ok = ?1, guard_checked_at = ?2, guard_reasons = ?3 WHERE id = ?4")
      .bind(g.ok ? 1 : 0, svc.nowIso(), JSON.stringify(g.reasons), rel.id).run();
    if (!g.ok) {
      failed++;
      await raiseFlag(svc, {
        kind: "object_guard_failed", dedupeKey: `object_guard_failed:${rel.id}:${svc.nowIso().slice(0, 10)}`, ref: rel.id,
        title: "A members' release is paused",
        lines: [`The guard for "${rel.label}" failed: ${g.reasons.join(", ")}. Claims are paused until it passes.`,
          "Unpublish the product from every sales channel, keep it active, tracked and set to DENY."],
      });
    }
  }
  return { releases: open.length, failed };
}

export async function runGuard(svc, rel) {
  if (!shopifyConfigured(svc.env)) {
    return svc.env.CIRCLE_OBJECT_GUARD === "skip-staging" ? { ok: true, reasons: [] } : { ok: false, reasons: ["shopify_not_configured"] };
  }
  try {
    return await guardProduct(svc.env, svc.fetch, rel.product_gid, rel.variant_gid);
  } catch (e) {
    return { ok: false, reasons: ["shopify_unreachable"] };
  }
}

// orders/create: an order with a release variant must carry the tag of a
// claim that belongs to the buyer; otherwise someone got around the portal.
export async function objectOrderCheck(svc, { order, user }) {
  const { env } = svc;
  const lineVariants = ((order.lineItems && order.lineItems.nodes) || []).map((l) => l.variant && l.variant.id).filter(Boolean);
  if (!lineVariants.length) return;
  const { results } = await env.DB.prepare(
    "SELECT id, variant_gid FROM member_object_releases WHERE variant_gid IN (SELECT value FROM json_each(?1))"
  ).bind(JSON.stringify(lineVariants)).all();
  if (!results.length) return;
  const claimIds = (order.tags || []).map((t) => (/^circle-claim-([0-9A-Z]{26})$/.exec(t) || [])[1]).filter(Boolean);
  let legit = false;
  if (claimIds.length && user) {
    const c = await env.DB.prepare(
      "SELECT 1 AS yes FROM member_object_claims WHERE id IN (SELECT value FROM json_each(?1)) AND user_id = ?2 LIMIT 1"
    ).bind(JSON.stringify(claimIds), user.id).first();
    legit = !!c;
  }
  if (!legit) {
    await raiseFlag(svc, {
      kind: "object_bypass", dedupeKey: `object_bypass:${order.id}`, userId: user ? user.id : null, ref: order.id,
      title: "A members' object was ordered outside the portal",
      lines: [`Order ${order.id} contains a members' object without a matching claim. Check it in Shopify before fulfilling.`],
    });
  }
}
