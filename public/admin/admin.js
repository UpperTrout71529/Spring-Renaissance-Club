// Admin (spec §12; V2 Circle screens, tz-v2 §3.3): Overview, Members, Member
// detail (with membership, credits and invoices), the Renaissance Circle
// screens (circle.js, economics.js, gifts.js, releases.js) and System.
// No framework, no build step. Every value from the API goes into the page
// through textContent — never innerHTML. Dates are en-US, money is USD.

import {
  ApiError, act, api, card, dash, field, fmtDate, fmtDateTime, fmtPct, fullName, h, money, msgBox, namedForm, parseWhole,
  refresh, render, say, section, setRouter, signedMoney, statusLabel, table, textInput, yesNo, MEMBERSHIP_STATUS,
} from "./ui.js";
import { circleOverview, concierge, conciergeThread, flags, invitations } from "./circle.js";
import { costs, economics } from "./economics.js";
import { giftPools, giftQueue } from "./gifts.js";
import { capsules, releases } from "./releases.js";

// ---- Overview ---------------------------------------------------------------
async function overview(params) {
  const qs = new URLSearchParams();
  if (params.get("from")) qs.set("from", params.get("from"));
  if (params.get("to")) qs.set("to", params.get("to"));
  const m = await api(`/api/admin/metrics?${qs}`);
  const toDay = new Date(Date.parse(m.range.to) - 1).toISOString().slice(0, 10);
  const fromDay = m.range.from.slice(0, 10);
  const r = m.repeat_purchase_90d;
  const max = Math.max(1, ...m.weekly.map((w) => Math.max(w.new_accounts, w.logins, w.orders)));
  // Width through CSSOM: the CSP (style-src 'self') blocks style attributes.
  const bar = (n) => {
    const el = h("span", { class: "bar", "aria-hidden": "true" });
    el.style.width = `${Math.round((n / max) * 80)}px`;
    return el;
  };

  render("Overview",
    h("form", { class: "inline", onsubmit: (e) => { e.preventDefault(); const f = new FormData(e.target); location.hash = `#/overview?from=${f.get("from")}&to=${f.get("to")}`; } },
      h("label", {}, "From", h("input", { type: "date", name: "from", value: fromDay, required: true })),
      h("label", {}, "To", h("input", { type: "date", name: "to", value: toDay, required: true })),
      h("button", { type: "submit" }, "Show"),
    ),
    h("p", { class: "lede" }, `${fmtDate(m.range.from)} – ${fmtDate(toDay)} (UTC)`),
    h("h2", {}, "Club"),
    h("dl", { class: "cards" },
      card("Club accounts", m.accounts.total, `${m.accounts.new_in_period} new in this period`),
      card("Sign-ins", m.logins.count, `${m.logins.unique_members} members · ${m.logins.by_passkey} by passkey`),
      card("Saved", m.saved.added_in_period, `added · ${m.saved.members_with_saved} members have saved pieces`),
      card("Circle waitlist", m.waitlist.total, `${m.waitlist.joined_in_period} joined in this period`),
    ),
    h("h2", {}, "Orders"),
    h("dl", { class: "cards" },
      card("Orders", m.orders.count, `${m.orders.buyers} buyers`),
      card("Buyers with an account", fmtPct(m.orders.buyers_with_account_pct)),
      card("Repeat purchase rate, 90 days", fmtPct(r.all.rate_pct), `${r.all.repeat} of ${r.all.buyers} buyers`),
      card("Club vs no account", `${fmtPct(r.club.rate_pct)} / ${fmtPct(r.no_account.rate_pct)}`, `${r.club.buyers} Club buyers · ${r.no_account.buyers} without`),
    ),
    h("p", { class: "lede" }, "Orders count from the day the Shopify orders/create webhook was switched on. The Renaissance Circle has its own overview under ",
      h("a", { href: "#/circle" }, "Circle"), "."),
    h("h2", {}, "By week"),
    table("Weekly totals (weeks start on Monday)", [
      { label: "Week of", cell: (w) => fmtDate(`${w.week_start}T00:00:00Z`) },
      { label: "New accounts", num: true, cell: (w) => h("span", {}, bar(w.new_accounts), ` ${w.new_accounts}`) },
      { label: "Sign-ins", num: true, cell: (w) => h("span", {}, bar(w.logins), ` ${w.logins}`) },
      { label: "Orders", num: true, cell: (w) => h("span", {}, bar(w.orders), ` ${w.orders}`) },
    ], m.weekly),
  );
}

// ---- Members ----------------------------------------------------------------
async function members(params) {
  const q = params.get("q") || "";
  const tier = params.get("tier") || "";
  const status = params.get("status") || "";
  const page = Number(params.get("page") || 1);
  const qs = new URLSearchParams({ page: String(page) });
  if (q) qs.set("q", q);
  if (tier) qs.set("tier", tier);
  if (status) qs.set("status", status);
  const data = await api(`/api/admin/members?${qs}`);
  const go = (p) => { const n = new URLSearchParams(qs); n.set("page", String(p)); location.hash = `#/members?${n}`; };

  render("Members",
    h("form", { class: "inline", role: "search", onsubmit: (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const n = new URLSearchParams();
      for (const k of ["q", "tier", "status"]) if (f.get(k)) n.set(k, f.get(k));
      location.hash = `#/members?${n}`;
    } },
      h("label", {}, "Email or name", h("input", { type: "search", name: "q", value: q, autocomplete: "off" })),
      h("label", {}, "Tier", h("select", { name: "tier" },
        h("option", { value: "", selected: !tier }, "All"),
        h("option", { value: "club", selected: tier === "club" }, "Club"),
        h("option", { value: "vip", selected: tier === "vip" }, "VIP"),
      )),
      h("label", {}, "Membership", h("select", { name: "status" },
        h("option", { value: "", selected: !status }, "Any"),
        Object.entries(MEMBERSHIP_STATUS).map(([v, label]) => h("option", { value: v, selected: status === v }, label)),
      )),
      h("button", { type: "submit" }, "Search"),
    ),
    table(`Members, page ${data.page}`, [
      { label: "Email", cell: (m) => h("a", { href: `#/members/${encodeURIComponent(m.id)}` }, m.email) },
      { label: "Name", cell: fullName },
      { label: "Tier", cell: (m) => (m.tier === "vip" ? "VIP" : "Club") },
      { label: "Membership", cell: (m) => statusLabel(m.status) },
      { label: "Since", cell: (m) => fmtDate(m.since) },
      { label: "Credits", num: true, cell: (m) => money(m.credits_balance_cents) },
      { label: "Next charge", cell: (m) => fmtDate(m.next_charge_at) },
    ], data.members, "no matches."),
    h("div", { class: "pager" },
      data.page > 1 ? h("button", { type: "button", class: "secondary", onclick: () => go(data.page - 1) }, "Previous page") : null,
      data.has_more ? h("button", { type: "button", class: "secondary", onclick: () => go(data.page + 1) }, "Next page") : null,
    ),
  );
}

const LEDGER_KINDS = {
  accrual: "Monthly credits", welcome_accrual: "Welcome credits", redemption: "Spent", redemption_return: "Returned", manual: "Adjustment",
  referral: "Invitation reward", referral_reversal: "Invitation reversed", refund_reversal: "Refund", dispute_reversal: "Dispute",
  dispute_restore: "Dispute won", expiry: "Expired",
};

// After a dispute (lost, or still open) the credits stay frozen until Felix
// decides; lifting the freeze needs a note.
function unfreezeForm(userId) {
  const box = msgBox();
  const note = textInput("memo", "", { required: true, maxlength: "200" });
  const submit = h("button", { type: "submit" }, "Lift credit freeze");
  const f = namedForm("Lift credit freeze", { level: "h3", class: "stack" },
    h("p", { class: "hint" }, "Credits are frozen after a payment dispute: the member cannot spend them and the member price is paused. Lift the freeze only once you have decided the member keeps the membership."),
    field("Note (required)", note, "Why the freeze is lifted — kept in the admin audit."),
    h("div", { class: "actions" }, submit),
    box,
  );
  f.form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const out = await act(submit, box, () => api(`/api/admin/members/${encodeURIComponent(userId)}/unfreeze`, { method: "POST", body: { memo: note.value } }));
    if (out) await refresh("Credit freeze lifted.");
  });
  return [f.heading, f.form];
}

function membershipSection(ms, userId) {
  if (!ms) return section("Membership", h("p", { class: "empty" }, "Not a member of the Renaissance Circle."));
  return section("Membership",
    h("dl", { class: "fields" },
      h("dt", {}, "Status"), h("dd", {}, statusLabel(ms.status)),
      h("dt", {}, "Kind"), h("dd", {}, ms.kind === "rejoin" ? "Rejoined" : "Joined"),
      h("dt", {}, "Started"), h("dd", {}, fmtDate(ms.started_at)),
      h("dt", {}, "Current period ends"), h("dd", {}, fmtDate(ms.current_period_end)),
      h("dt", {}, "Paid invoices"), h("dd", {}, String(ms.paid_invoices ?? 0)),
      h("dt", {}, "Consecutive paid months"), h("dd", {}, String(ms.consecutive_paid_months ?? 0)),
      h("dt", {}, "Credits frozen"), h("dd", {}, yesNo(ms.credits_frozen)),
      ms.cancel_requested_at ? [h("dt", {}, "Cancellation requested"), h("dd", {}, fmtDate(ms.cancel_requested_at))] : null,
      ms.ended_at ? [h("dt", {}, "Ended"), h("dd", {}, `${fmtDate(ms.ended_at)}${ms.end_reason ? ` (${ms.end_reason.replace(/_/g, " ")})` : ""}`)] : null,
      ms.credits_grace_until ? [h("dt", {}, "Credits usable until"), h("dd", {}, fmtDate(ms.credits_grace_until))] : null,
    ),
    ms.credits_frozen ? unfreezeForm(userId) : null);
}

// One Idempotency-Key per intended adjustment: a double submit or a retry
// with the same values books once; changing a value is a new adjustment.
const newKey = () => crypto.randomUUID();

function adjustCreditsForm(userId) {
  const box = msgBox();
  const amount = textInput("amount", "", { inputmode: "numeric", class: "num-in" });
  const note = textInput("memo", "", { required: true, maxlength: "200" });
  let key = newKey();
  for (const el of [amount, note]) el.addEventListener("input", () => { key = newKey(); });
  const submit = h("button", { type: "submit" }, "Adjust credits");
  const f = namedForm("Adjust credits", { level: "h3", class: "stack" },
    field("Credits (+ or −)", amount, "Whole credits; 1 credit = $1. Use a minus sign to take credits away."),
    field("Note (required)", note, "Shown to the member in their ledger after “Adjustment by the Maison —”."),
    h("div", { class: "actions" }, submit),
    box,
  );
  f.form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const n = parseWhole(amount.value, { signed: true });
    if (!Number.isInteger(n) || n === 0) {
      say(box, "error", "Whole credits, plus or minus.");
      amount.setAttribute("aria-invalid", "true");
      amount.focus();
      return;
    }
    amount.removeAttribute("aria-invalid");
    const out = await act(submit, box, () => api("/api/admin/credits/adjust", {
      method: "POST", headers: { "Idempotency-Key": key }, body: { user_id: userId, amount_cents: n * 100, memo: note.value },
    }));
    if (out) {
      key = newKey();
      await refresh(out.repeated
        ? `This adjustment was already booked once; nothing was added. Balance: ${money(out.balance_cents)}.`
        : `Credits adjusted. Balance: ${money(out.balance_cents)}.`);
    }
  });
  return [f.heading, f.form];
}

async function member(id) {
  const d = await api(`/api/admin/members/${encodeURIComponent(id)}`);
  const u = d.user;
  const ms = d.membership;
  render(u.email,
    h("p", {}, h("a", { href: "#/members" }, "← All members")),
    h("h2", {}, "Profile"),
    h("dl", { class: "fields" },
      h("dt", {}, "Name"), h("dd", {}, fullName(u)),
      h("dt", {}, "Tier"), h("dd", {}, u.tier === "vip" ? "VIP" : "Club"),
      h("dt", {}, "Member since"), h("dd", {}, fmtDate(u.created_at)),
      h("dt", {}, "Last sign-in"), h("dd", {}, fmtDateTime(u.last_login_at)),
      h("dt", {}, "Seasonal letter"), h("dd", {}, u.seasonal_email_opt_in ? "Yes" : "No"),
      h("dt", {}, "Orders"), h("dd", {}, d.shopify_admin_url
        ? h("a", { href: d.shopify_admin_url, target: "_blank", rel: "noopener noreferrer" }, "Open in Shopify Admin", h("span", { class: "visually-hidden" }, " (opens in a new tab)"))
        : "No Shopify customer linked"),
      h("dt", {}, "Renaissance Circle"), h("dd", {}, ms ? statusLabel(ms.status) : "Not a member"),
    ),
    membershipSection(ms, u.id),
    d.credits ? section("Credits",
      h("p", { class: "balance", "data-testid": "credit-balance" }, `Balance: ${money(d.credits.balance_cents)}`),
      table("Credit ledger", [
        { label: "When", cell: (l) => fmtDateTime(l.created_at) },
        { label: "What", cell: (l) => dash(l.memo) },
        { label: "Kind", cell: (l) => LEDGER_KINDS[l.kind] || l.kind },
        { label: "Amount", num: true, cell: (l) => signedMoney(l.amount_cents) },
        { label: "By", cell: (l) => (l.created_by && l.created_by.startsWith("admin:") ? l.created_by.slice(6) : "System") },
      ], d.credits.ledger, "no entries."),
      adjustCreditsForm(u.id),
    ) : null,
    ms ? section("Invoices",
      table("Invoices", [
        { label: "Period", cell: (i) => `${fmtDate(i.period_start)} – ${fmtDate(i.period_end)}` },
        { label: "Paid", num: true, cell: (i) => money(i.amount_paid_cents) },
        { label: "Status", cell: (i) => (i.status ? i.status[0].toUpperCase() + i.status.slice(1) : "—") },
        { label: "Invoice", cell: (i) => (i.hosted_invoice_url
          ? h("a", { href: i.hosted_invoice_url, target: "_blank", rel: "noopener noreferrer" }, "Open in Stripe", h("span", { class: "visually-hidden" }, ` for ${fmtDate(i.period_start)} (opens in a new tab)`))
          : "—") },
      ], d.invoices || [], "none yet."),
    ) : null,
    h("h2", {}, "Consents"),
    table("Consents", [
      { label: "Kind", cell: (c) => c.kind },
      { label: "Granted", cell: (c) => (c.granted ? "Granted" : "Withdrawn") },
      { label: "Version", cell: (c) => c.document_version },
      { label: "When", cell: (c) => fmtDateTime(c.created_at) },
    ], d.consents),
    h("h2", {}, "Active sessions"),
    table("Active sessions", [
      { label: "Device", cell: (s) => [s.ua_summary || "Unknown device", s.geo_city].filter(Boolean).join(" · ") },
      { label: "Method", cell: (s) => (s.auth_method === "passkey" ? "Passkey" : "Email link") },
      { label: "Signed in", cell: (s) => fmtDateTime(s.created_at) },
      { label: "Last active", cell: (s) => fmtDateTime(s.last_seen_at) },
    ], d.sessions),
    h("h2", {}, "Passkeys"),
    table("Passkeys", [
      { label: "Label", cell: (p) => dash(p.device_label) },
      { label: "Added", cell: (p) => fmtDate(p.created_at) },
      { label: "Last used", cell: (p) => fmtDate(p.last_used_at) },
    ], d.passkeys),
    h("h2", {}, "Saved and held"),
    table("Saved pieces", [
      { label: "Piece", cell: (s) => s.product_handle },
      { label: "Saved", cell: (s) => fmtDate(s.created_at) },
    ], d.saved),
    table("Holds and waitlist", [
      { label: "Kind", cell: (x) => (x.kind === "circle_waitlist" ? "Circle waitlist" : "Hold") },
      { label: "Piece", cell: (x) => dash(x.product_handle) },
      { label: "Status", cell: (x) => x.status },
      { label: "Source", cell: (x) => x.source },
      { label: "Since", cell: (x) => fmtDate(x.created_at) },
    ], d.holds),
    h("h2", {}, "Recent emails"),
    table("Recent emails", [
      { label: "Template", cell: (e) => e.template },
      { label: "Status", cell: (e) => e.status },
      { label: "When", cell: (e) => fmtDateTime(e.created_at) },
    ], d.emails),
    h("h2", {}, "Recent activity"),
    table("Recent activity", [
      { label: "Event", cell: (e) => e.name },
      { label: "When", cell: (e) => fmtDateTime(e.created_at) },
    ], d.events),
  );
}

// ---- System -----------------------------------------------------------------
async function system(params) {
  const status = params.get("status") || "failed";
  const [w, e, a] = await Promise.all([
    api(`/api/admin/webhooks${status === "all" ? "" : `?status=${encodeURIComponent(status)}`}`),
    api("/api/admin/emails"),
    api("/api/admin/audit"),
  ]);
  render("System",
    h("h2", {}, "Webhooks"),
    h("form", { class: "inline", onsubmit: (ev) => { ev.preventDefault(); location.hash = `#/system?status=${new FormData(ev.target).get("status")}`; } },
      h("label", {}, "Status", h("select", { name: "status" },
        ["failed", "received", "processed", "ignored", "all"].map((s) => h("option", { value: s, selected: s === status }, s[0].toUpperCase() + s.slice(1))),
      )),
      h("button", { type: "submit" }, "Show"),
    ),
    table(`Webhooks (${status})`, [
      { label: "Received", cell: (x) => fmtDateTime(x.received_at) },
      { label: "Source", cell: (x) => x.source },
      { label: "Type", cell: (x) => x.type },
      { label: "Status", cell: (x) => x.status },
      { label: "Error", cell: (x) => dash(x.error) },
      { label: "Event id", cell: (x) => x.event_id },
    ], w.webhooks, "none."),
    h("h2", {}, "Email log"),
    table("Last 100 emails", [
      { label: "When", cell: (x) => fmtDateTime(x.created_at) },
      { label: "Template", cell: (x) => x.template },
      { label: "To", cell: (x) => dash(x.email) },
      { label: "Status", cell: (x) => x.status },
    ], e.emails),
    h("h2", {}, "Admin audit"),
    table("Last 100 admin actions", [
      { label: "When", cell: (x) => fmtDateTime(x.created_at) },
      { label: "Who", cell: (x) => x.actor_email },
      { label: "Action", cell: (x) => x.action },
      { label: "Target", cell: (x) => dash(x.target) },
    ], a.audit),
  );
}

// ---- Router -----------------------------------------------------------------
const CIRCLE = {
  "": circleOverview, economics, costs, "gift-pools": giftPools, "gift-queue": giftQueue, object: releases,
  invitations, capsules, concierge, flags,
};

async function route() {
  const [path, query = ""] = location.hash.replace(/^#/, "").split("?");
  const params = new URLSearchParams(query);
  const parts = path.split("/").filter(Boolean);
  const top = parts[0] || "overview";
  for (const a of document.querySelectorAll("[data-nav]")) {
    if (a.dataset.nav === top) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  const sub = top === "circle" ? parts[1] || "" : null;
  const subnav = document.getElementById("circle-nav");
  subnav.hidden = sub === null;
  for (const a of subnav.querySelectorAll("[data-sub]")) {
    if (a.dataset.sub === sub) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  try {
    if (top === "members" && parts[1]) await member(decodeURIComponent(parts[1]));
    else if (top === "members") await members(params);
    else if (top === "system") await system(params);
    else if (sub === "concierge" && parts[2]) await conciergeThread(decodeURIComponent(parts[2]));
    else if (sub !== null && CIRCLE[sub]) await CIRCLE[sub](params);
    else await overview(params);
  } catch (err) {
    if (!(err instanceof ApiError)) console.error(err);
    render("Something went wrong", h("p", { class: "error", role: "alert" }, err.message),
      h("button", { type: "button", onclick: route }, "Try again"));
  }
}

setRouter(route);
window.addEventListener("hashchange", route);
route();

