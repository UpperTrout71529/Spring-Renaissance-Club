// /circle/join[?invite=CODE] (spec v1.1 §14.2, T1; docs/tz-v2-circle.md
// §3.1): the offer from GET /api/circle/join, the server's disclosure
// verbatim, the two server-provided consents unticked, the button disabled
// until both are ticked, then Stripe Checkout. Rejoining uses /rejoin.

import { useEffect, useRef, useState } from "preact/hooks";
import { api, ApiError } from "../../api";
import { copy } from "../../copy/en";
import { formatDate } from "../../format";
import {
  checkoutBody, consentsComplete, joinState, usd, type ConsentState, type JoinOffer,
} from "../../circle-model";
import { Link } from "../../ui/Link";
import { ErrorState, Skeleton } from "../../ui/states";
import { SectionHeading } from "../Placeholder";
import { BackToCircle, errMessage, toError, type Load } from "./shared";

export function Join({ search }: { search: string }) {
  const invite = new URLSearchParams(search).get("invite");
  const [state, setState] = useState<Load<JoinOffer>>({ kind: "loading" });
  const [ticked, setTicked] = useState<ConsentState>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);

  async function load() {
    setState({ kind: "loading" });
    setTicked({});
    try {
      setState({ kind: "ready", data: await api<JoinOffer>(`/api/circle/join${invite ? `?invite=${encodeURIComponent(invite)}` : ""}`) });
    } catch (e) {
      setState(toError(e));
    }
  }
  useEffect(() => { void load(); }, [invite]);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);

  if (state.kind === "loading") {
    return <><BackToCircle /><SectionHeading eyebrow={copy.eyebrows.circle} title={copy.join.title} /><Skeleton lines={5} label={copy.join.loading} /></>;
  }
  if (state.kind === "error") {
    return <><BackToCircle /><ErrorState body={state.message} onRetry={load} /></>;
  }
  const offer = state.data;
  const view = joinState(offer);
  const title = offer.kind === "rejoin" ? copy.join.rejoinTitle : copy.join.title;

  if (view === "member") {
    return (
      <>
        <BackToCircle />
        <section class="state appear">
          <h1>{copy.join.memberTitle}</h1>
          <p>{copy.join.memberBody}</p>
          <div class="state-action"><Link href="/circle" class="button button-secondary">{copy.join.goCircle}</Link></div>
        </section>
      </>
    );
  }
  if (view === "closed") {
    return (
      <>
        <BackToCircle />
        <section class="state appear">
          <p class="eyebrow">{copy.eyebrows.circle}</p>
          <h1>{copy.join.closedTitle}</h1>
          <p>{copy.join.closedBody}</p>
          {offer.invitation_note && <p>{offer.invitation_note}</p>}
          <p class="small">{offer.region_note}</p>
          <div class="state-action"><Link href="/circle" class="button button-secondary">{copy.join.goCircle}</Link></div>
        </section>
      </>
    );
  }

  const complete = consentsComplete(offer, ticked);
  const monthly = offer.monthly_cents ?? 0;
  const joining = offer.joining_cents ?? 0;
  const discount = offer.discount_cents ?? 0;

  async function submit(e: Event) {
    e.preventDefault();
    if (!complete || busy) return;
    setBusy(true);
    setError(null);
    try {
      const path = offer.kind === "rejoin" ? "/api/circle/rejoin" : "/api/circle/checkout";
      const { url } = await api<{ url: string }>(path, { method: "POST", body: checkoutBody(offer, invite) });
      window.location.assign(url);
    } catch (err) {
      setBusy(false);
      // The terms changed under the page: show the new ones, unticked.
      if (err instanceof ApiError && err.code === "terms_changed") await load();
      setError(errMessage(err));
    }
  }

  return (
    <>
      <BackToCircle />
      <SectionHeading eyebrow={copy.eyebrows.circle} title={title} />
      <div class="circle-intro appear">
        {offer.invitation_note && <p class="notice">{offer.invitation_note}</p>}
        <p>{copy.club.value}</p>

        <section aria-labelledby="join-summary">
          <h2 id="join-summary" class="visually-hidden">{copy.join.summary}</h2>
          <dl class="join-summary">
            <div><dt>{copy.join.firstMonth}</dt><dd>{usd(monthly)}</dd></div>
            {joining > 0 && <div><dt>{copy.join.joiningFee}</dt><dd>{usd(joining)}</dd></div>}
            {discount > 0 && <div><dt>{copy.join.invitation}</dt><dd>{`−${usd(discount)}`}</dd></div>}
            <div class="is-total"><dt>{copy.join.dueToday}</dt><dd>{usd(offer.first_charge_cents ?? 0)}</dd></div>
          </dl>
        </section>
        {offer.first_renewal_on && <p>{copy.join.then(usd(monthly), formatDate(offer.first_renewal_on))}</p>}
        {offer.kind === "rejoin" && <p>{copy.join.rejoinNote}</p>}
        <p class="small">{offer.region_note}</p>

        <form class="join-form" onSubmit={submit} noValidate>
          <fieldset class="consents">
            <legend>{copy.join.consents}</legend>
            {offer.consents.map((c) => (
              <label key={c.id} class="consent">
                <input type="checkbox" checked={ticked[c.id] === true}
                  onChange={(e) => setTicked({ ...ticked, [c.id]: (e.target as HTMLInputElement).checked })} />
                <span>{c.text}</span>
              </label>
            ))}
          </fieldset>
          <p><Link href="/terms/membership">{copy.join.readTerms}</Link></p>
          {/* §14.2: shown next to the button, exactly as the server words it. */}
          <p class="disclosure" id="join-disclosure">{offer.disclosure}</p>
          <p class="small">{copy.join.binding}</p>
          {error && <p ref={errorRef} tabIndex={-1} class="field-error" role="alert">{error}</p>}
          <div>
            <button type="submit" class="button button-primary" disabled={!complete || busy} aria-describedby="join-disclosure">
              {busy ? copy.join.continuing : copy.join.continue}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
