// Renaissance Circle: overview, flags, invitations (review queue) and the
// concierge (threads, a thread with room photos, reply). People answer the
// concierge — there is no AI anywhere in this page.

import {
  act, api, card, credits, dash, field, fmtDateTime, h, money, msgBox, namedForm, refresh, render, say, section, statusLabel, table,
} from "./ui.js";

// ---- Overview -----------------------------------------------------------------
const STATUS_ORDER = ["active", "canceling", "past_due", "pending", "ended", "ended_expired"];

export async function circleOverview() {
  const o = await api("/api/admin/circle/overview");
  const rows = STATUS_ORDER.map((s) => ({ status: s, n: (o.members && o.members[s]) || 0 }));
  render("Renaissance Circle",
    h("p", { class: "lede" }, "Members, money and what is waiting for you."),
    h("dl", { class: "cards" },
      card("Credits outstanding", money(o.credits_outstanding_cents), "the ledger sum: credits members can still spend"),
      card("Monthly recurring", money(o.monthly_recurring_cents), "active, canceling and past-due members × the monthly fee"),
      card("Open flags", h("a", { href: "#/circle/flags" }, h("span", { class: "visually-hidden" }, "View "), String(o.open_flags), h("span", { class: "visually-hidden" }, " open flags")), "signals to check"),
      card("Welcome queue", h("a", { href: "#/circle/gift-queue" }, h("span", { class: "visually-hidden" }, "View "), String(o.welcome_queue), h("span", { class: "visually-hidden" }, " in the welcome queue")), "welcome pieces to choose or send"),
      card("Invitations to review", h("a", { href: "#/circle/invitations" }, h("span", { class: "visually-hidden" }, "View "), String(o.invitations_to_review), h("span", { class: "visually-hidden" }, " invitations to review")), "card or address matches"),
    ),
    h("h2", {}, "Members by status"),
    table("Members by status", [
      { label: "Status", cell: (r) => statusLabel(r.status) },
      { label: "Members", num: true, cell: (r) => h("a", { href: `#/members?status=${r.status}` }, String(r.n), h("span", { class: "visually-hidden" }, ` ${statusLabel(r.status).toLowerCase()} members`)) },
    ], rows),
  );
}

// ---- Flags ----------------------------------------------------------------------
const FLAG_KINDS = {
  duplicate_subscription: "Two subscriptions",
  dispute_lost: "Dispute lost — decide on the credit freeze",
  object_bypass: "Members' object ordered outside the portal",
  object_guard_failed: "Members' object guard failed",
  circle_price_non_member: "Circle price used by a non-member",
  redemption_uncertain: "Check a credits gift card",
  referral_review: "Invitation to review",
};
const flagKind = (k) => FLAG_KINDS[k] || k.replace(/_/g, " ");

function flagDetails(json) {
  if (!json) return "—";
  let d;
  try { d = JSON.parse(json); } catch { return json; }
  if (!d || typeof d !== "object") return String(d);
  return h("ul", { class: "plain" }, Object.entries(d).map(([k, v]) =>
    h("li", {}, `${k.replace(/_cents$/, "").replace(/_/g, " ")}: ${k.endsWith("_cents") ? money(v) : typeof v === "object" ? JSON.stringify(v) : String(v)}`)));
}

export async function flags(params) {
  const resolved = params.get("status") === "resolved";
  const d = await api(`/api/admin/flags${resolved ? "?status=resolved" : ""}`);
  const box = msgBox();
  const resolve = async (f, button) => {
    const out = await act(button, box, () => api(`/api/admin/flags/${encodeURIComponent(f.id)}/resolve`, { method: "POST", body: {} }));
    if (out) await refresh("Flag resolved.");
  };
  const columns = [
    { label: "Raised", cell: (f) => fmtDateTime(f.created_at) },
    { label: "Kind", cell: (f) => flagKind(f.kind) },
    { label: "Member", cell: (f) => dash(f.email) },
    { label: "Reference", cell: (f) => dash(f.ref) },
    { label: "Details", cell: (f) => flagDetails(f.details_json) },
  ];
  if (resolved) {
    columns.push({ label: "Resolved", cell: (f) => `${fmtDateTime(f.resolved_at)} by ${dash(f.resolved_by)}` });
  } else {
    columns.push({ label: "Action", cell: (f) => {
      const b = h("button", { type: "button", class: "secondary small" }, "Resolve", h("span", { class: "visually-hidden" }, `: ${flagKind(f.kind)}${f.email ? `, ${f.email}` : ""}`));
      b.addEventListener("click", () => resolve(f, b));
      return b;
    } });
  }
  render("Flags",
    h("p", { class: "lede" }, "Signals that need a person: double subscriptions, orders around the portal, guard failures. Each one was also emailed to you."),
    h("nav", { "aria-label": "Flag status", class: "tabs" }, h("ul", {},
      h("li", {}, h("a", { href: "#/circle/flags", "aria-current": resolved ? null : "page" }, "Open")),
      h("li", {}, h("a", { href: "#/circle/flags?status=resolved", "aria-current": resolved ? "page" : null }, "Resolved")),
    )),
    box,
    table(resolved ? "Resolved flags" : "Open flags", columns, d.flags, resolved ? "none yet." : "nothing to check."),
  );
}

// ---- Invitations ------------------------------------------------------------------
const INVITE_STATUS = {
  pending_checkout: "At checkout", expired: "Checkout abandoned", joined: "Joined", qualifying: "Qualifying", credited: "Credited",
  not_counted_season: "Not counted (season)", not_counted_economics: "Not counted (economics)", rejected: "Rejected", void: "Void",
  lapsed: "Lapsed", reversed: "Reversed", review: "Review",
};
const inviteStatus = (s) => INVITE_STATUS[s] || s;

export async function invitations() {
  const d = await api("/api/admin/invitations");
  const box = msgBox();
  const decide = async (r, decision, button) => {
    const question = decision === "credit"
      ? `Credit ${credits(r.reward_cents)} to ${r.member_email} for inviting ${r.friend_email}?`
      : `Reject the invitation of ${r.friend_email} by ${r.member_email}? No credits will be given.`;
    if (!window.confirm(question)) return;
    const out = await act(button, box, () => api(`/api/admin/invitations/${encodeURIComponent(r.id)}`, { method: "PATCH", body: { decision } }));
    if (out) await refresh(out.status === "credited" ? "Invitation credited." : `Invitation ${inviteStatus(out.status).toLowerCase()}${out.reason ? ` (${out.reason.replace(/_/g, " ")})` : ""}.`);
  };
  const decisionCell = (r) => {
    const credit = h("button", { type: "button", class: "small" }, "Credit", h("span", { class: "visually-hidden" }, ` ${r.member_email}`));
    const reject = h("button", { type: "button", class: "secondary small" }, "Reject", h("span", { class: "visually-hidden" }, ` ${r.member_email}`));
    credit.addEventListener("click", () => decide(r, "credit", credit));
    reject.addEventListener("click", () => decide(r, "reject", reject));
    return h("div", { class: "row-actions" }, credit, reject);
  };
  render("Invitations",
    h("p", { class: "lede" }, "A member's reward is credited after the friend's second payment. A shared card or address sends it here for your decision. The discount and reward amounts are set in ",
      h("a", { href: "#/circle/economics" }, "Economics"), "."),
    box,
    h("h2", {}, "Waiting for review"),
    d.review.length ? table("Review queue", [
      { label: "Member", cell: (r) => r.member_email },
      { label: "Friend", cell: (r) => r.friend_email },
      { label: "Season", cell: (r) => dash(r.season) },
      { label: "Why it needs review", cell: (r) => dash(r.reason) },
      { label: "Friend's paid invoices", num: true, cell: (r) => String(r.friend_paid_invoices) },
      { label: "Reward", num: true, cell: (r) => credits(r.reward_cents) },
      { label: "Decision", cell: decisionCell },
    ], d.review) : h("p", { class: "empty" }, "Nothing is waiting for review."),
    h("h2", {}, "All invitations"),
    table("All invitations", [
      { label: "Member", cell: (r) => r.member_email },
      { label: "Friend", cell: (r) => r.friend_email },
      { label: "Status", cell: (r) => inviteStatus(r.status) },
      { label: "Reason", cell: (r) => dash(r.reason && r.reason.replace(/_/g, " ")) },
      { label: "Season", cell: (r) => dash(r.season) },
      { label: "Discount", num: true, cell: (r) => money(r.discount_cents) },
      { label: "Reward", num: true, cell: (r) => credits(r.reward_cents) },
      { label: "Paid invoices", num: true, cell: (r) => String(r.friend_paid_invoices) },
      { label: "Started", cell: (r) => fmtDateTime(r.created_at) },
      { label: "Credited", cell: (r) => fmtDateTime(r.credited_at) },
    ], d.invitations, "none yet."),
  );
}

// ---- Concierge ----------------------------------------------------------------------
const THREAD_STATUS = { open: "Waiting for you", answered: "Answered", closed: "Closed" };
const memberName = (t) => [t.first_name, t.last_name].filter(Boolean).join(" ");

export async function concierge() {
  const d = await api("/api/admin/concierge");
  render("Concierge",
    h("p", { class: "lede" }, "Members write to the Maison; you answer in person. Priority threads come first."),
    table("Conversations", [
      { label: "Member", cell: (t) => h("span", {}, h("a", { href: `#/circle/concierge/${encodeURIComponent(t.id)}` }, t.email), memberName(t) ? h("span", { class: "sub" }, memberName(t)) : null) },
      { label: "Priority", cell: (t) => (t.priority ? h("strong", {}, "Priority") : "—") },
      { label: "Status", cell: (t) => THREAD_STATUS[t.status] || t.status },
      { label: "Unread from member", num: true, cell: (t) => String(t.unread_from_member || 0) },
      { label: "Last message", cell: (t) => fmtDateTime(t.updated_at) },
    ], d.threads, "no conversations yet."),
  );
}

export async function conciergeThread(id) {
  const d = await api(`/api/admin/concierge/${encodeURIComponent(id)}`);
  const t = d.thread;
  const box = msgBox();
  const reply = h("textarea", { name: "body", rows: "6", maxlength: "4000", required: true });
  const send = h("button", { type: "submit" }, "Send reply");
  const f = namedForm("Reply", { class: "stack" },
    field("Your reply", reply, "Written by you, not generated. The member gets an email saying there is a reply; the text stays in the portal."),
    h("div", { class: "actions" }, send),
    box,
  );
  f.form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!reply.value.trim()) {
      say(box, "error", "Write a reply first.");
      reply.focus();
      return;
    }
    const out = await act(send, box, () => api(`/api/admin/concierge/${encodeURIComponent(t.id)}/reply`, { method: "POST", body: { body: reply.value } }));
    if (out) await refresh("Reply sent.");
  });

  render(`Conversation with ${t.email}`,
    h("p", {}, h("a", { href: "#/circle/concierge" }, "← All conversations")),
    h("p", { class: "lede" }, `${THREAD_STATUS[t.status] || t.status}${t.priority ? " · Priority" : ""}`),
    h("h2", {}, "Messages"),
    d.messages.length
      ? h("ol", { class: "messages", "aria-label": "Messages" }, d.messages.map((m) => h("li", { class: m.author === "maison" ? "from-maison" : "from-member" },
        h("p", { class: "meta" }, h("strong", {}, m.author === "maison" ? `The Maison${m.author_email ? ` (${m.author_email})` : ""}` : "Member"), ` · ${fmtDateTime(m.created_at)}`),
        h("p", { class: "body" }, m.body),
      )))
      : h("p", { class: "empty" }, "No messages yet."),
    section("Room photos",
      d.photos.length
        ? h("ul", { class: "photos" }, d.photos.map((p) => h("li", {},
          h("figure", {},
            h("img", { src: `/api/admin/rooms/${encodeURIComponent(p.id)}/image`, alt: `Room photo: ${p.room_label}`, loading: "lazy", width: "320", height: "240" }),
            h("figcaption", {}, h("strong", {}, p.room_label), p.note ? h("span", { class: "sub" }, p.note) : null, h("span", { class: "sub" }, fmtDateTime(p.created_at))),
          ))))
        : h("p", { class: "empty" }, "No room photos."),
    ),
    f.heading, f.form,
  );
}
