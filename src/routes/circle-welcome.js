// The welcome piece, member side (spec v1.1 §8.4 GET/POST /api/circle/welcome,
// §16.3 #18): the options are shown only to a member whose selection is
// awaiting a choice; the choice is made once.

import { readJson } from "../http/body.js";
import { badRequest, conflict } from "../http/errors.js";
import { loadSettings } from "../circle/economics-store.js";
import { welcomeOptions } from "../circle/gifts.js";
import { liveMembership } from "../circle/membership.js";

async function selectionOf(env, userId) {
  return env.DB.prepare(
    "SELECT * FROM gift_selections WHERE user_id = ?1 AND status <> 'canceled' ORDER BY created_at DESC LIMIT 1"
  ).bind(userId).first();
}

export async function getWelcome(ctx) {
  const { env, session, json } = ctx;
  const sel = await selectionOf(env, session.user.id);
  if (!sel) return json({ status: null, options: [] });
  if (sel.status !== "awaiting_choice" || !(await liveMembership(env, session.user.id))) return json({ status: sel.status, options: [] });
  const { settings } = await loadSettings(env);
  const options = await welcomeOptions(ctx, settings);
  return json({ status: sel.status, options: options.map((o) => ({ id: o.id, title: o.title, blurb: o.blurb, image_url: o.image_url })) });
}

export async function postWelcome(ctx) {
  const { env, session, json } = ctx;
  const body = await readJson(ctx.request);
  if (typeof body.gift_option_id !== "string") throw badRequest("invalid_request", "Choose a piece.");
  const sel = await selectionOf(env, session.user.id);
  if (!sel) throw conflict("no_welcome_piece", "There is no welcome piece to choose.");
  if (sel.status !== "awaiting_choice") throw conflict("already_chosen", "Your piece has already been chosen.");
  if (!(await liveMembership(env, session.user.id))) throw conflict("no_welcome_piece", "There is no welcome piece to choose.");
  const { settings } = await loadSettings(env);
  const options = await welcomeOptions(ctx, settings);
  if (!options.some((o) => o.id === body.gift_option_id)) throw conflict("option_unavailable", "That piece is no longer available. Please choose another.");
  const res = await env.DB.prepare(
    "UPDATE gift_selections SET gift_option_id = ?1, status = 'chosen', chosen_at = ?2, updated_at = ?2 WHERE id = ?3 AND status = 'awaiting_choice'"
  ).bind(body.gift_option_id, ctx.nowIso(), sel.id).run();
  if (!res.meta || res.meta.changes !== 1) throw conflict("already_chosen", "Your piece has already been chosen.");
  return json({ status: "chosen" });
}
