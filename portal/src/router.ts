// History API router (spec §3.4). GitHub Pages answers unknown paths with
// 404.html — a copy of index.html — so deep links land here and resolve.

import { useEffect, useState } from "preact/hooks";

export type RouteName =
  | "login" | "auth" | "home" | "orders" | "order" | "saved" | "circle"
  | "account" | "accountSecurity" | "accountPrivacy" | "accountEmail" | "termsMembership" | "notFound"
  | CircleRoute | "accountMembership";

// V2 Circle screens (docs/tz-v2-circle.md §3.1).
export type CircleRoute =
  | "circleJoin" | "circleWelcome" | "circleCredits" | "circleCreditsUse" | "circleObject" | "circleEarlyAccess"
  | "circleInvite" | "circleAnniversary" | "circleCapsules" | "circleConcierge" | "circleRooms";

type RouteDef = { name: RouteName; pattern: string; public?: boolean };

// V1 screen map (spec §5.3) + V2 (tz §3.1).
export const ROUTES: RouteDef[] = [
  { name: "login", pattern: "/login", public: true },
  { name: "auth", pattern: "/auth", public: true },
  { name: "accountEmail", pattern: "/account/email", public: true },
  { name: "termsMembership", pattern: "/terms/membership", public: true },
  { name: "home", pattern: "/" },
  { name: "orders", pattern: "/orders" },
  { name: "order", pattern: "/orders/:id" },
  { name: "saved", pattern: "/saved" },
  { name: "circle", pattern: "/circle" },
  { name: "circleJoin", pattern: "/circle/join" },
  { name: "circleWelcome", pattern: "/circle/welcome" },
  { name: "circleCredits", pattern: "/circle/credits" },
  { name: "circleCreditsUse", pattern: "/circle/credits/use" },
  { name: "circleObject", pattern: "/circle/object" },
  { name: "circleEarlyAccess", pattern: "/circle/early-access" },
  { name: "circleInvite", pattern: "/circle/invite" },
  { name: "circleAnniversary", pattern: "/circle/anniversary" },
  { name: "circleCapsules", pattern: "/circle/capsules" },
  { name: "circleConcierge", pattern: "/circle/concierge" },
  { name: "circleRooms", pattern: "/circle/rooms" },
  { name: "account", pattern: "/account" },
  { name: "accountSecurity", pattern: "/account/security" },
  { name: "accountPrivacy", pattern: "/account/privacy" },
  { name: "accountMembership", pattern: "/account/membership" },
];

export type Match = { name: RouteName; params: Record<string, string>; public: boolean };

export function matchPath(pathname: string): Match {
  const parts = pathname.split("/").filter(Boolean);
  for (const r of ROUTES) {
    const pat = r.pattern.split("/").filter(Boolean);
    if (pat.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < pat.length; i++) {
      if (pat[i].startsWith(":")) {
        try {
          params[pat[i].slice(1)] = decodeURIComponent(parts[i]);
        } catch {
          ok = false;
        }
      } else if (pat[i] !== parts[i]) ok = false;
      if (!ok) break;
    }
    if (ok) return { name: r.name, params, public: !!r.public };
  }
  return { name: "notFound", params: {}, public: true };
}

const EVENT = "sr:navigate";

export function navigate(to: string, { replace = false } = {}): void {
  if (replace) history.replaceState(null, "", to);
  else history.pushState(null, "", to);
  window.dispatchEvent(new Event(EVENT));
  // A new screen starts at the top, as in a native app.
  if (!replace) window.scrollTo(0, 0);
}

export type Location = { pathname: string; search: string };

function current(): Location {
  return { pathname: location.pathname, search: location.search };
}

export function useLocation(): Location {
  const [loc, setLoc] = useState(current);
  useEffect(() => {
    const update = () => setLoc(current());
    window.addEventListener(EVENT, update);
    window.addEventListener("popstate", update);
    return () => {
      window.removeEventListener(EVENT, update);
      window.removeEventListener("popstate", update);
    };
  }, []);
  return loc;
}

// Only portal-relative paths are accepted as a destination after sign-in;
// storefront URLs are handled by the caller (full navigation).
export function safeReturnPath(value: string | null | undefined): string | null {
  if (!value || !/^\/(?![/\\])[^\s\\]*$/.test(value)) return null;
  return value;
}

export const STOREFRONT_ORIGIN = "https://springrenaissance.store";
// The theme's own "continue shopping" target (settings_data.json empty_cart_button_link).
export const STOREFRONT_COLLECTIONS = `${STOREFRONT_ORIGIN}/collections/all`;

export function isStorefrontUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    return new URL(value).origin === STOREFRONT_ORIGIN;
  } catch {
    return false;
  }
}
