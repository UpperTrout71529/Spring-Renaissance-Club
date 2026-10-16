import { describe, expect, it } from "vitest";
import {
  addDays, bannerFor, checkAddress, checkAmount, checkoutBody, circleView, confirmed, consentsComplete,
  creditsText, fitWithin, joinState, newIdempotencyKey, objectState, seasonLabel, signedCredits,
  spendableCredits, usd, type CircleSummary, type JoinOffer, type Membership, type ObjectView,
} from "./circle-model";

const member = (over: Partial<Membership> = {}): Membership => ({
  status: "active", kind: "join", since: "2026-10-14T10:00:00Z", current_period_end: "2026-11-14T10:00:00Z",
  ends_on: null, end_reason: null, credits_grace_until: null, paid_months: 1, ...over,
});

const offer = (over: Partial<JoinOffer> = {}): JoinOffer => ({
  kind: "join", open: true, reason: null, terms_version: "v1", terms_url: "https://x/terms/membership",
  consents: [{ id: "terms", text: "I agree…" }, { id: "age_18", text: "I am 18 or older." }],
  region_note: "US", first_charge_cents: 5000, monthly_cents: 2000, joining_cents: 3000, discount_cents: 0,
  first_renewal_on: "2026-11-16", disclosure: "By joining…", invitation_note: null, ...over,
});

describe("which /circle", () => {
  it("shows the member page for live and ended (grace) memberships, the Club page otherwise", () => {
    expect(circleView(null)).toBe("club");
    expect(circleView({ membership: null })).toBe("club");
    for (const status of ["active", "past_due", "canceling", "ended", "pending"] as const) {
      expect(circleView({ membership: member({ status }) })).toBe("member");
    }
    expect(circleView({ membership: member({ status: "ended_expired" }) })).toBe("club");
  });

  it("is confirmed only once the webhook made the membership live", () => {
    expect(confirmed(null)).toBe(false);
    expect(confirmed({ membership: null })).toBe(false);
    expect(confirmed({ membership: member({ status: "ended" }) })).toBe(false); // a rejoin before the webhook
    expect(confirmed({ membership: member({ status: "pending" }) })).toBe(false);
    expect(confirmed({ membership: member() })).toBe(true);
  });
});

describe("§6.7 banners", () => {
  it("past_due", () => {
    expect(bannerFor({ membership: member({ status: "past_due" }) })).toEqual({ kind: "past_due" });
  });

  it("canceling: the end date and credits 30 days later (or the server's grace date)", () => {
    const s: CircleSummary = { membership: member({ status: "canceling", ends_on: "2026-11-14" }) };
    expect(bannerFor(s)).toEqual({ kind: "canceling", endsOn: "2026-11-14", creditsUntil: "2026-12-14" });
    s.membership!.credits_grace_until = "2026-12-20T00:00:00Z";
    expect(bannerFor(s)).toMatchObject({ creditsUntil: "2026-12-20" });
    // ends_on missing: the period end is the end.
    expect(bannerFor({ membership: member({ status: "canceling", ends_on: null }) })).toMatchObject({ endsOn: "2026-11-14" });
  });

  it("ended: credits until the grace date, and why it ended", () => {
    const s: CircleSummary = {
      membership: member({ status: "ended", end_reason: "payment_failed", credits_grace_until: "2026-12-14T00:00:00Z" }),
      balance_cents: 4600, expires_on: "2026-12-14",
    };
    expect(bannerFor(s)).toEqual({ kind: "ended", expiresOn: "2026-12-14", balanceCents: 4600, paymentFailed: true });
    expect(bannerFor({ ...s, balance_cents: -300 })).toMatchObject({ balanceCents: 0 });
  });

  it("none for an active membership", () => {
    expect(bannerFor({ membership: member() })).toBeNull();
  });

  it("adds days across months and years in UTC", () => {
    expect(addDays("2026-11-14", 30)).toBe("2026-12-14");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-08T23:30:00Z", 1)).toBe("2026-03-09");
  });
});

describe("credits and money", () => {
  it("shows whole credits plainly and cents when a reversal left some", () => {
    expect(creditsText(4600)).toBe("46");
    expect(creditsText(1050)).toBe("10.50");
    expect(creditsText(0)).toBe("0");
    expect(creditsText(-300)).toBe("-3");
  });

  it("signs ledger amounts with a true minus", () => {
    expect(signedCredits(2000)).toBe("+20");
    expect(signedCredits(-1400)).toBe("−14");
    expect(signedCredits(-1050)).toBe("−10.50");
    expect(signedCredits(0)).toBe("0");
  });

  it("formats dollars like the server's copy", () => {
    expect(usd(4600)).toBe("$46");
    expect(usd(4650)).toBe("$46.50");
    expect(usd(123400)).toBe("$1,234");
    expect(usd(1000)).toBe("$10");
  });

  it("spends whole credits only, never below zero", () => {
    expect(spendableCredits(4650)).toBe(46);
    expect(spendableCredits(99)).toBe(0);
    expect(spendableCredits(-500)).toBe(0);
  });

  it("checks the amount: whole, at least 1, at most the balance", () => {
    expect(checkAmount("46", 46)).toEqual({ ok: true, credits: 46 });
    expect(checkAmount(" 1 ", 46)).toEqual({ ok: true, credits: 1 });
    expect(checkAmount("47", 46)).toEqual({ ok: false, error: "max" });
    expect(checkAmount("0", 46)).toEqual({ ok: false, error: "min" });
    expect(checkAmount("", 46)).toEqual({ ok: false, error: "min" });
    expect(checkAmount("2.5", 46)).toEqual({ ok: false, error: "whole" });
    expect(checkAmount("-3", 46)).toEqual({ ok: false, error: "whole" });
    expect(checkAmount("1e3", 46)).toEqual({ ok: false, error: "whole" });
  });

  it("makes a fresh idempotency key each time, in the server's alphabet", () => {
    const a = newIdempotencyKey();
    const b = newIdempotencyKey();
    expect(a).not.toBe(b);
    for (const k of [a, b]) expect(k).toMatch(/^[A-Za-z0-9_-]{1,100}$/);
  });
});

describe("joining", () => {
  it("is open only with a disclosure to show", () => {
    expect(joinState(offer())).toBe("open");
    expect(joinState(offer({ kind: "rejoin" }))).toBe("open");
    expect(joinState(offer({ open: false, reason: "not_open", disclosure: undefined }))).toBe("closed");
    expect(joinState(offer({ disclosure: undefined }))).toBe("closed");
    expect(joinState(offer({ kind: "member", open: false }))).toBe("member");
  });

  it("needs every consent the server listed, ticked", () => {
    const o = offer();
    expect(consentsComplete(o, {})).toBe(false);
    expect(consentsComplete(o, { terms: true })).toBe(false);
    expect(consentsComplete(o, { terms: true, age_18: false })).toBe(false);
    expect(consentsComplete(o, { terms: true, age_18: true })).toBe(true);
    expect(consentsComplete(offer({ consents: [] }), { terms: true, age_18: true })).toBe(false);
  });

  it("sends the terms version, and the invitation only on a first join", () => {
    expect(checkoutBody(offer(), "ABC123")).toEqual({ consents: { terms: true, age_18: true }, terms_version: "v1", invite_code: "ABC123" });
    expect(checkoutBody(offer(), null)).toEqual({ consents: { terms: true, age_18: true }, terms_version: "v1" });
    expect(checkoutBody(offer({ kind: "rejoin" }), "ABC123")).not.toHaveProperty("invite_code");
  });
});

describe("members' object states", () => {
  const now = Date.parse("2026-10-16T12:00:00Z");
  const release = { id: "r1", title: null, description: "d", image_url: null, price_cents: 18000, closes_at: "2026-10-30T00:00:00Z", sold_out: false, one_per_member: true };
  const v = (over: Partial<ObjectView> = {}): ObjectView => ({ release, claim: null, can_claim: true, reason: null, ...over });

  it("maps the API to one state", () => {
    expect(objectState(v({ release: null, can_claim: false, reason: "no_release" }), now)).toBe("none");
    expect(objectState(v(), now)).toBe("available");
    expect(objectState(v({ claim: { status: "invoiced", reserved_until: "x", invoice_url: "u" }, can_claim: false, reason: "already_claimed" }), now)).toBe("reserved");
    expect(objectState(v({ claim: { status: "paid", reserved_until: null, invoice_url: null }, can_claim: false, reason: "already_claimed" }), now)).toBe("paid");
    expect(objectState(v({ can_claim: false, reason: "sold_out", release: { ...release, sold_out: true } }), now)).toBe("sold_out");
    expect(objectState(v({ can_claim: false, reason: "paused" }), now)).toBe("paused");
    expect(objectState(v({ can_claim: false, reason: "members_only" }), now)).toBe("members_only");
    expect(objectState(v({ release: { ...release, closes_at: "2026-10-01T00:00:00Z" } }), now)).toBe("closed");
  });

  it("an expired reservation can be claimed again while the edition has room", () => {
    expect(objectState(v({ claim: { status: "expired", reserved_until: null, invoice_url: null } }), now)).toBe("available");
  });

  it("a paid piece stays paid after the release closes", () => {
    expect(objectState(v({ claim: { status: "paid", reserved_until: null, invoice_url: null }, release: { ...release, closes_at: "2026-10-01T00:00:00Z" } }), now)).toBe("paid");
  });
});

describe("anniversary address (as the server checks it)", () => {
  const ok = { name: "Clara Duval", line1: "1 Main St", line2: "", city: "Austin", state: "TX", postal_code: "78701" };
  it("accepts a full US address", () => {
    expect(checkAddress(ok)).toEqual({});
    expect(checkAddress({ ...ok, state: "tx", postal_code: "78701-1234" })).toEqual({});
  });
  it("names each missing or malformed field", () => {
    expect(checkAddress({ ...ok, name: " ", line1: "", city: "" })).toEqual({ name: "required", line1: "required", city: "required" });
    expect(checkAddress({ ...ok, state: "Texas" })).toEqual({ state: "state" });
    expect(checkAddress({ ...ok, postal_code: "7870" })).toEqual({ postal_code: "zip" });
  });
});

describe("rooms and seasons", () => {
  it("fits a photo within the longest side, never upscaling", () => {
    expect(fitWithin(4800, 3600)).toEqual({ width: 2400, height: 1800 });
    expect(fitWithin(3000, 6000)).toEqual({ width: 1200, height: 2400 });
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(0, 600)).toEqual({ width: 0, height: 0 });
  });
  it("names a season (UTC quarter)", () => {
    expect(seasonLabel("2026Q4")).toBe("Oct–Dec 2026");
    expect(seasonLabel("2027Q1")).toBe("Jan–Mar 2027");
    expect(seasonLabel("winter")).toBe("winter");
  });
});
