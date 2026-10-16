// Shared helpers for the admin page: DOM building (textContent only — never
// innerHTML), formatting, the API client (reads and same-origin writes),
// readable error explanations and the page frame (render / flash / say).

export const main = document.getElementById("main");
const statusEl = document.getElementById("status");

export function h(tag, attrs = {}, ...children) {
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

let seq = 0;
export const uid = (p = "f") => `${p}-${++seq}`;

// ---- formatting --------------------------------------------------------------
const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const DATETIME = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" });
const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
export const fmtDate = (iso) => (iso ? DATE.format(new Date(iso)) : "—");
export const fmtDateTime = (iso) => (iso ? DATETIME.format(new Date(iso)) : "—");
export const fmtPct = (v) => (v === null || v === undefined ? "—" : `${v}%`);
export const dash = (v) => (v === null || v === undefined || v === "" ? "—" : v);
export const fullName = (u) => [u.first_name, u.last_name].filter(Boolean).join(" ") || "—";
export const isNum = (v) => typeof v === "number" && Number.isFinite(v);
export const money = (c) => (isNum(c) ? USD.format(c / 100) : "—");
export const signedMoney = (c) => (isNum(c) && c > 0 ? `+${money(c)}` : money(c));
export const credits = (c) => (isNum(c) ? `${c / 100} credit${c === 100 ? "" : "s"}` : "—");
export const bpsPct = (b) => (isNum(b) ? `${b / 100}%` : "—");
export const ppmRatio = (p) => (isNum(p) ? (p / 1e6).toFixed(4) : null);
export const yesNo = (v) => (v ? "Yes" : "No");

// A small "estimate" tag after a figure that rests on estimated shipping.
export const estimateTag = () => h("span", { class: "tag" }, "estimate");
export const withEstimate = (text, isEstimate) => (isEstimate ? h("span", {}, text, " ", estimateTag()) : text);

// ---- inputs ------------------------------------------------------------------
// Dollars typed by a person → integer cents. "" → null; anything odd → NaN.
export function parseDollars(raw) {
  const s = String(raw ?? "").trim().replace(/^\$/, "").replace(/,/g, "");
  if (s === "") return null;
  if (!/^\d+(\.\d{0,2})?$/.test(s)) return NaN;
  const [d, f = ""] = s.split(".");
  return Number(d) * 100 + Number(`${f}00`.slice(0, 2));
}
export const centsInput = (c) => (isNum(c) ? `${Math.floor(c / 100)}.${String(Math.abs(c) % 100).padStart(2, "0")}` : "");
// "15" / "2.9" percent → basis points.
export function parsePercent(raw) {
  const s = String(raw ?? "").trim().replace(/%$/, "");
  if (s === "") return null;
  if (!/^\d+(\.\d{0,2})?$/.test(s)) return NaN;
  const [d, f = ""] = s.split(".");
  return Number(d) * 100 + Number(`${f}00`.slice(0, 2));
}
export const bpsInput = (b) => (isNum(b) ? String(b / 100) : "");
export function parseWhole(raw, { signed = false } = {}) {
  const s = String(raw ?? "").trim();
  if (s === "") return null;
  return (signed ? /^[-+−]?\d+$/ : /^\d+$/).test(s) ? Number(s.replace("−", "-")) : NaN;
}
// <input type="datetime-local"> holds UTC here (labelled so) ↔ ISO.
export const isoInput = (iso) => (iso ? new Date(iso).toISOString().slice(0, 16) : "");
export function parseUtc(raw) {
  const s = String(raw ?? "").trim();
  if (s === "") return null;
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(:\d{2})?/.exec(s);
  return m ? `${m[1]}T${m[2]}${m[3] || ":00"}.000Z` : NaN;
}
export const gid = (kind, raw) => {
  const s = String(raw ?? "").trim();
  if (s === "") return null;
  return /^\d+$/.test(s) ? `gid://shopify/${kind}/${s}` : s;
};

// A labelled control with an optional hint (described-by, not in the name).
export function field(label, control, hint) {
  const id = control.id || uid("in");
  control.id = id;
  let hintEl = null;
  if (hint) {
    hintEl = h("span", { class: "hint", id: `${id}-hint` }, hint);
    control.setAttribute("aria-describedby", hintEl.id);
  }
  return h("div", { class: "field" }, h("label", { for: id }, label), control, hintEl);
}
export const check = (label, control) => h("label", { class: "check" }, control, h("span", {}, label));
export const textInput = (name, value, extra = {}) => h("input", { type: "text", name, value: value ?? "", autocomplete: "off", ...extra });
export const moneyInput = (name, cents, extra = {}) => textInput(name, centsInput(cents), { inputmode: "decimal", class: "num-in", ...extra });
export function select(name, options, value, extra = {}) {
  return h("select", { name, ...extra }, options.map(([v, label]) => h("option", { value: v, selected: String(value ?? "") === v }, label)));
}
export const CLASS_OPTIONS = [["", "—"], ["S", "S"], ["M", "M"], ["L", "L"]];

// ---- API ----------------------------------------------------------------------
export class ApiError extends Error {
  constructor(status, code, message, explanation) {
    super(message);
    this.status = status;
    this.code = code;
    this.explanation = explanation;
  }
}

export async function api(path, { method = "GET", body, headers: extra = {} } = {}) {
  const headers = { Accept: "application/json", ...extra };
  const init = { method, credentials: "same-origin", headers };
  if (method !== "GET") {
    // Admin writes: JSON and the admin client header (the browser adds Origin).
    headers["Content-Type"] = "application/json";
    headers["X-SR-Client"] = "admin";
    init.body = JSON.stringify(body ?? {});
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, "network", "Could not reach the server. Check the connection and try again — nothing is booked twice.");
  }
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) {
    const e = (data && data.error) || {};
    throw new ApiError(res.status, e.code || "error", e.message || `Request failed (${res.status}).`, data && data.explanation);
  }
  return data;
}

// ---- readable errors ---------------------------------------------------------
const CODE_HINTS = {
  shopify_not_configured: "Shopify is not connected here, so nothing can be read from or created in Shopify.",
  shopify_order_failed: "Nothing was charged. Check Shopify for a draft before trying again.",
};

export const GUARD_REASONS = {
  shopify_not_configured: "Shopify is not connected here",
  shopify_unreachable: "Shopify did not answer",
  not_active: "the product is not active",
  published_to_a_sales_channel: "the product is published to a sales channel",
  variant_missing: "the variant is missing",
  inventory_policy_not_deny: "the variant keeps selling when out of stock",
  inventory_not_tracked: "inventory is not tracked",
};
export const guardText = (reasons) => (reasons || []).map((r) => GUARD_REASONS[r] || r.replace(/_/g, " ")).join("; ");

const FIELD_NAMES = {
  price_cents: "price", edition_size: "edition size", unit_cost_cents: "unit cost", shipping_class: "shipping class",
  reserve_hours: "reservation hours", opens_at: "opens", closes_at: "closes", public_release_at: "public release",
};

const RULE3_REASONS = {
  invitation_costs_more_than_it_brings: "Fails: an invitation would cost more than it brings.",
  needs_cost_data: "Needs cost data — a cost for every purchasable variant. Invitation rewards are paused.",
  needs_welcome_data: "Needs the welcome pieces — landed cost and shipping. Invitation rewards are paused.",
  needs_shipping_data: "Needs shipping for the welcome piece's class. Invitation rewards are paused.",
};
export const rule3Reason = (r) => RULE3_REASONS[r] || (r ? r.replace(/_/g, " ") : "");

// Rule 3 terms: what an invitation costs against what it brings.
export function rule3Terms(x) {
  if (!x || !x.terms) return [];
  const t = x.terms;
  return [
    h("li", {}, `Cost of an invitation: ${money(t.lhs_cents)} (friend's discount ${money(t.discount_cents)} + reward cost ${money(t.reward_cost_cents)} + gift-card fee ${money(t.giftcard_fee_cents)})`),
    h("li", {}, `Value of an invitation: ${money(t.rhs_cents)} (joining net ${money(t.joining_net_cents)} − welcome piece ${money(t.welcome_cost_cents)} − shipping ${money(t.shipping_cents)} + 2 × monthly contribution ${money(t.monthly_contribution_cents)})`),
    h("li", {}, `Largest reward at this discount: ${isNum(x.max_reward_cents) ? credits(x.max_reward_cents) : "none"}`),
    h("li", {}, `Largest discount at this reward: ${isNum(x.max_discount_cents) ? money(x.max_discount_cents) : "none"}`),
  ];
}

const isCentsKey = (k) => k.endsWith("_cents");
function genericExplanation(x) {
  if (x === null || typeof x !== "object") return [h("li", {}, String(x))];
  return Object.entries(x).map(([k, v]) => {
    const label = k.replace(/_cents$/, "").replace(/_/g, " ");
    let text;
    if (Array.isArray(v)) text = v.map((i) => (typeof i === "object" ? JSON.stringify(i) : String(i))).join(", ");
    else if (v && typeof v === "object") text = JSON.stringify(v);
    else text = isCentsKey(k) ? money(v) : String(v);
    return h("li", {}, `${label}: ${text}`);
  });
}

// The lines that explain a 422 (or any error with an explanation).
export function explanationItems(err) {
  const x = err.explanation;
  if (!x) return [];
  switch (err.code) {
    case "economics_rule_failed":
      return [h("li", {}, rule3Reason(x.reason)), ...rule3Terms(x)];
    case "release_incomplete":
      return [h("li", {}, `Missing: ${(x.missing || []).map((k) => FIELD_NAMES[k] || k.replace(/_/g, " ")).join(", ")}`)];
    case "price_below_minimum":
      return [
        h("li", {}, `Margin at this price: ${money(x.margin_cents)}; required: ${money(x.required_margin_cents)}`),
        h("li", {}, `Fees ${money(x.fee_cents)}, shipping ${money(x.shipping_cents)}${x.shipping_estimate ? " (estimate)" : ""}`),
        h("li", {}, `Minimum price: ${money(x.min_price_cents)}`),
      ];
    case "guard_failed":
      return [h("li", {}, `Guard: ${guardText(x.reasons)}`)];
    case "welcome_over_cap":
      return [h("li", {}, `Landed cost ${money(x.landed_cost_cents)} + shipping ${money(x.shipping_cents)} = ${money(x.landed_cost_cents + x.shipping_cents)}, over the cap ${money(x.cap_cents)}`)];
    default:
      return genericExplanation(x);
  }
}

// An error as page content: the server's message, a hint for known codes,
// and the explanation as a list.
export function errorContent(err, prefix) {
  const hint = CODE_HINTS[err.code];
  const items = explanationItems(err);
  return [
    h("span", {}, prefix ? `${prefix}: ` : "", err.message, hint ? ` ${hint}` : ""),
    items.length ? h("ul", { class: "explain" }, items) : null,
  ];
}

// ---- page frame ---------------------------------------------------------------
let pendingFlash = null;
export const flash = (text) => { pendingFlash = text; };

export function render(title, ...content) {
  const notice = pendingFlash ? h("p", { class: "notice", role: "status", tabindex: "-1" }, pendingFlash) : null;
  pendingFlash = null;
  main.replaceChildren(...[h("h1", {}, title), notice, ...content].flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false));
  document.title = `${title} — Spring Renaissance Admin`;
  statusEl.textContent = `${title} loaded`;
  (notice || main).focus();
}

// One message at a time on the page: errors as alerts, results as status.
export function say(container, kind, ...content) {
  for (const m of main.querySelectorAll(".msg")) if (m !== container) m.replaceChildren();
  for (const n of main.querySelectorAll(".notice")) n.remove();
  container.replaceChildren(h("p", { class: kind === "error" ? "error" : "ok", role: kind === "error" ? "alert" : "status" }, ...content));
}
export const msgBox = () => h("div", { class: "msg" });
export const sayError = (container, err, prefix) => say(container, "error", ...errorContent(err, prefix));

// Runs a write; while it runs the button is disabled. Errors land in `box`.
export async function act(button, box, fn, prefix) {
  button.disabled = true;
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof ApiError)) console.error(err);
    sayError(box, err instanceof ApiError ? err : new ApiError(0, "error", "Something went wrong. Please try again."), prefix);
    return undefined;
  } finally {
    button.disabled = false;
  }
}

let router = async () => {};
export const setRouter = (fn) => { router = fn; };
// Re-runs the current screen (fresh data), with a message on top.
export async function refresh(text) {
  if (text) flash(text);
  await router();
}

export function table(caption, columns, rows, empty = "Nothing yet.", { rowClass } = {}) {
  if (!rows.length) return h("p", { class: "empty" }, `${caption}: ${empty}`);
  // Focusable and named: at narrow widths the wrapper scrolls sideways and
  // keyboard users must be able to reach it (axe scrollable-region-focusable).
  return h("div", { class: "table-wrap", role: "region", "aria-label": caption, tabindex: "0" }, h("table", {},
    h("caption", {}, caption),
    h("thead", {}, h("tr", {}, columns.map((c) => h("th", { scope: "col", class: c.num ? "num" : null }, c.label)))),
    h("tbody", {}, rows.map((r) => h("tr", { class: rowClass ? rowClass(r) : null }, columns.map((c, i) => {
      const value = c.cell(r);
      return i === 0 ? h("th", { scope: "row" }, value) : h("td", { class: c.num ? "num" : null }, value);
    })))),
  ));
}

export const card = (label, value, sub) => h("div", { class: "card" }, h("dt", {}, label), h("dd", {}, value instanceof Node ? value : String(value), sub ? h("span", { class: "sub" }, sub) : null));

// A section named by its heading (role region).
export function section(title, ...content) {
  const id = uid("sec");
  return h("section", { "aria-labelledby": id }, h("h2", { id }, title), ...content);
}

// A form named by its heading (role form).
export function namedForm(title, attrs, ...content) {
  const id = uid("form");
  const heading = h(attrs.level || "h2", { id }, title);
  const { level, ...rest } = attrs;
  const form = h("form", { "aria-labelledby": id, novalidate: true, ...rest }, ...content);
  return { heading, form, setTitle: (t) => { heading.textContent = t; } };
}

export const MEMBERSHIP_STATUS = {
  pending: "Pending", active: "Active", past_due: "Past due", canceling: "Canceling", ended: "Ended", ended_expired: "Ended (credits expired)",
};
export const statusLabel = (s) => (s ? MEMBERSHIP_STATUS[s] || s : "—");
