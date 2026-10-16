// POST /webhooks/stripe — the Circle's Stripe endpoint (docs/tz-v2-circle.md
// §6.1). Its own signing secret STRIPE_CIRCLE_WEBHOOK_SECRET (the legacy
// handler owns STRIPE_WEBHOOK_SECRET); no secret → 503, never "trust".
// livemode must match the environment (test unless CIRCLE_STRIPE_LIVE=on);
// a mismatch is acknowledged and ignored. Ledger: webhook_events
// (source 'stripe') — received → processed / ignored, or failed + 500 so
// Stripe retries; a redelivery of a processed event answers 200.

import { HttpError, badRequest } from "../http/errors.js";
import { verifyStripeSignature } from "../stripe/signature.js";
import { processStripeEvent } from "../circle/stripe-events.js";

const MAX_BODY_BYTES = 512 * 1024;

export async function stripeWebhook(ctx) {
  const { env, request, json } = ctx;
  const declared = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new HttpError(413, "payload_too_large", "The request is too large.");
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) throw new HttpError(413, "payload_too_large", "The request is too large.");

  if (!env.STRIPE_CIRCLE_WEBHOOK_SECRET) throw new HttpError(503, "webhook_not_configured", "Webhook verification is not configured.");
  const ok = await verifyStripeSignature(raw, request.headers.get("Stripe-Signature"), env.STRIPE_CIRCLE_WEBHOOK_SECRET, Math.floor(ctx.now() / 1000));
  if (!ok) throw badRequest("invalid_signature", "The webhook signature is not valid.");

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    throw badRequest("invalid_payload", "The webhook body is not valid JSON.");
  }
  if (!event || typeof event.id !== "string" || typeof event.type !== "string") throw badRequest("invalid_payload", "Not a Stripe event.");

  const nowIso = ctx.nowIso();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO webhook_events (event_id, source, type, received_at, status) VALUES (?1, 'stripe', ?2, ?3, 'received')"
  ).bind(event.id, event.type, nowIso).run();
  const row = await env.DB.prepare("SELECT status FROM webhook_events WHERE event_id = ?1").bind(event.id).first();
  if (row && (row.status === "processed" || row.status === "ignored")) return json({ ok: true, duplicate: true });

  const done = (status, error = null) => env.DB.prepare(
    "UPDATE webhook_events SET status = ?1, processed_at = ?2, error = ?3 WHERE event_id = ?4"
  ).bind(status, ctx.nowIso(), error, event.id).run();

  const live = env.CIRCLE_STRIPE_LIVE === "on";
  if (event.livemode !== live) {
    await done("ignored", "livemode mismatch");
    return json({ ok: true, ignored: true });
  }

  try {
    const outcome = await processStripeEvent(ctx, event);
    await done(outcome === "ignored" ? "ignored" : "processed");
    return json({ ok: true, ignored: outcome === "ignored" || undefined });
  } catch (e) {
    const reason = String((e && e.message) || "error").slice(0, 200);
    console.error("stripe webhook failed", event.type, reason);
    await done("failed", reason);
    return json({ error: { code: "webhook_failed", message: "Processing failed; Stripe will retry." } }, 500);
  }
}
