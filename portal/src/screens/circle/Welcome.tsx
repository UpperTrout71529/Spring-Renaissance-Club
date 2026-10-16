// /circle/welcome (spec v1.1 §16.3 #2, §6.1, §6.10, T6; tz §3.1): after
// Checkout, ask GET /api/circle every 2 s for up to 20 s until the webhook has
// made the membership live; then the unsealing (the only rich animation —
// skippable by tap, off with reduced motion) and the choice of the sealed
// piece. A rejoin has no new piece. Never "Welcome Gift".

import type { RefObject } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../../api";
import { copy } from "../../copy/en";
import {
  POLL_EVERY_MS, POLL_FOR_MS, confirmed, creditsText, isLive,
  type CircleSummary, type WelcomeData,
} from "../../circle-model";
import { Link } from "../../ui/Link";
import { ErrorState, Skeleton } from "../../ui/states";
import { SectionHeading } from "../Placeholder";
import { errMessage } from "./shared";

type Phase =
  | { kind: "confirming" }
  | { kind: "slow" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "unsealing"; summary: CircleSummary; welcome: WelcomeData }
  | { kind: "choose"; summary: CircleSummary; welcome: WelcomeData }
  | { kind: "chosen"; summary: CircleSummary }
  | { kind: "back"; summary: CircleSummary };

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export function Welcome() {
  const [phase, setPhase] = useState<Phase>({ kind: "confirming" });
  const timer = useRef<number | undefined>(undefined);
  const alive = useRef(true);
  const heading = useRef<HTMLHeadingElement>(null);

  async function afterConfirmed(summary: CircleSummary) {
    setPhase({ kind: "loading" });
    try {
      const welcome = await api<WelcomeData>("/api/circle/welcome");
      if (welcome.status === "awaiting_choice") {
        setPhase(reducedMotion() || !welcome.options.length ? { kind: "choose", summary, welcome } : { kind: "unsealing", summary, welcome });
      } else if (welcome.status) setPhase({ kind: "chosen", summary });
      else setPhase({ kind: "back", summary });
    } catch (e) {
      setPhase({ kind: "error", message: errMessage(e) });
    }
  }

  // §16.3 #2: every 2 s, up to 20 s. The webhook is the source of truth.
  function poll() {
    window.clearTimeout(timer.current);
    setPhase({ kind: "confirming" });
    const started = Date.now();
    const tick = async () => {
      let summary: CircleSummary | null = null;
      try {
        summary = await api<CircleSummary>("/api/circle");
      } catch {
        // A failed check counts as "not yet".
      }
      if (!alive.current) return;
      if (summary && confirmed(summary)) return void afterConfirmed(summary);
      if (Date.now() - started + POLL_EVERY_MS > POLL_FOR_MS) return setPhase({ kind: "slow" });
      timer.current = window.setTimeout(tick, POLL_EVERY_MS);
    };
    void tick();
  }

  useEffect(() => {
    alive.current = true;
    poll();
    return () => { alive.current = false; window.clearTimeout(timer.current); };
  }, []);

  useEffect(() => {
    if (phase.kind === "choose" || phase.kind === "chosen" || phase.kind === "back") heading.current?.focus();
  }, [phase.kind]);

  switch (phase.kind) {
    case "confirming":
      return (
        <>
          <SectionHeading eyebrow={copy.eyebrows.circle} title={copy.welcome.title} />
          <p class="circle-notice" role="status">{copy.welcome.confirming}</p>
          <Skeleton lines={3} label={copy.welcome.confirming} />
        </>
      );
    case "slow":
      return (
        <>
          <SectionHeading eyebrow={copy.eyebrows.circle} title={copy.welcome.title} />
          <div class="circle-intro">
            <p role="status">{copy.welcome.slow}</p>
            <div class="circle-actions">
              <button type="button" class="button button-secondary" onClick={poll}>{copy.welcome.checkAgain}</button>
              <Link href="/circle" class="button-link">{copy.welcome.goCircle}</Link>
            </div>
          </div>
        </>
      );
    case "loading":
      return <><SectionHeading eyebrow={copy.eyebrows.circle} title={copy.welcome.title} /><Skeleton lines={3} label={copy.welcome.confirming} /></>;
    case "error":
      return <ErrorState body={phase.message} onRetry={poll} />;
    case "unsealing":
      return (
        <>
          <SectionHeading eyebrow={copy.welcome.eyebrow} title={copy.welcome.title} />
          <Unsealing onDone={() => setPhase({ kind: "choose", summary: phase.summary, welcome: phase.welcome })} />
        </>
      );
    case "choose":
      return <Choose welcome={phase.welcome} headingRef={heading} onChosen={() => setPhase({ kind: "chosen", summary: phase.summary })} />;
    case "chosen":
      return (
        <>
          <header class="section-heading appear">
            <p class="eyebrow">{copy.welcome.eyebrow}</p>
            <h1 ref={heading} tabIndex={-1}>{copy.welcome.chosenTitle}</h1>
          </header>
          <div class="circle-intro"><p>{copy.welcome.chosenBody}</p></div>
          <FirstCredits summary={phase.summary} />
        </>
      );
    case "back":
      return (
        <>
          <header class="section-heading appear">
            <p class="eyebrow">{copy.eyebrows.circle}</p>
            <h1 ref={heading} tabIndex={-1}>{copy.welcome.backTitle}</h1>
          </header>
          <div class="circle-intro">
            <p>{copy.welcome.backBody}</p>
            <div><Link href="/circle" class="button button-primary">{copy.welcome.goCircle}</Link></div>
          </div>
        </>
      );
  }
}

// §6.10: "Your first 20 credits are here" → [Use credits] / [Later].
function FirstCredits({ summary }: { summary: CircleSummary }) {
  const balance = summary.balance_cents ?? 0;
  if (!isLive(summary.membership) || balance < 100) {
    return <div class="circle-intro"><div><Link href="/circle" class="button button-primary">{copy.welcome.goCircle}</Link></div></div>;
  }
  return (
    <section class="circle-block circle-block-strong" aria-labelledby="first-credits">
      <h2 id="first-credits">{copy.welcome.creditsTitle(creditsText(balance))}</h2>
      <div class="circle-actions">
        <Link href="/circle/credits/use" class="button button-primary">{copy.welcome.useCredits}</Link>
        <Link href="/circle" class="button button-secondary">{copy.welcome.later}</Link>
      </div>
    </section>
  );
}

// The wax seal breaks, the flap opens, the card rises: 1.2 s. A tap anywhere
// on it (or Skip) ends it at once.
function Unsealing({ onDone }: { onDone: () => void }) {
  const done = useRef(false);
  const finish = () => {
    if (done.current) return;
    done.current = true;
    onDone();
  };
  useEffect(() => {
    const t = window.setTimeout(finish, 1300);
    return () => window.clearTimeout(t);
  }, []);
  return (
    <div class="circle-intro">
      <button type="button" class="unseal is-playing" onClick={finish} aria-label={copy.welcome.unsealing}>
        <svg viewBox="0 0 240 170" aria-hidden="true" focusable="false">
          <rect class="unseal-card" x="30" y="30" width="180" height="110" onAnimationEnd={finish} />
          <rect class="unseal-paper" x="10" y="40" width="220" height="120" />
          <path class="unseal-flap" d="M10 40 L120 110 L230 40 Z" />
          <g class="unseal-seal">
            <circle class="unseal-wax" cx="120" cy="104" r="16" />
            <circle class="unseal-mark" cx="120" cy="104" r="9" />
          </g>
        </svg>
      </button>
      <button type="button" class="button-link unseal-skip" onClick={finish}>{copy.welcome.skip}</button>
    </div>
  );
}

function Choose({ welcome, headingRef, onChosen }: {
  welcome: WelcomeData; headingRef: RefObject<HTMLHeadingElement | null>; onChosen: () => void;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: Event) {
    e.preventDefault();
    if (!picked) return;
    setBusy(true);
    setError(null);
    try {
      await api("/api/circle/welcome", { method: "POST", body: { gift_option_id: picked } });
      onChosen();
    } catch (err) {
      setError(errMessage(err));
      setBusy(false);
    }
  }

  return (
    <>
      <header class="section-heading appear">
        <p class="eyebrow">{copy.welcome.eyebrow}</p>
        <h1 ref={headingRef} tabIndex={-1}>{copy.welcome.chooseTitle}</h1>
      </header>
      {!welcome.options.length ? (
        <div class="circle-intro">
          <p>{copy.welcome.noOptions}</p>
          <div><Link href="/circle" class="button button-secondary">{copy.welcome.goCircle}</Link></div>
        </div>
      ) : (
        <form class="welcome-form appear" onSubmit={submit} noValidate>
          <fieldset>
            <legend>{copy.welcome.chooseLede}</legend>
            <ul class="welcome-options">
              {welcome.options.map((o) => (
                <li key={o.id}>
                  <label class="welcome-option">
                    <input type="radio" name="welcome-piece" value={o.id} checked={picked === o.id}
                      onChange={() => setPicked(o.id)} />
                    {o.image_url && <img src={o.image_url} alt="" loading="lazy" width={320} height={320} />}
                    <span class="welcome-option-title">{o.title}</span>
                    {o.blurb && <span class="welcome-option-blurb">{o.blurb}</span>}
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
          {error && <p class="field-error" role="alert">{error}</p>}
          <div>
            <button type="submit" class="button button-primary" disabled={!picked || busy}>
              {busy ? copy.welcome.choosing : copy.welcome.choose}
            </button>
          </div>
        </form>
      )}
    </>
  );
}
