// The concierge and Your rooms (spec v1.1 §6.7, §8.4, §12 screen 6, T13 v1).
// People only: Felix answers from the admin; nothing in here generates text.
// Members with a live membership only (Club → 403). Room photos go to R2
// (binding ROOMS), are served only to their owner or the admin, and a file
// that still carries EXIF is refused (the portal re-encodes images in the
// browser, which drops EXIF; the server checks).

import { readJson } from "../http/body.js";
import { HttpError, badRequest, forbidden, notFound, tooManyRequests } from "../http/errors.js";
import { emailUser } from "./notify.js";

const MAX_BODY = 4000;
const PER_DAY = 20;
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const MAX_PHOTOS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

async function requireMember(ctx) {
  const m = await ctx.env.DB.prepare(
    "SELECT 1 AS yes FROM memberships WHERE user_id = ?1 AND status IN ('active','past_due','canceling') LIMIT 1"
  ).bind(ctx.session.user.id).first();
  if (!m) throw forbidden("members_only", "The concierge is for members of the Circle.");
}

const threadOf = (env, userId) => env.DB.prepare("SELECT * FROM concierge_threads WHERE user_id = ?1").bind(userId).first();

export async function getConcierge(ctx) {
  await requireMember(ctx);
  const { env, session } = ctx;
  const t = await threadOf(env, session.user.id);
  if (!t) return ctx.json({ messages: [], unread: 0 });
  const { results } = await env.DB.prepare(
    "SELECT id, author, body, created_at, read_at FROM concierge_messages WHERE thread_id = ?1 ORDER BY created_at, rowid"
  ).bind(t.id).all();
  const unread = results.filter((m) => m.author === "maison" && !m.read_at).length;
  if (unread) {
    await env.DB.prepare("UPDATE concierge_messages SET read_at = ?1 WHERE thread_id = ?2 AND author = 'maison' AND read_at IS NULL")
      .bind(ctx.nowIso(), t.id).run();
  }
  return ctx.json({ messages: results.map((m) => ({ id: m.id, author: m.author, body: m.body, created_at: m.created_at })), unread });
}

export async function postConcierge(ctx) {
  await requireMember(ctx);
  const { env, session } = ctx;
  const b = await readJson(ctx.request, 16 * 1024);
  const text = typeof b.body === "string" ? b.body.trim() : "";
  if (!text || text.length > MAX_BODY) throw badRequest("invalid_message", `Write between 1 and ${MAX_BODY} characters.`);
  const nowIso = ctx.nowIso();
  let t = await threadOf(env, session.user.id);
  if (t) {
    const recent = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM concierge_messages WHERE thread_id = ?1 AND author = 'member' AND created_at > ?2"
    ).bind(t.id, new Date(ctx.now() - DAY_MS).toISOString()).first();
    if (recent.n >= PER_DAY) throw tooManyRequests();
  } else {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO concierge_threads (id, user_id, status, priority, updated_at, created_at) VALUES (?1, ?2, 'open', 0, ?3, ?3)"
    ).bind(ctx.newId(), session.user.id, nowIso).run();
    t = await threadOf(env, session.user.id);
  }
  await env.DB.batch([
    env.DB.prepare("INSERT INTO concierge_messages (id, thread_id, author, body, created_at) VALUES (?1, ?2, 'member', ?3, ?4)")
      .bind(ctx.newId(), t.id, text, nowIso),
    env.DB.prepare("UPDATE concierge_threads SET status = 'open', priority = MAX(priority, ?1), updated_at = ?2 WHERE id = ?3")
      .bind(b.priority === true ? 1 : 0, nowIso, t.id),
  ]);
  return ctx.json({ sent: true }, 201);
}

// ---- admin ------------------------------------------------------------------------

export async function listThreads(ctx) {
  const { results } = await ctx.env.DB.prepare(
    `SELECT t.id, t.status, t.priority, t.updated_at, u.email, u.first_name, u.last_name,
            (SELECT COUNT(*) FROM concierge_messages m WHERE m.thread_id = t.id AND m.author = 'member'
               AND m.created_at > COALESCE((SELECT MAX(created_at) FROM concierge_messages r WHERE r.thread_id = t.id AND r.author = 'maison'), '')) AS unread_from_member
       FROM concierge_threads t JOIN users u ON u.id = t.user_id
      ORDER BY t.priority DESC, t.updated_at DESC LIMIT 200`
  ).all();
  return ctx.json({ threads: results });
}

export async function getThread(ctx) {
  const { env, params } = ctx;
  const t = await env.DB.prepare("SELECT t.*, u.email FROM concierge_threads t JOIN users u ON u.id = t.user_id WHERE t.id = ?1").bind(params.id).first();
  if (!t) throw notFound();
  const messages = (await env.DB.prepare("SELECT id, author, author_email, body, created_at, read_at FROM concierge_messages WHERE thread_id = ?1 ORDER BY created_at, rowid")
    .bind(t.id).all()).results;
  const photos = (await env.DB.prepare("SELECT id, room_label, note, created_at FROM room_photos WHERE user_id = ?1 ORDER BY created_at DESC").bind(t.user_id).all()).results;
  return ctx.json({ thread: { id: t.id, status: t.status, priority: t.priority, email: t.email }, messages, photos });
}

export async function replyThread(ctx) {
  const { env, params } = ctx;
  const t = await env.DB.prepare("SELECT * FROM concierge_threads WHERE id = ?1").bind(params.id).first();
  if (!t) throw notFound();
  const b = await readJson(ctx.request, 16 * 1024);
  const text = typeof b.body === "string" ? b.body.trim() : "";
  if (!text || text.length > MAX_BODY) throw badRequest("invalid_message", `Write between 1 and ${MAX_BODY} characters.`);
  const nowIso = ctx.nowIso();
  const id = ctx.newId();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO concierge_messages (id, thread_id, author, author_email, body, created_at) VALUES (?1, ?2, 'maison', ?3, ?4, ?5)")
      .bind(id, t.id, ctx.admin.email, text, nowIso),
    env.DB.prepare("UPDATE concierge_threads SET status = 'answered', priority = 0, updated_at = ?1 WHERE id = ?2").bind(nowIso, t.id),
    env.DB.prepare("INSERT INTO admin_audit (id, actor_email, action, target, created_at) VALUES (?1, ?2, 'concierge_reply', ?3, ?4)")
      .bind(ctx.newId(), ctx.admin.email, t.id, nowIso),
  ]);
  // §11: no reply text in the email (privacy) — only a link to the portal.
  ctx.waitUntil(emailUser(ctx, t.user_id, "concierge_reply", `concierge_reply:${id}`, {}));
  return ctx.json({ sent: true }, 201);
}

// ---- Your rooms -------------------------------------------------------------------------

const TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

function sniff(bytes) {
  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return "image/png";
  if (String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  return null;
}

// True when the file still carries EXIF (JPEG APP1 "Exif", PNG eXIf, WebP EXIF).
export function hasExif(bytes, type) {
  if (type === "image/jpeg") {
    let i = 2;
    while (i + 4 <= bytes.length && bytes[i] === 0xFF) {
      const marker = bytes[i + 1];
      if (marker === 0xDA || marker === 0xD9) break; // image data / end
      const len = (bytes[i + 2] << 8) | bytes[i + 3];
      if (marker === 0xE1 && String.fromCharCode(...bytes.slice(i + 4, i + 8)) === "Exif") return true;
      i += 2 + len;
    }
    return false;
  }
  const ascii = new TextDecoder("latin1").decode(bytes);
  if (type === "image/png") return ascii.includes("eXIf");
  if (type === "image/webp") return ascii.includes("EXIF");
  return false;
}

function rooms(env) {
  if (!env.ROOMS) throw new HttpError(503, "rooms_unavailable", "Room photos are not available yet.");
  return env.ROOMS;
}

export async function listRooms(ctx) {
  await requireMember(ctx);
  const { results } = await ctx.env.DB.prepare("SELECT id, room_label, note, created_at FROM room_photos WHERE user_id = ?1 ORDER BY created_at DESC")
    .bind(ctx.session.user.id).all();
  return ctx.json({ photos: results });
}

export async function uploadRoom(ctx) {
  await requireMember(ctx);
  const { env, session, url, request } = ctx;
  const bucket = rooms(env);
  const type = (request.headers.get("Content-Type") || "").split(";")[0].trim();
  if (!TYPES[type]) throw new HttpError(415, "unsupported_type", "Upload a JPEG, PNG or WebP image.");
  const declared = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > MAX_PHOTO_BYTES) throw new HttpError(413, "payload_too_large", "Images up to 10 MB.");
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > MAX_PHOTO_BYTES) throw new HttpError(413, "payload_too_large", "Images up to 10 MB.");
  if (sniff(bytes) !== type) throw badRequest("type_mismatch", "The file is not the image type it says it is.");
  if (hasExif(bytes, type)) throw badRequest("exif_present", "Please upload the image from the portal, which removes location data first.");
  const label = (url.searchParams.get("label") || "").trim().slice(0, 60);
  if (!label) throw badRequest("invalid_label", "Name the room.");
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM room_photos WHERE user_id = ?1").bind(session.user.id).first();
  if (count.n >= MAX_PHOTOS) throw new HttpError(409, "too_many_photos", `Up to ${MAX_PHOTOS} photos.`);
  const id = ctx.newId();
  const key = `rooms/${session.user.id}/${id}.${TYPES[type]}`;
  await bucket.put(key, bytes, { httpMetadata: { contentType: type } });
  await env.DB.prepare(
    "INSERT INTO room_photos (id, user_id, room_label, r2_key, content_type, size_bytes, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)"
  ).bind(id, session.user.id, label, key, type, bytes.length, ctx.nowIso()).run();
  return ctx.json({ photo: { id, room_label: label } }, 201);
}

async function servePhoto(env, row) {
  const obj = await rooms(env).get(row.r2_key);
  if (!obj) throw notFound();
  return new Response(obj.body, { headers: { "Content-Type": row.content_type, "Cache-Control": "private, no-store", "Content-Security-Policy": "default-src 'none'" } });
}

export async function getRoomImage(ctx) {
  const { env, session, params } = ctx;
  const row = await env.DB.prepare("SELECT * FROM room_photos WHERE id = ?1").bind(params.id).first();
  if (!row || row.user_id !== session.user.id) throw forbidden("not_yours", "This photo is not available.");
  return servePhoto(env, row);
}

export async function adminRoomImage(ctx) {
  const row = await ctx.env.DB.prepare("SELECT * FROM room_photos WHERE id = ?1").bind(ctx.params.id).first();
  if (!row) throw notFound();
  return servePhoto(ctx.env, row);
}

export async function deleteRoom(ctx) {
  await requireMember(ctx);
  const { env, session, params } = ctx;
  const row = await env.DB.prepare("SELECT * FROM room_photos WHERE id = ?1 AND user_id = ?2").bind(params.id, session.user.id).first();
  if (!row) throw notFound();
  await rooms(env).delete(row.r2_key);
  await env.DB.prepare("DELETE FROM room_photos WHERE id = ?1").bind(row.id).run();
  return ctx.json({ deleted: true });
}
