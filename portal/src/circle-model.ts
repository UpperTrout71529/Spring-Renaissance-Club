// V2 Circle: the API shapes the portal reads (docs/v2-api.md, the backend as
// built) and the small pieces of logic the screens share. Pure functions only
// — no fetch, no DOM — so they are unit-tested in circle-model.test.ts.

export type MembershipStatus = "pending" | "active" | "past_due" | "canceling" | "ended" | "ended_expired";

export type Membership = {
  status: MembershipStatus;
  kind: "join" | "rejoin";
  since: string | null;
  current_period_end: string | null;
  ends_on: string | null;
  end_reason: "canceled" | "payment_failed" | "account_deleted" | "admin" | null;
  credits_grace_until: string | null;
  paid_months: number;
};

export type Accrual = { date: string; amount_cents: number };

// GET /api/circle
export type CircleSummary = {
  membership: Membership | null;
  balance_cents?: number;
  next_accrual?: Accrual | null;
  expires_on?: string | null;
  frozen?: boolean;
  welcome?: { status: string } | null;
  anniversary?: { status: string };
};

// GET /api/circle/join
export type JoinOffer = {
  kind: "join" | "rejoin" | "member";
  open: boolean;
  reason: string | null;
  terms_version: string;
  terms_url: string;
  consents: { id: "terms" | "age_18"; text: string }[];
  region_note: string;
  first_charge_cents?: number;
  monthly_cents?: number;
  joining_cents?: number;
  discount_cents?: number;
  first_renewal_on?: string;
  disclosure?: string;
  invitation_note: string | null;
};

export type WelcomeOption = { id: string; title: string; blurb: string | null; image_url: string | null };
export type WelcomeData = { status: string | null; options: WelcomeOption[] };

export type LedgerRow = { date: string; memo: string; amount_cents: number; kind: string; running_balance_cents: number };
export type CreditsPage = {
  balance_cents: number; next_accrual: Accrual | null; expires_on: string | null; frozen: boolean;
  ledger: LedgerRow[]; next_cursor: string | null;
};

export type Redemption = { id: string; amount_cents: number; code: string | null; last4: string | null; status: string };
export type RedemptionSummary = { id: string; amount_cents: number; last4: string | null; status: string; purpose: string; created_at: string };

export type CancelReason = "spending_less" | "not_finding_pieces" | "too_many_credits" | "order_issue" | "plans_changed" | "other";
export const CANCEL_REASONS: CancelReason[] = ["spending_less", "not_finding_pieces", "too_many_credits", "order_issue", "plans_changed", "other"];
export type CancelOffer = { kind: "concierge" | "use_credits" | "concierge_priority"; copy: string };
export type CancelStart = { cancellation_id: string; offer: CancelOffer | null; ends_on: string; credits_until: string; balance_cents: number };

export type Invoice = { date: string | null; amount_paid_cents: number | null; status: string; url: string | null };
export type MembershipBilling = {
  status: MembershipStatus; kind: "join" | "rejoin"; since: string | null; monthly_cents: number;
  current_period_end: string | null; ends_on: string | null; credits_grace_until: string | null;
  next_charge: Accrual | null; invoices: Invoice[];
};

export type ObjectRelease = {
  id: string; title: string | null; description: string | null; image_url: string | null; price_cents: number | null;
  closes_at: string | null; sold_out: boolean; one_per_member: boolean; remaining?: number;
  // Early access only (GET /api/circle/early-access).
  public_release_at?: string | null; ships_note?: string | null; member_price_cents?: number | null;
};
export type ObjectClaim = { status: string; reserved_until: string | null; invoice_url: string | null };
export type ObjectView = { release: ObjectRelease | null; claim: ObjectClaim | null; can_claim: boolean; reason: string | null };

export type InviteData = {
  code: string; link: string; discount_cents: number; reward_cents: number; season: string;
  this_season: "none" | "joined" | "counted"; paused: boolean;
};

export type UsAddress = { name: string; line1: string; line2: string; city: string; state: string; postal_code: string };
export type AnniversaryGift = {
  id: string; n: number; status: string;
  address: { line1?: string; line2?: string | null; city?: string; state?: string; postal_code?: string; country?: string } | null;
  name: string | null;
};

export type Capsule = {
  id: string; season: string; title: string; price_cents: number; opens_at: string; closes_at: string;
  skipped: boolean; claimed: boolean; product_url: string | null; eligible: boolean; reason: string | null;
};
export type CapsulesData = { current: Capsule | null; upcoming: Capsule[] };
export type CapsuleClaim = { capsule_id: string; amount_cents: number; code: string | null; last4?: string; product_url: string | null };

export type ConciergeMessage = { id: string; author: "member" | "maison"; body: string; created_at: string };
export type RoomPhoto = { id: string; room_label: string; note: string | null; created_at: string };

// ---- membership state ------------------------------------------------------

const LIVE: MembershipStatus[] = ["active", "past_due", "canceling"];

export function isLive(m: Membership | null | undefined): boolean {
  return !!m && LIVE.includes(m.status);
}

// Which /circle a person sees: the member page for a live membership and for
// an ended one whose credits are still usable; the Club page otherwise
// (never joined, or ended with the credits expired — they can rejoin there).
export function circleView(summary: CircleSummary | null): "member" | "club" {
  const m = summary?.membership;
  if (!m) return "club";
  if (isLive(m) || m.status === "ended" || m.status === "pending") return "member";
  return "club";
}

// The §6.7 banner for this membership, if any.
export type Banner =
  | { kind: "past_due" }
  | { kind: "canceling"; endsOn: string; creditsUntil: string }
  | { kind: "ended"; expiresOn: string | null; balanceCents: number; paymentFailed: boolean };

export function bannerFor(summary: CircleSummary): Banner | null {
  const m = summary.membership;
  if (!m) return null;
  if (m.status === "past_due") return { kind: "past_due" };
  if (m.status === "canceling") {
    const endsOn = m.ends_on ?? dayOf(m.current_period_end);
    if (!endsOn) return null;
    return { kind: "canceling", endsOn, creditsUntil: creditsUntil(m) ?? addDays(endsOn, GRACE_DAYS) };
  }
  if (m.status === "ended") {
    return {
      kind: "ended",
      expiresOn: summary.expires_on ?? m.credits_grace_until,
      balanceCents: Math.max(0, summary.balance_cents ?? 0),
      paymentFailed: m.end_reason === "payment_failed",
    };
  }
  return null;
}

// Credits stay usable this many days after the last paid period (spec §14.1;
// GRACE_DAYS in src/circle/stripe-events.js).
export const GRACE_DAYS = 30;

export function creditsUntil(m: Membership): string | null {
  return m.credits_grace_until ? dayOf(m.credits_grace_until) : null;
}

export function dayOf(iso: string | null | undefined): string | null {
  return iso ? String(iso).slice(0, 10) : null;
}

export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day.slice(0, 10)}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}

// ---- credits and money -----------------------------------------------------

// 1 credit = $1 = 100 cents. Whole numbers show without decimals ("46");
// a refund reversal can leave cents ("10.50").
export function creditsText(cents: number): string {
  const v = Math.abs(cents) / 100;
  const s = Number.isInteger(v) ? String(v) : v.toFixed(2);
  return cents < 0 ? `-${s}` : s;
}

// A ledger amount with its sign: "+20", "−14" (a true minus sign).
export function signedCredits(cents: number): string {
  if (cents === 0) return "0";
  return `${cents > 0 ? "+" : "−"}${creditsText(Math.abs(cents))}`;
}

// "$46" for whole dollars, "$46.50" otherwise — as the server's own copy.
export function usd(cents: number): string {
  const v = Math.abs(cents) / 100;
  const s = Number.isInteger(v) ? v.toLocaleString("en-US") : v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${cents < 0 ? "-" : ""}$${s}`;
}

// Whole credits that can be spent from a balance (never below zero).
export function spendableCredits(balanceCents: number): number {
  return Math.max(0, Math.floor(balanceCents / 100));
}

export type AmountCheck = { ok: true; credits: number } | { ok: false; error: "whole" | "min" | "max" };

// Step 1 of "Use credits": whole credits, at least 1, at most the balance.
export function checkAmount(raw: string, max: number): AmountCheck {
  const t = raw.trim();
  if (t === "") return { ok: false, error: "min" };
  if (!/^\d+$/.test(t)) return { ok: false, error: "whole" };
  const n = Number(t);
  if (n < 1) return { ok: false, error: "min" };
  if (n > max) return { ok: false, error: "max" };
  return { ok: true, credits: n };
}

// A fresh key per attempt (spec §16.3 #5); the server accepts [A-Za-z0-9_-]{1,100}.
export function newIdempotencyKey(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- joining ---------------------------------------------------------------

export type JoinState = "open" | "closed" | "member";

export function joinState(offer: JoinOffer): JoinState {
  if (offer.kind === "member") return "member";
  return offer.open && offer.disclosure ? "open" : "closed";
}

export type ConsentState = Partial<Record<"terms" | "age_18", boolean>>;

// The button stays disabled until every consent the server listed is ticked.
export function consentsComplete(offer: JoinOffer, ticked: ConsentState): boolean {
  return offer.consents.length > 0 && offer.consents.every((c) => ticked[c.id] === true);
}

export function checkoutBody(offer: JoinOffer, invite: string | null) {
  return {
    consents: { terms: true, age_18: true },
    terms_version: offer.terms_version,
    ...(offer.kind === "join" && invite ? { invite_code: invite } : {}),
  };
}

// ---- welcome (spec §16.3 #2) --------------------------------------------------

export const POLL_EVERY_MS = 2000;
export const POLL_FOR_MS = 20000;

// The membership is confirmed once the webhook has made it live.
export function confirmed(summary: CircleSummary | null): boolean {
  return isLive(summary?.membership ?? null);
}

// ---- members' object -------------------------------------------------------

export type ObjectState = "none" | "available" | "reserved" | "paid" | "sold_out" | "closed" | "paused" | "members_only" | "unavailable";

export function objectState(view: ObjectView, nowMs: number): ObjectState {
  const { release, claim } = view;
  if (!release) return "none";
  if (claim?.status === "paid") return "paid";
  if (claim?.status === "invoiced" || claim?.status === "creating") return "reserved";
  if (release.closes_at && Date.parse(release.closes_at) <= nowMs) return "closed";
  if (view.can_claim) return "available";
  switch (view.reason) {
    case "sold_out": return "sold_out";
    case "paused": return "paused";
    case "members_only": return "members_only";
    case "already_claimed": return "reserved";
    default: return release.sold_out ? "sold_out" : "unavailable";
  }
}

// ---- anniversary address (mirrors usAddress in src/circle/anniversary.js) ----

export type AddressErrors = Partial<Record<keyof UsAddress, "required" | "state" | "zip">>;

export function checkAddress(a: UsAddress): AddressErrors {
  const e: AddressErrors = {};
  if (!a.name.trim()) e.name = "required";
  if (!a.line1.trim()) e.line1 = "required";
  if (!a.city.trim()) e.city = "required";
  if (!/^[A-Z]{2}$/.test(a.state.trim().toUpperCase())) e.state = "state";
  if (!/^\d{5}(-\d{4})?$/.test(a.postal_code.trim())) e.postal_code = "zip";
  return e;
}

export function addressFromGift(gift: AnniversaryGift): UsAddress {
  const a = gift.address ?? {};
  return {
    name: gift.name ?? "", line1: a.line1 ?? "", line2: a.line2 ?? "", city: a.city ?? "",
    state: (a.state ?? "").toUpperCase(), postal_code: a.postal_code ?? "",
  };
}

// ---- rooms -----------------------------------------------------------------

// The longest side of a re-encoded room photo; large enough to see a room,
// small enough to stay well under the 10 MB limit.
export const ROOM_MAX_SIDE = 2400;

export function fitWithin(width: number, height: number, max = ROOM_MAX_SIDE): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: 0, height: 0 };
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

// "2026Q4" → "Oct–Dec 2026" (a season is a UTC calendar quarter, Felix §19 #6).
export function seasonLabel(season: string): string {
  const m = /^(\d{4})Q([1-4])$/.exec(season);
  if (!m) return season;
  const months = [["Jan", "Mar"], ["Apr", "Jun"], ["Jul", "Sep"], ["Oct", "Dec"]][Number(m[2]) - 1];
  return `${months[0]}–${months[1]} ${m[1]}`;
}
