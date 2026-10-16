// /account/email#t=… — confirms an email change from the link sent to the new
// address (spec §11 email_change_confirm). Works without a session, on any
// device; the token is taken from the fragment and stripped at once.

import { useEffect, useRef, useState } from "preact/hooks";
import { api, ApiError } from "../api";
import { copy } from "../copy/en";
import { Link } from "../ui/Link";
import { Skeleton } from "../ui/states";

type State = { kind: "working" } | { kind: "done"; email: string } | { kind: "expired" } | { kind: "error"; message: string };

export function EmailConfirm() {
  const [state, setState] = useState<State>({ kind: "working" });
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const m = /(?:^#|&)t=([A-Za-z0-9_-]+)/.exec(location.hash);
    if (location.hash) history.replaceState(null, "", location.pathname);
    if (!m) {
      setState({ kind: "expired" });
      return;
    }
    api<{ email: string }>("/api/me/email-change/confirm", { method: "POST", body: { token: m[1] } })
      .then((r) => setState({ kind: "done", email: r.email }))
      .catch((e) => {
        if (e instanceof ApiError && e.status === 410) setState({ kind: "expired" });
        else setState({ kind: "error", message: e instanceof ApiError ? e.message : copy.errors.generic });
      });
  }, []);

  if (state.kind === "working") return <Skeleton lines={2} label={copy.emailConfirm.confirming} />;
  if (state.kind === "done") {
    return (
      <section class="state appear">
        <h1>{copy.emailConfirm.done(state.email)}</h1>
        <div class="state-action"><Link href="/account" class="button button-primary">{copy.emailConfirm.goAccount}</Link></div>
      </section>
    );
  }
  if (state.kind === "expired") {
    return (
      <section class="state appear">
        <h1>{copy.emailConfirm.expiredTitle}</h1>
        <p>{copy.emailConfirm.expiredBody}</p>
        <div class="state-action"><Link href="/account" class="button button-secondary">{copy.emailConfirm.goAccount}</Link></div>
      </section>
    );
  }
  return (
    <section class="state appear" role="alert">
      <h1>{copy.errors.errorTitle}</h1>
      <p>{state.message}</p>
      <div class="state-action"><Link href="/account" class="button button-secondary">{copy.emailConfirm.goAccount}</Link></div>
    </section>
  );
}
