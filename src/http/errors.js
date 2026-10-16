// Spec §8: every error has one shape —
//   { "error": { "code": "insufficient_credits", "message": "…" } }
// `code` is stable and machine-readable; `message` is safe to show a person.

export class HttpError extends Error {
  constructor(status, code, message, headers = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

export const badRequest = (code, message) => new HttpError(400, code, message);
export const unauthenticated = () =>
  new HttpError(401, "unauthenticated", "Please sign in to continue.");
export const forbidden = (code, message) => new HttpError(403, code, message);
export const notFound = () => new HttpError(404, "not_found", "Not found.");
export const conflict = (code, message) => new HttpError(409, code, message);
export const tooManyRequests = () =>
  new HttpError(429, "rate_limited", "Too many requests. Please wait a few minutes and try again.");
export const serviceUnavailable = (code = "service_unavailable") =>
  new HttpError(503, code, "The service is temporarily unavailable. Please try again shortly.");

export function errorBody(code, message) {
  return { error: { code, message } };
}
