// GET /api/me (spec §8.3). V1 shape: membership is always null and the Circle
// badge always false until V2 adds memberships.
export async function getMe({ env, session, json }) {
  const { user } = session;
  const flags = await env.DB.prepare(
    `SELECT EXISTS (SELECT 1 FROM passkeys WHERE user_id = ?1) AS passkey,
            EXISTS (SELECT 1 FROM wishlist_items WHERE user_id = ?1) AS saved`
  ).bind(user.id).first();

  return json({
    user: { id: user.id, email: user.email, first_name: user.first_name, tier: user.tier },
    membership: null,
    badges: { circle: false },
    onboarding: { passkey: !!(flags && flags.passkey), saved: !!(flags && flags.saved) },
  });
}
