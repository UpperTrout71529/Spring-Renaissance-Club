// Product analytics (spec §15) into the `events` table. Analytics never breaks
// the flow it observes: a failed insert is logged and swallowed.

export async function recordEvent(env, { id, userId = null, name, props = null, createdAt }) {
  try {
    await env.DB.prepare(
      "INSERT INTO events (id, user_id, name, props_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5)"
    ).bind(id, userId, name, props ? JSON.stringify(props) : null, createdAt).run();
  } catch (e) {
    console.error("event not recorded", name, e && e.name);
  }
}
