// GET /api/me (spec §8.3). V1 shape: membership is always null and the Circle
// badge always false until V2 adds memberships. `user.created_at` drives
// "Club member since …" on Home (§6.3); `onboarding.dismissed` hides the
// "Make it yours" card (§6.10).

import { badRequest } from "../http/errors.js";
import { readJson } from "../http/body.js";
import { recordEvent } from "../lib/events.js";

export async function getMe({ env, session, json }) {
  const { user } = session;
  const row = await env.DB.prepare(
    `SELECT u.created_at, u.onboarding_dismissed_at,
            EXISTS (SELECT 1 FROM passkeys WHERE user_id = ?1) AS passkey,
            EXISTS (SELECT 1 FROM wishlist_items WHERE user_id = ?1) AS saved
       FROM users u WHERE u.id = ?1`
  ).bind(user.id).first();

  return json({
    user: { id: user.id, email: user.email, first_name: user.first_name, tier: user.tier, created_at: row.created_at },
    membership: null,
    badges: { circle: false },
    onboarding: { passkey: !!row.passkey, saved: !!row.saved, dismissed: !!row.onboarding_dismissed_at },
  });
}

// PATCH /api/me (spec §8.3). So far: { onboarding_dismissed: true } (S6) and
// { circle_teaser_snooze: true } (S8, "Not now" for 30 days); names and the
// seasonal email arrive with S9. Unknown fields are refused, not ignored.
const SUPPORTED = new Set(["onboarding_dismissed", "circle_teaser_snooze"]);
const SNOOZE_MS = 30 * 24 * 60 * 60 * 1000;

export async function patchMe(ctx) {
  const body = await readJson(ctx.request);
  const keys = Object.keys(body);
  const invalid = () => badRequest("invalid_fields", "Some of these fields can't be changed here.");
  if (!keys.length || keys.some((k) => !SUPPORTED.has(k) || body[k] !== true)) throw invalid();

  const { env, session } = ctx;
  if (body.onboarding_dismissed) {
    await env.DB.prepare(
      "UPDATE users SET onboarding_dismissed_at = COALESCE(onboarding_dismissed_at, ?1) WHERE id = ?2"
    ).bind(ctx.nowIso(), session.user.id).run();
  }
  if (body.circle_teaser_snooze) {
    await env.DB.prepare("UPDATE users SET circle_teaser_snoozed_until = ?1 WHERE id = ?2")
      .bind(new Date(ctx.now() + SNOOZE_MS).toISOString(), session.user.id).run();
    await recordEvent(env, {
      id: ctx.newId(), userId: session.user.id, name: "circle_teaser_snoozed",
      props: { placement: "home" }, createdAt: ctx.nowIso(),
    });
  }
  return getMe(ctx);
}
