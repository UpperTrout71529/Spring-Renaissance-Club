import { useEffect, useRef, useState } from "preact/hooks";
import { api, ApiError, type Me, type User } from "./api";
import { copy } from "./copy/en";
import { matchPath, navigate, useLocation, type RouteName } from "./router";
import { PublicLayout, Shell } from "./ui/Shell";
import { ErrorState, Skeleton } from "./ui/states";
import { Login } from "./screens/Login";
import { Auth } from "./screens/Auth";
import { NotFound, SectionHeading } from "./screens/Placeholder";
import { Account } from "./screens/Account";
import { Security } from "./screens/Security";
import { OrderDetail, Orders } from "./screens/Orders";
import { Home } from "./screens/Home";
import { Saved } from "./screens/Saved";
import { CircleScreen } from "./screens/Circle";

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
  accountPrivacy: copy.nav.account,
  notFound: copy.notFound.title,
};

export function App() {
  const loc = useLocation();
  const match = matchPath(loc.pathname);
  const [session, setSession] = useState<Session>({ status: "loading" });
  const firstRender = useRef(true);

  async function loadMe() {
    setSession({ status: "loading" });
    try {
      const me = await api<Me>("/api/me");
      setSession({ status: "signed-in", user: me.user, circleBadge: me.badges.circle });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setSession({ status: "anonymous" });
      else setSession({ status: "error", message: e instanceof ApiError ? e.message : copy.errors.generic });
    }
  }

  useEffect(() => {
    // /auth signs in by itself; checking /api/me first would only race it.
    if (match.name === "auth") setSession({ status: "anonymous" });
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
        <Login returnTo={returnTo} onSignedIn={(user) => setSession({ status: "signed-in", user, circleBadge: false })} />
      </PublicLayout>
    );
  }

  if (session.status === "error") {
    return <PublicLayout><ErrorState body={session.message} onRetry={loadMe} /></PublicLayout>;
  }
  if (session.status !== "signed-in") {
    return <PublicLayout><Skeleton lines={4} label={copy.login.title} /></PublicLayout>;
  }

  return (
    <Shell route={match.name} email={session.user.email} circleBadge={session.circleBadge} onSignOut={signOut}>
      <Screen route={match.name} params={match.params} search={loc.search} user={session.user} onSignOut={signOut} />
    </Shell>
  );
}

type ScreenProps = { route: RouteName; params: Record<string, string>; search: string; user: User; onSignOut: () => void };

function Screen({ route, params, search, user, onSignOut }: ScreenProps) {
  const email = user.email;
  switch (route) {
    case "home": return <Home user={user} />;
    case "orders": return <Orders />;
    case "order": return <OrderDetail id={params.id} />;
    case "saved": return <Saved initialTab={new URLSearchParams(search).get("view") === "held" ? "held" : "saved"} />;
    case "circle": return <CircleScreen />;
    case "account": return <Account email={email} onSignOut={onSignOut} />;
    case "accountSecurity": return <Security email={email} />;
    case "accountPrivacy": return <SectionHeading title={copy.nav.account} />;
    default: return <NotFound />;
  }
}
