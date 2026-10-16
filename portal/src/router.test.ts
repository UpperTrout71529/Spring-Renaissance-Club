import { describe, expect, it } from "vitest";
import { isStorefrontUrl, matchPath, ROUTES, safeReturnPath } from "./router";
import { STATIC_ROUTES } from "../vite.config";

describe("matchPath", () => {
  it("resolves the V1 screen map", () => {
    expect(matchPath("/").name).toBe("home");
    expect(matchPath("/orders").name).toBe("orders");
    expect(matchPath("/orders/1042")).toEqual({ name: "order", params: { id: "1042" }, public: false });
    expect(matchPath("/account/security").name).toBe("accountSecurity");
    expect(matchPath("/login")).toMatchObject({ name: "login", public: true });
    expect(matchPath("/auth")).toMatchObject({ name: "auth", public: true });
  });

  it("resolves the V2 Circle screens (tz §3.1)", () => {
    const names: Record<string, string> = {
      "/circle/join": "circleJoin", "/circle/welcome": "circleWelcome", "/circle/credits": "circleCredits",
      "/circle/credits/use": "circleCreditsUse", "/circle/object": "circleObject", "/circle/early-access": "circleEarlyAccess",
      "/circle/invite": "circleInvite", "/circle/anniversary": "circleAnniversary", "/circle/capsules": "circleCapsules",
      "/circle/concierge": "circleConcierge", "/circle/rooms": "circleRooms", "/account/membership": "accountMembership",
    };
    for (const [path, name] of Object.entries(names)) expect(matchPath(path)).toEqual({ name, params: {}, public: false });
    expect(matchPath("/terms/membership")).toMatchObject({ name: "termsMembership", public: true });
  });

  it("every fixed route has a static page in the build, so deep links answer 200", () => {
    const fixed = ROUTES.map((r) => r.pattern).filter((p) => p !== "/" && !p.includes(":"));
    expect(fixed.filter((p) => !STATIC_ROUTES.includes(p.slice(1)))).toEqual([]);
  });

  it("decodes params and tolerates a trailing slash", () => {
    expect(matchPath("/orders/a%20b").params.id).toBe("a b");
    expect(matchPath("/saved/").name).toBe("saved");
  });

  it("answers notFound for anything else, including broken encodings", () => {
    expect(matchPath("/nope").name).toBe("notFound");
    expect(matchPath("/orders/%E0%A4%A").name).toBe("notFound");
  });
});

describe("return_to", () => {
  it("accepts portal paths only", () => {
    expect(safeReturnPath("/orders/1042")).toBe("/orders/1042");
    for (const bad of ["//evil.example", "/\\evil", "https://evil.example", "orders", "", null, undefined]) {
      expect(safeReturnPath(bad as string)).toBeNull();
    }
  });

  it("recognises storefront URLs exactly", () => {
    expect(isStorefrontUrl("https://springrenaissance.store/products/vase")).toBe(true);
    expect(isStorefrontUrl("https://springrenaissance.store.evil.example/")).toBe(false);
    expect(isStorefrontUrl("http://springrenaissance.store/")).toBe(false);
    expect(isStorefrontUrl(null)).toBe(false);
  });
});
