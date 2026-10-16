// API client (spec §8). Credentials are always included — the session is the
// __Host-sr_session cookie on api.springrenaissance.store, same-site with the
// portal. State-changing calls carry X-SR-Client: portal; GETs do not, so they
// need no CORS preflight.

import { copy } from "./copy/en";

export const API_BASE: string = import.meta.env.VITE_API_BASE ?? "https://api.springrenaissance.store";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

// `headers` adds request headers (e.g. Idempotency-Key). A Blob body is sent
// as it is (room photos: PUT with its own Content-Type); anything else as JSON.
type Options = {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE"; body?: unknown; signal?: AbortSignal;
  headers?: Record<string, string>;
};

export async function api<T>(path: string, { method = "GET", body, signal, headers: extra }: Options = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const raw = typeof Blob !== "undefined" && body instanceof Blob;
  if (method !== "GET") headers["X-SR-Client"] = "portal";
  if (body !== undefined) headers["Content-Type"] = raw ? (body as Blob).type : "application/json";
  if (extra) Object.assign(headers, extra);

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      credentials: "include",
      headers,
      body: body === undefined ? undefined : raw ? (body as Blob) : JSON.stringify(body),
      signal,
    });
  } catch {
    throw new ApiError(0, "network", copy.errors.network);
  }

  if (res.status === 204) return undefined as T;
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // Non-JSON body: fall through to a generic error below if !ok.
  }
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string } } | null)?.error;
    const message = res.status === 429 ? copy.errors.rateLimited : err?.message || copy.errors.generic;
    throw new ApiError(res.status, err?.code || "http_error", message);
  }
  return data as T;
}

// Client analytics (spec §15.1, POST /api/events). Fire and forget: a lost
// event never shows an error. keepalive lets it finish when a link click
// leaves the page.
export type ClientEvent =
  | { name: "order_viewed"; props: { order_id: string; carrier?: string } }
  | { name: "tracking_clicked"; props: { order_id: string; carrier?: string } }
  | { name: "circle_teaser_viewed" | "circle_teaser_clicked"; props: { placement: "home" | "circle" } };

export function track(event: ClientEvent): void {
  fetch(`${API_BASE}/api/events`, {
    method: "POST",
    credentials: "include",
    keepalive: true,
    headers: { "Content-Type": "application/json", "X-SR-Client": "portal" },
    body: JSON.stringify(event),
  }).catch(() => {});
}

export type User = {
  id: string; email: string; first_name: string | null; tier: "club" | "vip";
  created_at?: string; last_name?: string | null; seasonal_email_opt_in?: boolean;
};
export type Me = {
  user: User;
  membership: null;
  badges: { circle: boolean };
  onboarding: { passkey: boolean; saved: boolean; dismissed: boolean };
};
