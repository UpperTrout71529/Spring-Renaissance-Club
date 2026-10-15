// /auth (spec §10.1): the token arrives in the #fragment, is removed from the
// address bar at once, and is spent with a POST — a mail scanner that opens
// the link never spends it.

import { useEffect, useRef, useState } from "preact/hooks";
import { api, ApiError, type User } from "../api";
import { copy } from "../copy/en";
import { isStorefrontUrl, navigate, safeReturnPath } from "../router";
import { ErrorState, Skeleton } from "../ui/states";
import { Link } from "../ui/Link";

function takeToken(): string | null {
  const m = /(?:^#|&)t=([A-Za-z0-9_-]+)/.exec(location.hash);
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  return m ? m[1] : null;
}

type State = { kind: "verifying" } | { kind: "expired" } | { kind: "error"; message: string };

export function Auth({ onSignedIn }: { onSignedIn: (user: User) => void }) {
  const token = useRef<string | null | undefined>(undefined);
  if (token.current === undefined) token.current = takeToken();
  const [state, setState] = useState<State>({ kind: "verifying" });
  const started = useRef(false);

  async function verify() {
    if (!token.current) {
      setState({ kind: "expired" });
      return;
    }
    setState({ kind: "verifying" });
    try {
      const res = await api<{ user: User; return_to: string | null }>("/api/auth/verify", {
        method: "POST",
        body: { token: token.current },
      });
      token.current = null;
      onSignedIn(res.user);
      if (isStorefrontUrl(res.return_to)) location.assign(res.return_to!);
      else navigate(safeReturnPath(res.return_to) ?? "/", { replace: true });
    } catch (e) {
      if (e instanceof ApiError && e.status === 410) setState({ kind: "expired" });
      else setState({ kind: "error", message: e instanceof ApiError ? e.message : copy.errors.generic });
    }
  }

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void verify();
  }, []);

  if (state.kind === "verifying") return <Skeleton lines={2} label={copy.auth.signingIn} />;
  if (state.kind === "error") return <ErrorState body={state.message} onRetry={verify} />;
  return (
    <section class="state appear">
      <h1>{copy.auth.expiredTitle}</h1>
      <p>{copy.auth.expiredBody}</p>
      <div class="state-action">
        <Link href="/login" class="button button-primary button-block">{copy.auth.sendNew}</Link>
      </div>
    </section>
  );
}
