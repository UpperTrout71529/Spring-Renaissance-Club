// /circle for members (spec v1.1 §6.7; docs/tz-v2-circle.md §3.1): the
// Treasury, the welcome piece until chosen, early access and the members'
// object only while a release is open, capsules, invite, concierge, rooms,
// the anniversary only while a gift waits for an address, and billing.
// Banners for past_due / canceling / ended (§6.7, verbatim).

import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { ArrowRight } from "lucide-preact";
import { api } from "../../api";
import { copy } from "../../copy/en";
import { formatDate, formatMonthYear } from "../../format";
import {
  bannerFor, creditsText, isLive, usd,
  type CapsulesData, type CircleSummary, type ObjectView,
} from "../../circle-model";
import { Link } from "../../ui/Link";
import { errMessage } from "./shared";

type Props = { summary: CircleSummary; canceled: boolean; onChanged: () => void };

// Opens Stripe's Customer Portal for the card (POST → redirect).
export async function openBillingPortal(): Promise<void> {
  const { url } = await api<{ url: string }>("/api/account/membership/portal", { method: "POST", body: {} });
  window.location.assign(url);
}

function BlockLink({ href, children, strong = false }: { href: string; children: string; strong?: boolean }) {
  return (
    <Link href={href} class={`block-link${strong ? " block-link-strong" : ""}`}>
      <span>{children}</span>
      <ArrowRight size={18} strokeWidth={1.5} aria-hidden="true" />
    </Link>
  );
}

function Banner({ summary, onChanged }: { summary: CircleSummary; onChanged: () => void }) {
  const banner = bannerFor(summary);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!banner) return null;

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errMessage(e));
      setBusy(false);
    }
  }

  let body;
  if (banner.kind === "past_due") {
    body = (
      <>
        <p>{copy.member.pastDue}</p>
        <button type="button" class="button button-secondary" disabled={busy} onClick={() => act(openBillingPortal)}>{copy.member.updateCard}</button>
      </>
    );
  } else if (banner.kind === "canceling") {
    body = (
      <>
        <p>{copy.member.canceling(formatDate(banner.endsOn), formatDate(banner.creditsUntil))}</p>
        <button type="button" class="button button-secondary" disabled={busy}
          onClick={() => act(async () => { await api("/api/circle/cancel/undo", { method: "POST", body: {} }); onChanged(); })}>
          {copy.member.keep}
        </button>
      </>
    );
  } else {
    const credits = banner.balanceCents > 0 && banner.expiresOn;
    body = (
      <>
        {credits
          ? <p>{copy.member.endedCredits(copy.member.balance(creditsText(banner.balanceCents)), formatDate(banner.expiresOn!))}</p>
          : <p>{copy.member.ended}</p>}
        {banner.paymentFailed && <p>{copy.member.endedPayment}</p>}
        <div class="circle-actions">
          {credits && <Link href="/circle/credits/use" class="button button-secondary">{copy.member.useCredits}</Link>}
          <Link href="/circle/join" class="button button-primary">{copy.member.rejoin}</Link>
        </div>
      </>
    );
  }
  return (
    <div class="circle-banner">
      {body}
      {error && <p class="field-error" role="alert">{error}</p>}
    </div>
  );
}

function Treasury({ summary }: { summary: CircleSummary }) {
  const balance = summary.balance_cents ?? 0;
  const next = summary.next_accrual;
  return (
    <section class="circle-block circle-block-strong" aria-labelledby="treasury-title">
      <h2 id="treasury-title" class="eyebrow">{copy.member.treasury}</h2>
      <p class="treasury-balance">{copy.member.balance(creditsText(balance))}</p>
      <p>{copy.member.toSpend(usd(Math.max(0, balance)))}</p>
      {next && <p>{copy.member.nextAccrual(creditsText(next.amount_cents), formatDate(next.date))}</p>}
      {summary.frozen && <p>{copy.member.frozen}</p>}
      {!summary.frozen && balance < 0 && <p>{copy.member.negative}</p>}
      <div class="treasury-actions">
        {balance >= 100 && !summary.frozen && <Link href="/circle/credits/use" class="button button-primary">{copy.member.useCredits}</Link>}
        <Link href="/circle/credits" class="button button-secondary">{copy.member.history}</Link>
      </div>
    </section>
  );
}

function Block({ id, title, body, children }: { id: string; title: string; body?: string; children: ComponentChildren }) {
  return (
    <section class="circle-block" aria-labelledby={id}>
      <h2 id={id} class="eyebrow">{title}</h2>
      {body && <p>{body}</p>}
      {children}
    </section>
  );
}

export function CircleMember({ summary, canceled, onChanged }: Props) {
  const m = summary.membership!;
  const live = isLive(m);
  const [object, setObject] = useState<ObjectView | null>(null);
  const [early, setEarly] = useState<ObjectView | null>(null);
  const [capsules, setCapsules] = useState<CapsulesData | null>(null);

  useEffect(() => {
    if (!live) return;
    // Each block loads on its own; one that fails simply does not show.
    api<ObjectView>("/api/circle/object").then(setObject).catch(() => {});
    api<ObjectView>("/api/circle/early-access").then(setEarly).catch(() => {});
    api<CapsulesData>("/api/circle/capsules").then(setCapsules).catch(() => {});
  }, [live]);

  const capsuleLine = capsules?.current
    ? copy.member.capsuleOpen(capsules.current.title)
    : capsules?.upcoming[0] ? copy.member.nextCapsule(capsules.upcoming[0].season) : copy.member.capsulesNone;

  return (
    <div class="circle-member">
      <header class="section-heading appear">
        <h1>{copy.member.title}</h1>
        {m.since && <p class="eyebrow">{copy.member.since(formatMonthYear(m.since))}</p>}
      </header>
      {canceled && <p class="notice circle-notice" role="status">{copy.club.checkoutCanceled}</p>}
      {m.status === "pending" && <p class="notice circle-notice" role="status">{copy.member.pending}</p>}
      <Banner summary={summary} onChanged={onChanged} />

      <div class="circle-stack appear">
        <Treasury summary={summary} />

        {live && summary.welcome?.status === "awaiting_choice" && (
          <Block id="welcome-title" title={copy.member.welcome}>
            <BlockLink href="/circle/welcome" strong>{copy.member.welcomeCta}</BlockLink>
          </Block>
        )}

        {live && early?.release && (
          <Block id="early-title" title={copy.member.early} body={copy.member.earlyBody}>
            <BlockLink href="/circle/early-access">{copy.member.earlyCta}</BlockLink>
          </Block>
        )}

        {live && object?.release && (
          <Block id="object-title" title={copy.member.object} body={copy.member.objectBody}>
            <BlockLink href="/circle/object">{copy.member.objectCta}</BlockLink>
          </Block>
        )}

        {live && summary.anniversary?.status === "awaiting_address" && (
          <Block id="anniversary-title" title={copy.member.anniversary} body={copy.member.anniversaryBody}>
            <BlockLink href="/circle/anniversary">{copy.member.anniversaryCta}</BlockLink>
          </Block>
        )}

        {live && (
          <Block id="capsules-title" title={copy.member.capsules} body={capsuleLine}>
            <BlockLink href="/circle/capsules">{copy.member.capsulesCta}</BlockLink>
          </Block>
        )}

        {m.status === "active" && (
          <Block id="invite-title" title={copy.member.invite} body={copy.member.inviteBody}>
            <BlockLink href="/circle/invite">{copy.member.inviteCta}</BlockLink>
          </Block>
        )}

        {live && (
          <Block id="concierge-title" title={copy.member.concierge}>
            <BlockLink href="/circle/concierge">{copy.member.conciergeCta}</BlockLink>
          </Block>
        )}

        {live && (
          <Block id="rooms-title" title={copy.member.rooms} body={copy.member.roomsBody}>
            <BlockLink href="/circle/rooms">{copy.member.roomsCta}</BlockLink>
          </Block>
        )}

        <div class="circle-block">
          <BlockLink href="/account/membership">{copy.member.billing}</BlockLink>
        </div>
      </div>
    </div>
  );
}
