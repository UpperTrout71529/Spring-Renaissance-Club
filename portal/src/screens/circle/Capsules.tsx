// /circle/capsules (spec v1.1 §16.2, T9, T12): the capsule open now and those
// coming up. Claim turns credits into a single-use card for this capsule (the
// code shown once, as Use credits; a fresh step-up first, §10.4). Skip — a season's capsule only, never the
// membership — can be set and undone before the window opens (§16.2 copy).

import { useState } from "preact/hooks";
import { api } from "../../api";
import { copy } from "../../copy/en";
import { formatDate } from "../../format";
import { creditsText, usd, type Capsule, type CapsuleClaim, type CapsulesData, type CircleSummary } from "../../circle-model";
import { EmptyState, ErrorState, Skeleton } from "../../ui/states";
import { useStepUp } from "../../ui/useStepUp";
import { SectionHeading } from "../Placeholder";
import { BackToCircle, CodeReveal, errMessage, useApi } from "./shared";

export function Capsules({ email }: { email: string }) {
  const { state, reload, set } = useApi<CapsulesData>("/api/circle/capsules");
  const summary = useApi<CircleSummary>("/api/circle");
  const next = summary.state.kind === "ready" ? summary.state.data.next_accrual ?? null : null;

  const heading = <SectionHeading eyebrow={copy.capsules.eyebrow} title={copy.capsules.title} />;
  if (state.kind === "loading") return <><BackToCircle />{heading}<Skeleton lines={4} label={copy.capsules.loading} /></>;
  if (state.kind === "error") return <><BackToCircle />{heading}<ErrorState body={state.message} onRetry={reload} /></>;
  const { current, upcoming } = state.data;
  const replace = (c: Capsule) => set({
    current: current?.id === c.id ? c : current,
    upcoming: upcoming.map((u) => (u.id === c.id ? c : u)),
  });

  return (
    <>
      <BackToCircle />
      {heading}
      {!current && upcoming.length === 0 && <EmptyState title={copy.capsules.emptyTitle} body={copy.capsules.emptyBody} />}
      <div class="appear">
        {current && (
          <section aria-labelledby="capsule-current">
            <h2 id="capsule-current" class="eyebrow circle-notice">{copy.capsules.current}</h2>
            <CurrentCapsule capsule={current} email={email} onChange={replace} />
          </section>
        )}
        {upcoming.length > 0 && (
          <section aria-labelledby="capsule-upcoming">
            <h2 id="capsule-upcoming" class="eyebrow circle-notice">{copy.capsules.upcoming}</h2>
            {upcoming.map((c) => <UpcomingCapsule key={c.id} capsule={c} next={next} onChange={replace} />)}
          </section>
        )}
      </div>
    </>
  );
}

function CurrentCapsule({ capsule: c, email, onChange }: { capsule: Capsule; email: string; onChange: (c: Capsule) => void }) {
  const [busy, setBusy] = useState(false);
  const [claim, setClaim] = useState<CapsuleClaim | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { run, dialog } = useStepUp(email);

  async function doClaim() {
    setBusy(true);
    setError(null);
    try {
      const res = await run(() => api<CapsuleClaim>(`/api/circle/capsules/${encodeURIComponent(c.id)}/claim`, { method: "POST", body: {} }));
      if (!res) return;
      setClaim(res);
      onChange({ ...c, claimed: true });
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const view = c.product_url ? <a class="button button-secondary" href={c.product_url}>{copy.capsules.view}</a> : null;
  return (
    <article class="capsule" aria-labelledby={`cap-${c.id}`}>
      <p class="eyebrow">{copy.capsules.capsule(c.season)}</p>
      <h3 id={`cap-${c.id}`}>{c.title}</h3>
      <p>{copy.capsules.price(usd(c.price_cents))}</p>
      <p class="small">{copy.capsules.openUntil(formatDate(c.closes_at))}</p>
      {claim ? (
        claim.code ? (
          <>
            <p>{copy.capsules.cardFor(usd(claim.amount_cents))}</p>
            <CodeReveal code={claim.code} label={copy.use.codeLabel} note={copy.use.codeOnce} actions={view} />
          </>
        ) : (
          <>
            <p role="status">{copy.capsules.noCredits}</p>
            {view}
          </>
        )
      ) : c.claimed ? (
        <><p>{copy.capsules.claimed}</p>{view}</>
      ) : c.eligible ? (
        <div class="circle-actions">
          <button type="button" class="button button-primary" disabled={busy} onClick={doClaim}>{busy ? copy.capsules.claiming : copy.capsules.claim}</button>
          {view}
        </div>
      ) : (
        <>{c.reason && <p>{c.reason}</p>}{view}</>
      )}
      {error && <p class="field-error" role="alert">{error}</p>}
      {dialog}
    </article>
  );
}

function UpcomingCapsule({ capsule: c, next, onChange }: {
  capsule: Capsule; next: { date: string; amount_cents: number } | null; onChange: (c: Capsule) => void;
}) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function change(skip: boolean) {
    setBusy(true);
    setError(null);
    try {
      if (skip) await api("/api/circle/skips", { method: "POST", body: { capsule_id: c.id } });
      else await api(`/api/circle/skips/${encodeURIComponent(c.id)}`, { method: "DELETE" });
      setAsking(false);
      onChange({ ...c, skipped: skip });
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <article class="capsule" aria-labelledby={`cap-${c.id}`}>
      <p class="eyebrow">{copy.capsules.capsule(c.season)}</p>
      <h3 id={`cap-${c.id}`}>{c.title}</h3>
      <p class="small">{copy.capsules.opens(formatDate(c.opens_at))}</p>
      {c.skipped ? (
        <>
          <p role="status">{copy.capsules.skipped}</p>
          <button type="button" class="button-link" disabled={busy} onClick={() => change(false)}>{copy.capsules.undoSkip}</button>
        </>
      ) : asking ? (
        <div class="skip-confirm" role="group" aria-labelledby={`skip-q-${c.id}`}>
          <p id={`skip-q-${c.id}`}>{copy.capsules.skipQuestion(c.season, creditsText(next?.amount_cents ?? 2000), next ? formatDate(next.date) : null)}</p>
          <div class="circle-actions">
            <button type="button" class="button button-primary" disabled={busy} onClick={() => change(true)}>{copy.capsules.skip(c.season)}</button>
            <button type="button" class="button-link" disabled={busy} onClick={() => setAsking(false)}>{copy.capsules.dontSkip}</button>
          </div>
        </div>
      ) : (
        <button type="button" class="button button-secondary" onClick={() => setAsking(true)}>{copy.capsules.skip(c.season)}</button>
      )}
      {error && <p class="field-error" role="alert">{error}</p>}
    </article>
  );
}
