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

type Options = { method?: "GET" | "POST" | "PATCH" | "DELETE"; body?: unknown; signal?: AbortSignal };

export async function api<T>(path: string, { method = "GET", body, signal }: Options = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (method !== "GET") headers["X-SR-Client"] = "portal";
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      credentials: "include",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
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

export type User = { id: string; email: string; first_name: string | null; tier: "club" | "vip"; created_at?: string };
export type Me = {
  user: User;
  membership: null;
  badges: { circle: boolean };
  onboarding: { passkey: boolean; saved: boolean; dismissed: boolean };
};
