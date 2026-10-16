// /account/membership (spec v1.1 §6.8, §16.1, T10; tz §3.1): the plan, the
// next charge (Stripe's preview, tax included), the card via Stripe's
// Customer Portal, "I've updated my card" while past_due, invoices, and the
// cancel flow — reason → one offer with the "If you cancel" facts and both
// buttons on the same screen → confirmation with Undo. Three screens at
// most, no step-up (§14.2: as easy as joining). Rejoin for an ended one.

import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../../api";
import { copy } from "../../copy/en";
import { formatDate } from "../../format";
import {
  CANCEL_REASONS, creditsText, usd,
  type CancelReason, type CancelStart, type MembershipBilling,
} from "../../circle-model";
import { navigate } from "../../router";
import { Link } from "../../ui/Link";
import { ErrorState, Skeleton } from "../../ui/states";
import { SectionHeading } from "../Placeholder";
import { openBillingPortal } from "./Member";
import { BackLink, errMessage, useApi } from "./shared";

type Flow =
  | { step: "none"; notice?: string }
  | { step: "reason" }
  | { step: "offer"; start: CancelStart }
  | { step: "done"; endsOn: string };

const back = () => <BackLink href="/account" text={copy.back.account} label={copy.back.accountLabel} />;

export function Membership() {
  const { state, reload, refresh } = useApi<MembershipBilling>("/api/account/membership");
  const [flow, setFlow] = useState<Flow>({ step: "none" });
  const heading = useRef<HTMLHeadingElement>(null);
  const first = useRef(true);

  useEffect(() => {
    if (first.current) { first.current = false; return; }
    heading.current?.focus();
  }, [flow.step]);

  if (state.kind === "loading") return <>{back()}<SectionHeading title={copy.membership.title} /><Skeleton lines={5} label={copy.membership.loading} /></>;
  if (state.kind === "error") {
    return (
      <>
        {back()}
        <SectionHeading title={copy.membership.title} />
        {state.status === 403
          ? <p class="circle-notice notice">{copy.membership.notMember}</p>
          : <ErrorState body={state.message} onRetry={reload} />}
      </>
    );
  }

  const m = state.data;
  if (flow.step === "reason") return <CancelReasonStep headingRef={heading} onKeep={() => setFlow({ step: "none" })} onStarted={(start) => setFlow({ step: "offer", start })} />;
  if (flow.step === "offer") {
    return (
      <CancelOfferStep start={flow.start} headingRef={heading}
        onKept={() => { setFlow({ step: "none", notice: copy.member.kept }); void refresh(); }}
        onCanceled={(endsOn) => { setFlow({ step: "done", endsOn }); void refresh(); }} />
    );
  }
  if (flow.step === "done") {
    return <CancelDone endsOn={flow.endsOn} headingRef={heading} onUndone={() => { setFlow({ step: "none", notice: copy.member.kept }); void refresh(); }} />;
  }

  return (
    <>
      {back()}
      <header class="section-heading appear">
        <h1 ref={heading} tabIndex={-1}>{copy.membership.title}</h1>
      </header>
      {flow.notice && <p class="notice circle-notice" role="status">{flow.notice}</p>}
      <Overview m={m} onChanged={refresh} onCancel={() => setFlow({ step: "reason" })} />
    </>
  );
}

function Overview({ m, onChanged, onCancel }: { m: MembershipBilling; onChanged: () => void; onCancel: () => void }) {
  const [busy, setBusy] = useState<"portal" | "retry" | "undo" | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function act(kind: "portal" | "retry" | "undo") {
    setBusy(kind);
    setMessage(null);
    try {
      if (kind === "portal") {
        await openBillingPortal();
        return;
      }
      if (kind === "retry") {
        const { result } = await api<{ result: string }>("/api/circle/billing/retry", { method: "POST", body: {} });
        setMessage({ ok: result !== "declined", text: copy.membership.retry[result] ?? copy.errors.generic });
        if (result === "paid") onChanged();
      } else {
        await api("/api/circle/cancel/undo", { method: "POST", body: {} });
        setMessage({ ok: true, text: copy.member.kept });
        onChanged();
      }
    } catch (e) {
      setMessage({ ok: false, text: errMessage(e) });
    }
    setBusy(null);
  }

  const live = ["active", "past_due", "canceling"].includes(m.status);
  const ended = m.status === "ended" || m.status === "ended_expired";
  return (
    <div class="appear">
      {message && <p class={message.ok ? "notice circle-notice" : "field-error circle-notice"} role={message.ok ? "status" : "alert"}>{message.text}</p>}
      {m.status === "past_due" && (
        <div class="circle-banner">
          <p>{copy.member.pastDue}</p>
          <div class="circle-actions">
            <button type="button" class="button button-primary" disabled={!!busy} onClick={() => act("portal")}>{copy.membership.updateCard}</button>
            <button type="button" class="button button-secondary" disabled={!!busy} onClick={() => act("retry")}>{copy.membership.updatedCard}</button>
          </div>
        </div>
      )}
      {m.status === "canceling" && m.ends_on && (
        <div class="circle-banner">
          <p>{copy.membership.endsOn(formatDate(m.ends_on))}</p>
          <button type="button" class="button button-secondary" disabled={!!busy} onClick={() => act("undo")}>{copy.member.keep}</button>
        </div>
      )}
      {ended && (
        <div class="circle-banner">
          {m.ends_on && <p>{copy.membership.endedOn(formatDate(m.ends_on))}</p>}
          {m.status === "ended" && m.credits_grace_until && <p>{copy.membership.creditsUntil(formatDate(m.credits_grace_until))}</p>}
          <Link href="/circle/join" class="button button-primary">{copy.membership.rejoin}</Link>
        </div>
      )}

      <dl class="facts">
        <div><dt>{copy.membership.plan}</dt><dd>{copy.membership.planValue(usd(m.monthly_cents))}</dd></div>
        {m.since && <div><dt>{copy.membership.since}</dt><dd>{formatDate(m.since)}</dd></div>}
        {m.next_charge && (
          <div>
            <dt>{copy.membership.nextCharge}</dt>
            <dd>{copy.membership.nextChargeValue(usd(m.next_charge.amount_cents), formatDate(m.next_charge.date))}</dd>
          </div>
        )}
      </dl>
      {m.next_charge && <p class="small">{copy.membership.taxNote}</p>}

      {live && (
        <section class="account-section" aria-labelledby="card-title">
          <h2 id="card-title">{copy.membership.card}</h2>
          <p class="small">{copy.membership.cardBody}</p>
          {m.status !== "past_due" && (
            <button type="button" class="button button-secondary" disabled={!!busy} onClick={() => act("portal")}>
              {busy === "portal" ? copy.membership.opening : copy.membership.updateCard}
            </button>
          )}
        </section>
      )}

      <section class="account-section" aria-labelledby="invoices-title">
        <h2 id="invoices-title">{copy.membership.invoices}</h2>
        {m.invoices.length === 0 ? <p class="small">{copy.membership.noInvoices}</p> : (
          <ul class="invoice-list">
            {m.invoices.map((inv, i) => {
              const date = inv.date ? formatDate(inv.date) : "";
              return (
                <li key={`${inv.date}-${i}`}>
                  <span class="invoice-meta">
                    <span>{date}</span>
                    <span class="small">{`${inv.amount_paid_cents != null ? usd(inv.amount_paid_cents) : ""} · ${copy.membership.invoiceStatus[inv.status] ?? inv.status}`}</span>
                  </span>
                  {inv.url && <a href={inv.url} aria-label={copy.membership.receiptLabel(date)}>{copy.membership.receipt}</a>}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <ul class="account-links">
        <li><Link href="/terms/membership">{copy.membership.terms}</Link></li>
        {(m.status === "active" || m.status === "past_due") && (
          <li><button type="button" class="button-link" onClick={onCancel}>{copy.membership.cancelLink}</button></li>
        )}
      </ul>
    </div>
  );
}

type HeadingRef = { current: HTMLHeadingElement | null };

// Screen 1: one question, an optional comment (§16.1).
function CancelReasonStep({ headingRef, onKeep, onStarted }: { headingRef: HeadingRef; onKeep: () => void; onStarted: (s: CancelStart) => void }) {
  const [reason, setReason] = useState<CancelReason | null>(null);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function next(e: Event) {
    e.preventDefault();
    if (!reason) return setError(copy.cancel.chooseReason);
    setBusy(true);
    setError(null);
    try {
      onStarted(await api<CancelStart>("/api/circle/cancel/start", { method: "POST", body: { reason, ...(comment.trim() ? { comment: comment.trim() } : {}) } }));
    } catch (err) {
      setError(errMessage(err));
      setBusy(false);
    }
  }

  return (
    <>
      <header class="section-heading appear">
        <h1 ref={headingRef} tabIndex={-1}>{copy.cancel.title}</h1>
      </header>
      <form class="cancel-flow" onSubmit={next} noValidate>
        <fieldset aria-describedby={error ? "cancel-error" : undefined}>
          <legend>{copy.cancel.question}</legend>
          {CANCEL_REASONS.map((r) => (
            <label key={r} class="choice">
              <input type="radio" name="cancel-reason" value={r} checked={reason === r} onChange={() => setReason(r)} />
              <span>{copy.cancel.reasons[r]}</span>
            </label>
          ))}
        </fieldset>
        {reason && (
          <div class="field">
            <label for="cancel-comment">{copy.cancel.comment}</label>
            <textarea id="cancel-comment" rows={3} maxLength={500} value={comment} onInput={(e) => setComment((e.target as HTMLTextAreaElement).value)} />
          </div>
        )}
        {error && <p id="cancel-error" class="field-error" role="alert">{error}</p>}
        <div class="circle-actions">
          <button type="submit" class="button button-secondary" disabled={busy}>{copy.cancel.continue}</button>
          <button type="button" class="button button-primary" onClick={onKeep}>{copy.cancel.keep}</button>
        </div>
      </form>
    </>
  );
}

// Screen 2: the one offer for this reason, the facts, and both buttons.
function CancelOfferStep({ start, headingRef, onKept, onCanceled }: {
  start: CancelStart; headingRef: HeadingRef; onKept: () => void; onCanceled: (endsOn: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const credits = start.balance_cents > 0 ? copy.member.balance(creditsText(start.balance_cents)) : null;

  async function keep(offerAccepted: boolean, then?: string) {
    setBusy(true);
    setError(null);
    try {
      await api("/api/circle/cancel/keep", { method: "POST", body: { cancellation_id: start.cancellation_id, offer_accepted: offerAccepted } });
      if (then) navigate(then);
      else onKept();
    } catch (e) {
      setError(errMessage(e));
      setBusy(false);
    }
  }

  async function cancel() {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ ends_on: string; credits_until: string }>("/api/circle/cancel/confirm", { method: "POST", body: { cancellation_id: start.cancellation_id } });
      onCanceled(res.ends_on);
    } catch (e) {
      setError(errMessage(e));
      setBusy(false);
    }
  }

  const offer = start.offer;
  const offerAction = offer?.kind === "use_credits"
    ? { label: copy.cancel.offerUseCredits, to: "/circle/credits/use" }
    : offer?.kind === "concierge_priority"
      ? { label: copy.cancel.offerConcierge, to: "/circle/concierge?priority=1" }
      : offer ? { label: copy.cancel.offerConcierge, to: "/circle/concierge" } : null;

  return (
    <>
      <header class="section-heading appear">
        <h1 ref={headingRef} tabIndex={-1}>{copy.cancel.title}</h1>
      </header>
      <div class="cancel-flow">
        {offer && offerAction && (
          <div class="cancel-offer">
            <p>{offer.copy}</p>
            <button type="button" class="button button-secondary" disabled={busy} onClick={() => keep(true, offerAction.to)}>{offerAction.label}</button>
          </div>
        )}
        <p class="cancel-facts"><strong>{copy.cancel.ifCancel}</strong>{" "}{copy.cancel.facts(formatDate(start.ends_on), credits, formatDate(start.credits_until))}</p>
        {error && <p class="field-error" role="alert">{error}</p>}
        <div class="circle-actions">
          <button type="button" class="button button-secondary" disabled={busy} onClick={cancel}>{busy ? copy.cancel.canceling : copy.cancel.cancel}</button>
          <button type="button" class="button button-primary" disabled={busy} onClick={() => keep(false)}>{copy.cancel.keep}</button>
        </div>
      </div>
    </>
  );
}

// Screen 3: confirmation with Undo (until the end of the paid period).
function CancelDone({ endsOn, headingRef, onUndone }: { endsOn: string; headingRef: HeadingRef; onUndone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const today = new Date().toISOString().slice(0, 10);
  async function undo() {
    setBusy(true);
    setError(null);
    try {
      await api("/api/circle/cancel/undo", { method: "POST", body: {} });
      onUndone();
    } catch (e) {
      setError(errMessage(e));
      setBusy(false);
    }
  }
  return (
    <>
      <header class="section-heading appear">
        <h1 ref={headingRef} tabIndex={-1}>{copy.cancel.doneTitle(formatDate(endsOn))}</h1>
      </header>
      <div class="cancel-flow">
        {/* A past_due membership ends today: there is nothing left to undo. */}
        {endsOn > today && (
          <>
            <p>{copy.cancel.undoLine(formatDate(endsOn))}</p>
            <div><button type="button" class="button button-secondary" disabled={busy} onClick={undo}>{copy.cancel.undo}</button></div>
          </>
        )}
        {error && <p class="field-error" role="alert">{error}</p>}
        <div><Link href="/circle" class="button-link">{copy.welcome.goCircle}</Link></div>
      </div>
    </>
  );
}
