// The Circle in V1 (spec §6.3 teaser, §6.6 screen; S8). No modals, no
// timers, no counts of "places left" — the invitation sits below the useful
// things and can be put away for 30 days.

import { useEffect, useState } from "preact/hooks";
import { api, track } from "../api";
import { copy } from "../copy/en";
import { CIRCLE_FAQ, CIRCLE_FAQ_TITLE } from "../copy/circle-faq";
import { formatMoney } from "../format";
import { Link } from "../ui/Link";
import { Skeleton } from "../ui/states";
import { SectionHeading } from "./Placeholder";
import "./circle.css";

const SHOW_FAQ = import.meta.env.VITE_CIRCLE_FAQ === "1";

export type Teaser = {
  sealed_count: number;
  show_count: boolean;
  member_price_examples: { handle: string; title: string; price_cents: number; member_price_cents: number }[];
  snoozed_until: string | null;
  on_waitlist: boolean;
};

// Abstract sealed envelopes (§6.3: never photos of the real pieces).
function SealedEnvelopes() {
  return (
    <svg class="sealed" viewBox="0 0 240 92" aria-hidden="true" focusable="false">
      {[0, 1, 2].map((i) => (
        <g key={i} transform={`translate(${20 + i * 64} ${14 + (i % 2) * 10}) rotate(${(i - 1) * 4} 40 30)`}>
          <rect class="sealed-paper" x="0" y="0" width="80" height="56" />
          <path class="sealed-line" d="M0 0 L40 32 L80 0" />
          <circle class="sealed-wax" cx="40" cy="32" r="8" />
          <circle class="sealed-mark" cx="40" cy="32" r="4.5" />
        </g>
      ))}
    </svg>
  );
}

function useTeaser() {
  const [teaser, setTeaser] = useState<Teaser | null>(null);
  useEffect(() => {
    api<Teaser>("/api/circle/teaser").then(setTeaser).catch(() => {});
  }, []);
  return [teaser, setTeaser] as const;
}

function Reserve({ teaser, onJoined }: { teaser: Teaser; onJoined: () => void }) {
  const [busy, setBusy] = useState(false);
  if (teaser.on_waitlist) return <p class="circle-onlist" role="status">{copy.circle.onList}</p>;
  async function join() {
    setBusy(true);
    try {
      await api("/api/circle/waitlist", { method: "POST", body: {} });
      onJoined();
    } catch {
      setBusy(false);
    }
  }
  return (
    <div class="circle-reserve">
      <p class="eyebrow">{copy.circle.openingSoon}</p>
      <button type="button" class="button button-primary" disabled={busy} onClick={join}>
        {busy ? copy.circle.reserving : copy.circle.reserve}
      </button>
    </div>
  );
}

function PriceLines({ teaser }: { teaser: Teaser }) {
  if (!teaser.member_price_examples.length) return null;
  return (
    <ul class="circle-prices">
      {teaser.member_price_examples.map((e) => (
        <li key={e.handle}>{copy.circle.memberPrice(e.title, formatMoney(e.member_price_cents))}</li>
      ))}
    </ul>
  );
}

// Home, below orders and Saved (§6.3).
export function CircleTeaser() {
  const [teaser, setTeaser] = useTeaser();
  const open = !!teaser && !teaser.snoozed_until;
  // Viewed once per Home visit, and only when the full teaser shows.
  useEffect(() => {
    if (open) track({ name: "circle_teaser_viewed", props: { placement: "home" } });
  }, [open]);
  if (!teaser) return null;

  if (teaser.snoozed_until) {
    return (
      <p class="circle-collapsed">
        <Link href="/circle">{copy.circle.collapsed}</Link>
      </p>
    );
  }

  async function notNow() {
    try {
      await api("/api/me", { method: "PATCH", body: { circle_teaser_snooze: true } });
      setTeaser({ ...teaser!, snoozed_until: new Date(Date.now() + 30 * 86400000).toISOString() });
    } catch {
      // Leave it; it can be put away next time.
    }
  }

  return (
    <section class="circle-teaser home-card appear" aria-labelledby="circle-teaser-title">
      <p class="eyebrow">{copy.circle.eyebrow}</p>
      <SealedEnvelopes />
      <h2 id="circle-teaser-title">{copy.circle.title}</h2>
      <p>{copy.circle.body}</p>
      <p>{copy.circle.value}</p>
      <PriceLines teaser={teaser} />
      <Reserve teaser={teaser} onJoined={() => setTeaser({ ...teaser, on_waitlist: true })} />
      <div class="circle-actions">
        <Link href="/circle" class="button button-secondary"
          onClick={() => track({ name: "circle_teaser_clicked", props: { placement: "home" } })}>{copy.circle.learn}</Link>
        <button type="button" class="button-link" onClick={notNow}>{copy.circle.notNow}</button>
      </div>
    </section>
  );
}

// /circle for Club members (§6.6).
export function CircleScreen() {
  const [teaser, setTeaser] = useTeaser();
  return (
    <>
      <SectionHeading eyebrow={copy.circle.eyebrow} title={copy.circle.title} />
      <div class="circle-page appear">
        <SealedEnvelopes />
        <p>{copy.circle.body}</p>
        <p>{copy.circle.value}</p>
        {teaser ? (
          <>
            <PriceLines teaser={teaser} />
            <Reserve teaser={teaser} onJoined={() => setTeaser({ ...teaser, on_waitlist: true })} />
          </>
        ) : <Skeleton lines={2} label={copy.circle.loading} />}

        <section aria-labelledby="circle-how">
          <h2 id="circle-how">{copy.circle.howTitle}</h2>
          <ol class="circle-steps">
            {copy.circle.steps.map((s) => <li key={s}>{s}</li>)}
          </ol>
        </section>

        {/* PENDING LEGAL REVIEW: the FAQ restates membership terms the lawyer
            has not approved (P0.7). Off unless the build sets VITE_CIRCLE_FAQ=1
            — never in production until Felix signs the terms off. */}
        {SHOW_FAQ && (
          <section aria-labelledby="circle-faq">
            <h2 id="circle-faq">{CIRCLE_FAQ_TITLE}</h2>
            <div class="circle-faq">
              {CIRCLE_FAQ.map((f) => (
                <details key={f.q}>
                  <summary>{f.q}</summary>
                  <p>{f.a}</p>
                </details>
              ))}
            </div>
          </section>
        )}
      </div>
    </>
  );
}
