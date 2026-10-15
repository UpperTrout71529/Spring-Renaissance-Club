import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, API_BASE } from "./api";
import { copy } from "./copy/en";

afterEach(() => vi.unstubAllGlobals());

function stubFetch(res: Response | Error) {
  const fn = vi.fn(async () => {
    if (res instanceof Error) throw res;
    return res;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("api", () => {
  it("sends credentials always and X-SR-Client only on mutations", async () => {
    const fn = stubFetch(Response.json({ ok: true }));
    await api("/api/me");
    let [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${API_BASE}/api/me`);
    expect(init.credentials).toBe("include");
    expect(init.headers).toEqual({});

    fn.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await api("/api/auth/logout", { method: "POST" });
    [, init] = fn.mock.calls[1] as unknown as [string, RequestInit];
    expect(init.headers).toEqual({ "X-SR-Client": "portal" });
  });

  it("maps the §8 error shape to ApiError", async () => {
    stubFetch(Response.json({ error: { code: "link_expired", message: "Expired." } }, { status: 410 }));
    await expect(api("/api/auth/verify", { method: "POST", body: {} })).rejects.toMatchObject({
      status: 410, code: "link_expired", message: "Expired.",
    });
  });

  it("uses the spec's copy for rate limits and network failures", async () => {
    stubFetch(Response.json({ error: { code: "rate_limited", message: "x" } }, { status: 429 }));
    await expect(api("/x", { method: "POST" })).rejects.toMatchObject({ message: copy.errors.rateLimited });

    stubFetch(new TypeError("Failed to fetch"));
    const err = await api("/x").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 0, code: "network", message: copy.errors.network });
  });
});
