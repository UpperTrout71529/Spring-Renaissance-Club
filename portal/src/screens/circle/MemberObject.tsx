// /circle/object (docs/tz-v2-circle.md §8, §16; D26–D28) and
// /circle/early-access (T21): one piece, bought only through a reservation
// → a Shopify invoice. No name until Felix sets one; "One per member"; the
// remaining count only when Felix shows it; for early access the ship note
// and public release date only when Felix entered them — nothing invented.
// While Shopify is unreachable a claim may wait in "creating" (no invoice
// link yet): the page says so calmly.

import { useState } from "preact/hooks";
import { api, ApiError } from "../../api";
import { copy } from "../../copy/en";
import { formatDate, formatDateTime } from "../../format";
import { objectState, usd, type ObjectClaim, type ObjectView } from "../../circle-model";
import { EmptyState, ErrorState, Skeleton } from "../../ui/states";
import { SectionHeading } from "../Placeholder";
import { BackToCircle, errMessage, useApi } from "./shared";

type Kind = "object" | "early";

const PATHS: Record<Kind, { get: string; claim: string }> = {
  object: { get: "/api/circle/object", claim: "/api/circle/object/claim" },
  early: { get: "/api/circle/early-access", claim: "/api/circle/early-access/claim" },
};

// A refused claim maps onto the page's own states (409 codes from the API).
const CLAIM_CODES: Record<string, ObjectView["reason"]> = {
  sold_out: "sold_out", release_closed: "closed", release_paused: "paused", members_only: "members_only",
};

export function MemberObject({ kind }: { kind: Kind }) {
  const { state, reload, set } = useApi<ObjectView>(PATHS[kind].get);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const title = kind === "early" ? copy.early.title : copy.memberObject.title;
  const eyebrow = kind === "early" ? copy.early.eyebrow : copy.memberObject.eyebrow;

  if (state.kind === "loading") {
    return <><BackToCircle /><SectionHeading eyebrow={eyebrow} title={title} /><Skeleton lines={5} label={kind === "early" ? copy.early.loading : copy.memberObject.loading} /></>;
  }
  if (state.kind === "error") return <><BackToCircle /><ErrorState body={state.message} onRetry={reload} /></>;

  const view = state.data;
  const release = view.release;
  if (!release) {
    return (
      <>
        <BackToCircle />
        <SectionHeading eyebrow={eyebrow} title={title} />
        <EmptyState
          title={kind === "early" ? copy.early.noneTitle : copy.memberObject.noneTitle}
          body={kind === "early" ? copy.early.noneBody : copy.memberObject.noneBody}
        />
      </>
    );
  }

  const st = objectState(view, Date.now());
  const price = kind === "early" && release.member_price_cents != null ? release.member_price_cents : release.price_cents;

  async function reserve() {
    setBusy(true);
    setError(null);
    try {
      const claim = await api<ObjectClaim>(PATHS[kind].claim, { method: "POST", body: { release_id: release!.id } });
      set({ ...view, claim, can_claim: false, reason: "already_claimed" });
    } catch (e) {
      const reason = e instanceof ApiError ? CLAIM_CODES[e.code] : undefined;
      if (reason === "closed") set({ ...view, can_claim: false, reason: null, release: { ...release!, closes_at: new Date(0).toISOString() } });
      else if (reason) set({ ...view, can_claim: false, reason });
      else setError(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <BackToCircle />
      <SectionHeading eyebrow={eyebrow} title={title} />
      <div class="circle-intro appear">
        {kind === "early" && <p>{copy.early.lede}</p>}
        {release.image_url && (
          <figure class="object-figure">
            <img src={release.image_url} alt={release.title ?? ""} width={720} height={900} />
          </figure>
        )}
        {release.title && <h2>{release.title}</h2>}
        {release.description && <p>{release.description}</p>}
        {price != null && <p class="object-price">{usd(price)}</p>}
        {kind === "early" && release.member_price_cents != null && release.price_cents != null && release.member_price_cents < release.price_cents && (
          <p class="small">{copy.early.regularPrice(usd(release.price_cents))}</p>
        )}
        <p>{copy.memberObject.onePer}</p>
        {typeof release.remaining === "number" && st === "available" && <p>{copy.memberObject.remaining(release.remaining)}</p>}
        {kind === "early" && release.public_release_at && <p>{copy.early.publicRelease(formatDate(release.public_release_at))}</p>}
        {kind === "early" && release.ships_note && <p>{release.ships_note}</p>}
        {release.closes_at && st === "available" && <p class="small">{copy.memberObject.openUntil(formatDate(release.closes_at))}</p>}

        <div class="object-state" role="status">
          {st === "available" && (
            <button type="button" class="button button-primary" disabled={busy} onClick={reserve}>
              {busy ? copy.memberObject.reserving : copy.memberObject.reserve}
            </button>
          )}
          {st === "reserved" && view.claim?.status === "creating" && <p>{copy.memberObject.preparing}</p>}
          {st === "reserved" && view.claim && view.claim.status !== "creating" && (
            <>
              {view.claim.reserved_until && <p>{copy.memberObject.reserved(formatDateTime(view.claim.reserved_until))}</p>}
              {view.claim.invoice_url && <a class="button button-primary" href={view.claim.invoice_url}>{copy.memberObject.payNow}</a>}
            </>
          )}
          {st === "paid" && <p>{copy.memberObject.paid}</p>}
          {st === "sold_out" && <p>{copy.memberObject.soldOut}</p>}
          {st === "closed" && <p>{copy.memberObject.closed}</p>}
          {st === "paused" && <p>{copy.memberObject.paused}</p>}
          {st === "members_only" && <p>{copy.memberObject.membersOnly}</p>}
          {st === "unavailable" && <p>{copy.memberObject.unavailable}</p>}
        </div>
        {error && <p class="field-error" role="alert">{error}</p>}
      </div>
    </>
  );
}
