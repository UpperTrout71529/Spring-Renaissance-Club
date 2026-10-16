// GET /api/me (spec §8.3). V1 shape: membership is always null and the Circle
// badge always false until V2 adds memberships. `user.created_at` drives
// "Club member since …" on Home (§6.3); `onboarding.dismissed` hides the
// "Make it yours" card (§6.10).

import { badRequest } from "../http/errors.js";
import { readJson } from "../http/body.js";

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

// PATCH /api/me (spec §8.3). S6 needs only { onboarding_dismissed: true };
// the profile fields (names, seasonal email, Circle teaser snooze) arrive with
// S8/S9. Unknown fields are refused rather than ignored.
const SUPPORTED = new Set(["onboarding_dismissed"]);

export async function patchMe(ctx) {
  const body = await readJson(ctx.request);
  const keys = Object.keys(body);
  if (!keys.length || keys.some((k) => !SUPPORTED.has(k))) {
    throw badRequest("invalid_fields", "Some of these fields can't be changed here.");
  }
  if (body.onboarding_dismissed !== true) {
    throw badRequest("invalid_fields", "Some of these fields can't be changed here.");
  }
  await ctx.env.DB.prepare(
    "UPDATE users SET onboarding_dismissed_at = COALESCE(onboarding_dismissed_at, ?1) WHERE id = ?2"
  ).bind(ctx.nowIso(), ctx.session.user.id).run();
  return getMe(ctx);
}
