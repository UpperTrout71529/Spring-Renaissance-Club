// POST /api/events (spec §15.1): the events the spec marks "client", and only
// those. Server events (sign-in, Saved, waitlist, Not now, orders…) are
// written by the server where they happen and cannot be sent from here.
// Each event has a fixed list of properties: required ones, optional ones,
// strings of at most 64 characters, some from a fixed set of values.

import { HttpError, badRequest, tooManyRequests } from "../http/errors.js";
import { readJson } from "../http/body.js";
import { withinLimit } from "../lib/rate-limit.js";
import { recordEvent } from "../lib/events.js";

const PLACEMENTS = ["home", "circle"];
const CLIENT_EVENTS = {
  order_viewed: { order_id: { required: true }, carrier: {} },
  tracking_clicked: { order_id: { required: true }, carrier: {} },
  circle_teaser_viewed: { placement: { required: true, oneOf: PLACEMENTS } },
  circle_teaser_clicked: { placement: { required: true, oneOf: PLACEMENTS } },
};
const MAX_LEN = 64;
const LIMIT_PER_HOUR = 300;

const invalid = () => new HttpError(400, "invalid_event", "This event is not valid.");

function validProps(spec, props) {
  if (props === undefined) props = {};
  if (!props || typeof props !== "object" || Array.isArray(props)) throw invalid();
  const out = {};
  for (const [key, value] of Object.entries(props)) {
    const rule = spec[key];
    if (!rule || typeof value !== "string" || !value || value.length > MAX_LEN) throw invalid();
    if (rule.oneOf && !rule.oneOf.includes(value)) throw invalid();
    out[key] = value;
  }
  for (const [key, rule] of Object.entries(spec)) {
    if (rule.required && !(key in out)) throw invalid();
  }
  return out;
}

export async function postEvent(ctx) {
  const { env, session } = ctx;
  const body = await readJson(ctx.request, 2048);
  const name = body && typeof body.name === "string" ? body.name : "";
  if (!Object.hasOwn(CLIENT_EVENTS, name)) throw badRequest("unknown_event", "This event is not accepted.");
  const props = validProps(CLIENT_EVENTS[name], body.props);

  const ok = await withinLimit(env, {
    bucket: "events", subject: session.user.id, limit: LIMIT_PER_HOUR, windowMs: 60 * 60 * 1000, nowMs: ctx.now(),
  });
  if (!ok) throw tooManyRequests();

  await recordEvent(env, { id: ctx.newId(), userId: session.user.id, name, props, createdAt: ctx.nowIso() });
  return new Response(null, { status: 204 });
}
