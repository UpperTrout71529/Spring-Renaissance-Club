import { useEffect, useRef, useState } from "preact/hooks";
import { api, ApiError, type Me, type User } from "./api";
import { copy } from "./copy/en";
import { matchPath, navigate, useLocation, type RouteName } from "./router";
import { PublicLayout, Shell } from "./ui/Shell";
import { ErrorState, Skeleton } from "./ui/states";
import { Login } from "./screens/Login";
import { Auth } from "./screens/Auth";
import { NotFound } from "./screens/Placeholder";
import { Account } from "./screens/Account";
import { Security } from "./screens/Security";
import { OrderDetail, Orders } from "./screens/Orders";
import { Home } from "./screens/Home";
import { Saved } from "./screens/Saved";
import { CircleScreen } from "./screens/Circle";
import { Privacy } from "./screens/Privacy";
import { EmailConfirm } from "./screens/EmailConfirm";
import { lazyScreen } from "./ui/lazy";

// V2 Circle screens: one chunk, loaded on first use (ui/lazy.tsx).
const v2 = () => import("./screens/circle/index");
const Join = lazyScreen(() => v2().then((m) => m.Join), copy.join.loading);
const Welcome = lazyScreen(() => v2().then((m) => m.Welcome), copy.welcome.confirming);
const Credits = lazyScreen(() => v2().then((m) => m.Credits), copy.credits.loading);
const UseCredits = lazyScreen(() => v2().then((m) => m.UseCredits), copy.credits.loading);
const MemberObject = lazyScreen(() => v2().then((m) => m.MemberObject), copy.memberObject.loading);
const Invite = lazyScreen(() => v2().then((m) => m.Invite), copy.invite.loading);
const Anniversary = lazyScreen(() => v2().then((m) => m.Anniversary), copy.anniversary.loading);
const Capsules = lazyScreen(() => v2().then((m) => m.Capsules), copy.capsules.loading);
const Concierge = lazyScreen(() => v2().then((m) => m.Concierge), copy.concierge.loading);
const Rooms = lazyScreen(() => v2().then((m) => m.Rooms), copy.rooms.loading);
const Membership = lazyScreen(() => v2().then((m) => m.Membership), copy.membership.loading);
const Terms = lazyScreen(() => v2().then((m) => m.Terms), copy.terms.title);

type Session =
  | { status: "loading" }
  | { status: "anonymous" }
  | { status: "signed-in"; user: User; circleBadge: boolean }
  | { status: "error"; message: string };

const TITLES: Partial<Record<RouteName, string>> = {
  login: copy.login.title,
  home: copy.nav.home,
  orders: copy.nav.orders,
  order: copy.nav.orders,
  saved: copy.nav.saved,
  circle: copy.nav.circle,
  account: copy.nav.account,
  accountSecurity: copy.security.title,
  accountPrivacy: copy.privacy.title,
  accountEmail: copy.account.email,
  notFound: copy.notFound.title,
  // V2 Circle.
  circleJoin: copy.join.title,
  circleWelcome: copy.welcome.title,
  circleCredits: copy.credits.title,
  circleCreditsUse: copy.use.title,
  circleObject: copy.memberObject.title,
  circleEarlyAccess: copy.early.title,
  circleInvite: copy.invite.title,
  circleAnniversary: copy.anniversary.title(1),
  circleCapsules: copy.capsules.title,
  circleConcierge: copy.concierge.title,
  circleRooms: copy.rooms.title,
  accountMembership: copy.membership.title,
  termsMembership: copy.terms.title,
};

export function App() {
  const loc = useLocation();
  const match = matchPath(loc.pathname);
  const [session, setSession] = useState<Session>({ status: "loading" });
  const firstRender = useRef(true);
  // The /api/me answer from page load, handed to Home once so its first
  // render does not ask again (S11: one request less on the LCP path). Later
  // visits to Home fetch fresh data.
  const bootMe = useRef<Me | null>(null);
  const takeBootMe = () => {
    const me = bootMe.current;
    bootMe.current = null;
    return me;
  };

  async function loadMe() {
    setSession({ status: "loading" });
    try {
      const me = await api<Me>("/api/me");
      bootMe.current = me;
      setSession({ status: "signed-in", user: me.user, circleBadge: me.badges.circle });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setSession({ status: "anonymous" });
      else setSession({ status: "error", message: e instanceof ApiError ? e.message : copy.errors.generic });
    }
  }

  useEffect(() => {
    // /auth signs in by itself; checking /api/me first would only race it.
    if (match.name === "auth" || match.name === "accountEmail") setSession({ status: "anonymous" });
    else void loadMe();
  }, []);

  // Route guards.
  useEffect(() => {
    if (session.status === "anonymous" && !match.public) {
      const returnTo = loc.pathname + loc.search;
      navigate(`/login${returnTo === "/" ? "" : `?return_to=${encodeURIComponent(returnTo)}`}`, { replace: true });
    }
    if (session.status === "signed-in" && match.name === "login") navigate("/", { replace: true });
  }, [session.status, match.name]);

  // Title and focus follow navigation (not on first paint).
  useEffect(() => {
    document.title = `${TITLES[match.name] ?? copy.login.title} · ${copy.brand}`;
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    document.getElementById("main")?.focus({ preventScroll: true });
  }, [loc.pathname]);

  async function signOut() {
    try {
      await api("/api/auth/logout", { method: "POST" });
    } catch {
      // Signing out locally is still right; the cookie expires on its own.
    }
    setSession({ status: "anonymous" });
    navigate("/login", { replace: true });
  }

  if (match.name === "accountEmail") {
    return <PublicLayout><EmailConfirm /></PublicLayout>;
  }

  if (match.name === "auth") {
    return (
      <PublicLayout>
        <Auth onSignedIn={(user) => setSession({ status: "signed-in", user, circleBadge: false })} />
      </PublicLayout>
    );
  }

  if (match.name === "login") {
    const returnTo = new URLSearchParams(loc.search).get("return_to");
    if (session.status === "loading" || session.status === "signed-in") {
      return <PublicLayout><Skeleton lines={3} label={copy.login.title} /></PublicLayout>;
    }
    return (
      <PublicLayout>
        <Login
          returnTo={returnTo}
          notice={new URLSearchParams(loc.search).get("deleted") === "1" ? copy.privacy.deleted : null}
          onSignedIn={(user) => setSession({ status: "signed-in", user, circleBadge: false })}
        />
      </PublicLayout>
    );
  }

  // Membership Terms are public (spec §5.3): readable before signing in.
  if (match.name === "termsMembership" && session.status !== "signed-in") {
    return <PublicLayout><Terms /></PublicLayout>;
  }

  if (session.status === "error") {
    return <PublicLayout><ErrorState body={session.message} onRetry={loadMe} /></PublicLayout>;
  }
  if (session.status !== "signed-in") {
    return <PublicLayout><Skeleton lines={4} label={copy.login.title} /></PublicLayout>;
  }

  return (
    <Shell route={match.name} email={session.user.email} circleBadge={session.circleBadge} onSignOut={signOut}>
      <Screen
        route={match.name}
        params={match.params}
        search={loc.search}
        user={session.user}
        takeBootMe={takeBootMe}
        onSignOut={signOut}
        onDeleted={() => {
          setSession({ status: "anonymous" });
          navigate("/login?deleted=1", { replace: true });
        }}
      />
    </Shell>
  );
}

type ScreenProps = {
  route: RouteName; params: Record<string, string>; search: string; user: User;
  takeBootMe: () => Me | null; onSignOut: () => void; onDeleted: () => void;
};

function Screen({ route, params, search, user, takeBootMe, onSignOut, onDeleted }: ScreenProps) {
  const email = user.email;
  switch (route) {
    case "home": return <Home user={user} takeBootMe={takeBootMe} />;
    case "orders": return <Orders />;
    case "order": return <OrderDetail id={params.id} />;
    case "saved": return <Saved initialTab={new URLSearchParams(search).get("view") === "held" ? "held" : "saved"} />;
    case "circle": return <CircleScreen search={search} />;
    case "circleJoin": return <Join search={search} />;
    case "circleWelcome": return <Welcome />;
    case "circleCredits": return <Credits />;
    case "circleCreditsUse": return <UseCredits email={email} />;
    case "circleObject": return <MemberObject kind="object" />;
    case "circleEarlyAccess": return <MemberObject kind="early" />;
    case "circleInvite": return <Invite />;
    case "circleAnniversary": return <Anniversary />;
    case "circleCapsules": return <Capsules email={email} />;
    case "circleConcierge": return <Concierge search={search} />;
    case "circleRooms": return <Rooms />;
    case "accountMembership": return <Membership />;
    case "termsMembership": return <Terms />;
    case "account": return <Account email={email} onSignOut={onSignOut} />;
    case "accountSecurity": return <Security email={email} />;
    case "accountPrivacy": return <Privacy email={email} onDeleted={onDeleted} />;
    default: return <NotFound />;
  }
}
