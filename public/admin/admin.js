// Admin v1 (spec §12): Overview, Members, Member detail (read-only), System.
// No framework, no build step. Every value from the API goes into the page
// through textContent — never innerHTML. Dates are en-US.

const main = document.getElementById("main");
const statusEl = document.getElementById("status");

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const DATETIME = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" });
const fmtDate = (iso) => (iso ? DATE.format(new Date(iso)) : "—");
const fmtDateTime = (iso) => (iso ? DATETIME.format(new Date(iso)) : "—");
const fmtPct = (v) => (v === null || v === undefined ? "—" : `${v}%`);
const dash = (v) => (v === null || v === undefined || v === "" ? "—" : v);
const fullName = (u) => [u.first_name, u.last_name].filter(Boolean).join(" ") || "—";

async function api(path) {
  const res = await fetch(path, { credentials: "same-origin", headers: { Accept: "application/json" } });
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) throw new Error((data && data.error && data.error.message) || `Request failed (${res.status}).`);
  return data;
}

function render(title, ...content) {
  main.replaceChildren(h("h1", {}, title), ...content);
  document.title = `${title} — Spring Renaissance Admin`;
  statusEl.textContent = `${title} loaded`;
  main.focus();
}

function table(caption, columns, rows, empty = "Nothing yet.") {
  if (!rows.length) return h("p", { class: "empty" }, `${caption}: ${empty}`);
  return h("div", { class: "table-wrap" }, h("table", {},
    h("caption", {}, caption),
    h("thead", {}, h("tr", {}, columns.map((c) => h("th", { scope: "col", class: c.num ? "num" : null }, c.label)))),
    h("tbody", {}, rows.map((r) => h("tr", {}, columns.map((c, i) => {
      const value = c.cell(r);
      return i === 0 ? h("th", { scope: "row" }, value) : h("td", { class: c.num ? "num" : null }, value);
    })))),
  ));
}

const card = (label, value, sub) => h("div", { class: "card" }, h("dt", {}, label), h("dd", {}, String(value), sub ? h("span", { class: "sub" }, sub) : null));

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
    h("p", { class: "lede" }, "Orders count from the day the Shopify orders/create webhook was switched on."),
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
  const page = Number(params.get("page") || 1);
  const qs = new URLSearchParams({ page: String(page) });
  if (q) qs.set("q", q);
  if (tier) qs.set("tier", tier);
  const data = await api(`/api/admin/members?${qs}`);
  const go = (p) => { const n = new URLSearchParams(qs); n.set("page", String(p)); location.hash = `#/members?${n}`; };

  render("Members",
    h("form", { class: "inline", role: "search", onsubmit: (e) => { e.preventDefault(); const f = new FormData(e.target); const n = new URLSearchParams(); if (f.get("q")) n.set("q", f.get("q")); if (f.get("tier")) n.set("tier", f.get("tier")); location.hash = `#/members?${n}`; } },
      h("label", {}, "Email or name", h("input", { type: "search", name: "q", value: q, autocomplete: "off" })),
      h("label", {}, "Tier", h("select", { name: "tier" },
        h("option", { value: "", selected: !tier }, "All"),
        h("option", { value: "club", selected: tier === "club" }, "Club"),
        h("option", { value: "vip", selected: tier === "vip" }, "VIP"),
      )),
      h("button", { type: "submit" }, "Search"),
    ),
    table(`Members, page ${data.page}`, [
      { label: "Email", cell: (m) => h("a", { href: `#/members/${encodeURIComponent(m.id)}` }, m.email) },
      { label: "Name", cell: fullName },
      { label: "Tier", cell: (m) => (m.tier === "vip" ? "VIP" : "Club") },
      { label: "Status", cell: (m) => dash(m.status) },
      { label: "Since", cell: (m) => fmtDate(m.since) },
      { label: "Balance", cell: (m) => dash(m.credits_balance_cents) },
      { label: "Next charge", cell: (m) => fmtDate(m.next_charge_at) },
    ], data.members, "no matches."),
    h("div", { class: "pager" },
      data.page > 1 ? h("button", { type: "button", class: "secondary", onclick: () => go(data.page - 1) }, "Previous page") : null,
      data.has_more ? h("button", { type: "button", class: "secondary", onclick: () => go(data.page + 1) }, "Next page") : null,
    ),
  );
}

async function member(id) {
  const d = await api(`/api/admin/members/${encodeURIComponent(id)}`);
  const u = d.user;
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
        ? h("a", { href: d.shopify_admin_url, target: "_blank", rel: "noopener noreferrer" }, "Open in Shopify Admin")
        : "No Shopify customer linked"),
      h("dt", {}, "Membership"), h("dd", {}, d.membership ? "VIP" : "None (VIP Circle opens in V2)"),
    ),
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
async function route() {
  const [path, query = ""] = location.hash.replace(/^#/, "").split("?");
  const params = new URLSearchParams(query);
  const parts = path.split("/").filter(Boolean);
  const section = parts[0] || "overview";
  for (const a of document.querySelectorAll("[data-nav]")) {
    if (a.dataset.nav === section) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  try {
    if (section === "members" && parts[1]) await member(decodeURIComponent(parts[1]));
    else if (section === "members") await members(params);
    else if (section === "system") await system(params);
    else await overview(params);
  } catch (err) {
    render("Something went wrong", h("p", { class: "error", role: "alert" }, err.message),
      h("button", { type: "button", onclick: route }, "Try again"));
  }
}

window.addEventListener("hashchange", route);
route();
