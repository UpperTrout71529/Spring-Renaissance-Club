// /circle/credits (spec v1.1 §6.7, T3): the Treasury and its history — a
// table on desktop, a list on mobile — 20 rows a page with "Load more", and
// the cards made from credits with "Return to credits" for an unused one (T4).
// /circle/credits/use: the three steps of §6.7 with step-up (§10.4) and a
// fresh Idempotency-Key per attempt (§16.3 #5).

import { useEffect, useRef, useState } from "preact/hooks";
import { api, ApiError } from "../../api";
import { copy } from "../../copy/en";
import { formatDate } from "../../format";
import {
  checkAmount, creditsText, newIdempotencyKey, signedCredits, spendableCredits, usd,
  type CircleSummary, type CreditsPage, type LedgerRow, type Redemption, type RedemptionSummary,
} from "../../circle-model";
import { STOREFRONT_COLLECTIONS } from "../../router";
import { Link } from "../../ui/Link";
import { EmptyState, ErrorState, Skeleton } from "../../ui/states";
import { useStepUp } from "../../ui/useStepUp";
import { SectionHeading } from "../Placeholder";
import { BackLink, BackToCircle, CodeReveal, errMessage, toError, useApi, type Load } from "./shared";

export function Credits() {
  const [state, setState] = useState<Load<CreditsPage>>({ kind: "loading" });
  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [more, setMore] = useState<"idle" | "busy" | { error: string }>("idle");

  async function load(quiet = false) {
    if (!quiet) setState({ kind: "loading" });
    try {
      const page = await api<CreditsPage>("/api/circle/credits");
      setRows(page.ledger);
      setNext(page.next_cursor);
      setState({ kind: "ready", data: page });
    } catch (e) {
      setState(toError(e));
    }
  }

  async function loadMore() {
    if (!next) return;
    setMore("busy");
    try {
      const page = await api<CreditsPage>(`/api/circle/credits?cursor=${encodeURIComponent(next)}`);
      setRows((prev) => [...prev, ...page.ledger]);
      setNext(page.next_cursor);
      setMore("idle");
    } catch (e) {
      setMore({ error: errMessage(e) });
    }
  }

  useEffect(() => { void load(); }, []);

  return (
    <>
      <BackToCircle />
      <SectionHeading eyebrow={copy.credits.eyebrow} title={copy.credits.title} />
      {state.kind === "loading" && <Skeleton lines={5} label={copy.credits.loading} />}
      {state.kind === "error" && <ErrorState body={state.message} onRetry={() => load()} />}
      {state.kind === "ready" && (
        <div class="appear">
          <div class="circle-block circle-block-strong">
            <p class="treasury-balance">{copy.member.balance(creditsText(state.data.balance_cents))}</p>
            <p>{copy.member.toSpend(usd(Math.max(0, state.data.balance_cents)))}</p>
            {state.data.next_accrual && <p>{copy.member.nextAccrual(creditsText(state.data.next_accrual.amount_cents), formatDate(state.data.next_accrual.date))}</p>}
            {state.data.expires_on && <p>{copy.credits.expiresOn(formatDate(state.data.expires_on))}</p>}
            {state.data.frozen && <p>{copy.member.frozen}</p>}
            {state.data.balance_cents >= 100 && !state.data.frozen && (
              <div class="treasury-actions"><Link href="/circle/credits/use" class="button button-primary">{copy.member.useCredits}</Link></div>
            )}
          </div>

          {rows.length === 0 ? (
            <EmptyState title={copy.credits.emptyTitle} body={copy.credits.emptyBody} />
          ) : (
            <>
              <table class="ledger-table">
                <caption class="visually-hidden">{copy.credits.tableLabel}</caption>
                <thead>
                  <tr>
                    <th scope="col">{copy.credits.date}</th>
                    <th scope="col">{copy.credits.description}</th>
                    <th scope="col" class="num">{copy.credits.credits}</th>
                    <th scope="col" class="num">{copy.credits.balance}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={`${r.date}-${i}`}>
                      <td>{formatDate(r.date)}</td>
                      <td>{r.memo}</td>
                      <td class="num">{signedCredits(r.amount_cents)}</td>
                      <td class="num">{creditsText(r.running_balance_cents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <ul class="ledger-list" aria-label={copy.credits.tableLabel}>
                {rows.map((r, i) => (
                  <li key={`${r.date}-${i}`}>
                    <span class="held-meta">
                      <span>{r.memo}</span>
                      <span class="small">{formatDate(r.date)}</span>
                    </span>
                    <span class="ledger-amount">
                      <span>{signedCredits(r.amount_cents)}</span>
                      <span class="small">{`${copy.credits.balance} ${creditsText(r.running_balance_cents)}`}</span>
                    </span>
                  </li>
                ))}
              </ul>
              {typeof more === "object" && <p class="field-error" role="alert">{more.error}</p>}
              {next && (
                <button type="button" class="button button-secondary order-load-more" disabled={more === "busy"} onClick={loadMore}>
                  {copy.credits.loadMore}
                </button>
              )}
            </>
          )}
          <Cards onReturned={() => load(true)} />
        </div>
      )}
    </>
  );
}

function Cards({ onReturned }: { onReturned: () => void }) {
  const { state, refresh } = useApi<{ redemptions: RedemptionSummary[] }>("/api/credits/redemptions");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  if (state.kind !== "ready" || state.data.redemptions.length === 0) return null;

  async function giveBack(r: RedemptionSummary) {
    setBusy(r.id);
    setMessage(null);
    try {
      await api(`/api/credits/redemptions/${encodeURIComponent(r.id)}/return`, { method: "POST", body: {} });
      setMessage({ ok: true, text: copy.credits.returnedNotice });
      await refresh();
      onReturned();
    } catch (e) {
      setMessage({ ok: false, text: errMessage(e) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section class="circle-block" aria-labelledby="cards-title">
      <h2 id="cards-title">{copy.credits.cardsTitle}</h2>
      {message && <p class={message.ok ? "small" : "field-error"} role={message.ok ? "status" : "alert"}>{message.text}</p>}
      <ul class="cards-list">
        {state.data.redemptions.map((r) => (
          <li key={r.id}>
            <span class="held-meta">
              <span>{copy.credits.card(r.last4 ?? "")}</span>
              <span class="small">{copy.credits.cardMeta(usd(r.amount_cents), formatDate(r.created_at))}</span>
            </span>
            {r.status === "deactivated"
              ? <span class="small">{copy.credits.returned}</span>
              : r.purpose === "credits" && (
                <button type="button" class="button-link" disabled={busy === r.id}
                  aria-label={copy.credits.returnLabel(r.last4 ?? "")} onClick={() => giveBack(r)}>
                  {copy.credits.returnToCredits}
                </button>
              )}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---- Use credits -----------------------------------------------------------------

type Step = { n: 1 } | { n: 2; credits: number; key: string } | { n: 3; redemption: Redemption };

export function UseCredits({ email }: { email: string }) {
  const { state, reload } = useApi<CircleSummary>("/api/circle");
  const [step, setStep] = useState<Step>({ n: 1 });
  const [value, setValue] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { run, dialog } = useStepUp(email);
  const heading = useRef<HTMLHeadingElement>(null);
  const first = useRef(true);

  useEffect(() => {
    if (first.current) { first.current = false; return; }
    heading.current?.focus();
  }, [step.n]);

  const back = <BackLink href="/circle/credits" text={copy.back.credits} label={copy.back.creditsLabel} />;
  if (state.kind === "loading") return <>{back}<SectionHeading eyebrow={copy.credits.eyebrow} title={copy.use.title} /><Skeleton lines={3} label={copy.credits.loading} /></>;
  if (state.kind === "error") return <>{back}<ErrorState body={state.message} onRetry={reload} /></>;

  const max = spendableCredits(state.data.balance_cents ?? 0);
  const amount = value ?? String(max);
  const title = (
    <header class="section-heading appear">
      <p class="eyebrow">{copy.use.step(step.n)}</p>
      <h1 ref={heading} tabIndex={-1}>{step.n === 3 ? copy.use.readyTitle : step.n === 2 ? copy.use.confirmTitle : copy.use.title}</h1>
    </header>
  );

  if (step.n === 1 && (max < 1 || state.data.frozen)) {
    return (
      <>
        {back}
        <SectionHeading eyebrow={copy.credits.eyebrow} title={copy.use.title} />
        {state.data.frozen
          ? <p class="circle-notice notice">{copy.member.frozen}</p>
          : <EmptyState title={copy.use.nothingTitle} body={copy.use.nothingBody} />}
      </>
    );
  }

  if (step.n === 1) {
    const next = (e: Event) => {
      e.preventDefault();
      const check = checkAmount(amount, max);
      if (!check.ok) {
        setError(check.error === "max" ? copy.use.max(String(max)) : check.error === "min" ? copy.use.min : copy.use.whole);
        return;
      }
      setError(null);
      // A new attempt gets a new key; a double click within it reuses the key.
      setStep({ n: 2, credits: check.credits, key: newIdempotencyKey() });
    };
    return (
      <>
        {back}
        {title}
        <form class="steps-form" onSubmit={next} noValidate>
          <div class="field">
            <label for="credits-amount">{copy.use.amountLabel}</label>
            <input id="credits-amount" inputMode="numeric" pattern="[0-9]*" autoComplete="off" value={amount}
              onInput={(e) => setValue((e.target as HTMLInputElement).value)}
              aria-invalid={error ? "true" : undefined} aria-describedby={error ? "credits-hint credits-error" : "credits-hint"} />
            <p id="credits-hint" class="field-hint">{copy.use.amountHint(String(max))}</p>
            {error && <p id="credits-error" class="field-error" role="alert">{error}</p>}
          </div>
          <div><button type="submit" class="button button-primary">{copy.use.continue}</button></div>
        </form>
      </>
    );
  }

  if (step.n === 2) {
    const parts = copy.use.confirm(usd(step.credits * 100));
    const create = async () => {
      setBusy(true);
      setError(null);
      try {
        const res = await run(() => api<{ redemption: Redemption; repeated?: boolean }>("/api/credits/redeem", {
          method: "POST", body: { amount_cents: step.credits * 100 }, headers: { "Idempotency-Key": step.key },
        }));
        if (res) setStep({ n: 3, redemption: res.redemption });
      } catch (e) {
        setError(errMessage(e));
        // A refused attempt is over: the next try is a new attempt.
        if (e instanceof ApiError && e.status !== 0) setStep({ ...step, key: newIdempotencyKey() });
      } finally {
        setBusy(false);
      }
    };
    return (
      <>
        {back}
        {title}
        <div class="steps-form">
          <p>{parts.before}<strong>{parts.amount}</strong>{parts.after}</p>
          {error && <p class="field-error" role="alert">{error}</p>}
          <div class="circle-actions">
            <button type="button" class="button button-primary" disabled={busy} onClick={create}>
              {busy ? copy.use.creating : copy.use.create}
            </button>
            <button type="button" class="button-link" disabled={busy} onClick={() => { setError(null); setStep({ n: 1 }); }}>{copy.use.back}</button>
          </div>
        </div>
        {dialog}
      </>
    );
  }

  const r = step.redemption;
  return (
    <>
      {back}
      {title}
      {r.code ? (
        <CodeReveal code={r.code} label={copy.use.codeLabel} note={copy.use.codeOnce}
          actions={<a class="button button-secondary" href={STOREFRONT_COLLECTIONS}>{copy.use.shopNow}</a>} />
      ) : (
        <div class="steps-form">
          <p>{copy.use.repeated}</p>
          <div><a class="button button-secondary" href={STOREFRONT_COLLECTIONS}>{copy.use.shopNow}</a></div>
        </div>
      )}
    </>
  );
}
