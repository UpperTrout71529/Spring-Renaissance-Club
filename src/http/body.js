import { badRequest, HttpError } from "./errors.js";

const DEFAULT_MAX_BYTES = 64 * 1024;

// Reads a JSON object body. The declared length is checked before reading and
// the actual length after, so a lying Content-Length cannot buffer more.
export async function readJson(request, maxBytes = DEFAULT_MAX_BYTES) {
  const tooLarge = () => new HttpError(413, "payload_too_large", "The request is too large.");
  const declared = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();
  const text = await request.text();
  if (new TextEncoder().encode(text).length > maxBytes) throw tooLarge();
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw badRequest("invalid_json", "The request body is not valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badRequest("invalid_json", "The request body must be a JSON object.");
  }
  return value;
}
