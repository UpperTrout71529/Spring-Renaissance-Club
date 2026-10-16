// Members' object releases (and early access, T21) and Capsules. Every
// figure is Felix's: a draft may leave any of them empty; opening a release
// checks them (422 explanations), the minimum price and the Shopify guard.

import {
  CLASS_OPTIONS, act, api, centsInput, check, credits, field, fmtDateTime, gid, guardText, h, isNum, isoInput, money, msgBox,
  namedForm, parseDollars, parseUtc, parseWhole, refresh, render, say, select, table, textInput, withEstimate,
} from "./ui.js";

const KIND = { members_object: "Members' object", early_access: "Early access" };
const REL_STATUS = { draft: "Draft", open: "Open", closed: "Closed" };
// Fields the API refuses to change once a release has opened.
const LOCKED = ["kind", "product_gid", "variant_gid", "price_cents", "edition_size", "unit_cost_cents", "shipping_class", "reserve_hours", "opens_at"];

// A small field model: each entry reads its control and knows how to fill it.
function money$(name, extra) { const el = textInput(name, "", { inputmode: "decimal", class: "num-in", ...extra }); return { el, read: () => parseDollars(el.value), fill: (v) => { el.value = centsInput(v); } }; }
function whole(name) { const el = textInput(name, "", { inputmode: "numeric", class: "num-in" }); return { el, read: () => parseWhole(el.value), fill: (v) => { el.value = isNum(v) ? String(v) : ""; } }; }
function text(name, max, area = false) {
  const el = area ? h("textarea", { name, rows: "4", maxlength: String(max) }) : textInput(name, "", { maxlength: String(max) });
  return { el, read: () => el.value.trim() || null, fill: (v) => { el.value = v || ""; } };
}
function utc(name) { const el = h("input", { type: "datetime-local", name }); return { el, read: () => parseUtc(el.value), fill: (v) => { el.value = isoInput(v); } }; }
function gidField(name, kind) {
  const el = textInput(name, "");
  return { el, read: () => gid(kind, el.value), fill: (v) => { el.value = v || ""; } };
}
function choice(name, options) { const el = select(name, options, ""); return { el, read: () => el.value || null, fill: (v) => { el.value = v || ""; } }; }
function flag(name) { const el = h("input", { type: "checkbox", name }); return { el, read: () => el.checked, fill: (v) => { el.checked = !!v; } }; }

const invalid = (v) => typeof v === "number" && Number.isNaN(v);

// Shared add/edit form logic: `fields` = { key: { model, label, required? } }.
function editableForm({ titleNew, titleEdit, saveLabel, fields, layout, path, onSaved, lockedWhen }) {
  const box = msgBox();
  const save = h("button", { type: "submit" }, saveLabel);
  const cancel = h("button", { type: "button", class: "secondary", hidden: true }, "Cancel edit");
  const f = namedForm(titleNew, { class: "stack" }, layout, h("div", { class: "actions" }, save, cancel), box);
  let editing = null;

  const fill = (row) => {
    editing = row;
    for (const [key, d] of Object.entries(fields)) {
      d.model.fill(row ? row[key] : d.initial ?? null);
      const locked = !!(row && lockedWhen && lockedWhen(row) && LOCKED.includes(key));
      d.model.el.disabled = locked;
    }
    cancel.hidden = !row;
    f.setTitle(row ? titleEdit(row) : titleNew);
    box.replaceChildren();
    f.form.dispatchEvent(new Event("filled"));
  };
  cancel.addEventListener("click", () => { fill(null); Object.values(fields)[0].model.el.focus(); });

  f.form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = {};
    const problems = [];
    for (const [key, d] of Object.entries(fields)) {
      const el = d.model.el;
      el.removeAttribute("aria-invalid");
      if (el.disabled) continue;
      const v = d.model.read();
      if (invalid(v)) { problems.push([el, d.label]); continue; }
      if (d.required && (v === null || v === "")) { problems.push([el, d.label]); continue; }
      const before = editing ? editing[key] ?? null : null;
      const same = typeof v === "boolean" ? v === !!before : v === before;
      if (editing ? !same : v !== null && v !== false) body[key] = v;
    }
    if (problems.length) {
      for (const [el] of problems) el.setAttribute("aria-invalid", "true");
      say(box, "error", `Check: ${problems.map((p) => p[1]).join(", ")}. Money in dollars and cents, counts as whole numbers, dates as UTC.`);
      problems[0][0].focus();
      return;
    }
    if (editing && !Object.keys(body).length) { say(box, "ok", "Nothing changed."); return; }
    const out = await act(save, box, () => (editing
      ? api(`${path}/${encodeURIComponent(editing.id)}`, { method: "PATCH", body })
      : api(path, { method: "POST", body })));
    if (out) await onSaved();
  });
  fill(null);
  return {
    heading: f.heading, form: f.form,
    edit: (row) => { fill(row); f.form.scrollIntoView({ block: "start" }); const first = Object.values(fields).find((d) => !d.model.el.disabled); if (first) first.model.el.focus(); },
  };
}

// ---- Members' object ---------------------------------------------------------------
export async function releases() {
  const [d, eco] = await Promise.all([api("/api/admin/member-object/releases"), api("/api/admin/economics")]);
  const ship = eco.settings.shipping;
  const box = msgBox();

  const F = {
    label: { model: text("label", 120), label: "Label (admin only)", required: true },
    kind: { model: choice("kind", [["members_object", KIND.members_object], ["early_access", KIND.early_access]]), label: "Kind", initial: "members_object" },
    public_title: { model: text("public_title", 200), label: "Public title" },
    description: { model: text("description", 2000, true), label: "Description" },
    image_url: { model: text("image_url", 500), label: "Image URL (https)" },
    product_gid: { model: gidField("product_gid", "Product"), label: "Shopify product id", required: true },
    variant_gid: { model: gidField("variant_gid", "ProductVariant"), label: "Shopify variant id", required: true },
    price_cents: { model: money$("price"), label: "Price ($)" },
    edition_size: { model: whole("edition_size"), label: "Edition size" },
    unit_cost_cents: { model: money$("unit_cost"), label: "Unit cost ($)" },
    shipping_class: { model: choice("shipping_class", CLASS_OPTIONS), label: "Shipping class" },
    reserve_hours: { model: whole("reserve_hours"), label: "Reservation (hours)" },
    opens_at: { model: utc("opens_at"), label: "Opens (UTC)" },
    closes_at: { model: utc("closes_at"), label: "Closes (UTC)" },
    show_remaining: { model: flag("show_remaining"), label: "Show how many remain" },
    public_release_at: { model: utc("public_release_at"), label: "Public release (UTC)" },
    ships_note: { model: text("ships_note", 200), label: "Ships note" },
  };
  const fld = (k, hint) => field(F[k].label, F[k].model.el, hint);
  const early = h("fieldset", {}, h("legend", {}, "Early access"),
    fld("public_release_at", "Required for early access. When Opens and Closes are empty, opening uses 48 hours before the public release until the public release."),
    fld("ships_note", "For example “Ships in March”."));
  const layout = h("div", { class: "stack" },
    h("fieldset", {}, h("legend", {}, "Release"),
      fld("label", "Only you see it."), fld("kind"), fld("public_title", "Empty until you choose a name."), fld("description"), fld("image_url")),
    h("fieldset", {}, h("legend", {}, "Shopify"),
      fld("product_gid", "The number from Shopify, or gid://shopify/Product/…; the product must be active, tracked, on no sales channel."),
      fld("variant_gid")),
    h("fieldset", {}, h("legend", {}, "Figures (all yours; a draft may leave them empty)"),
      fld("price_cents", "Opening refuses a price below the minimum (rule 5)."), fld("edition_size"), fld("unit_cost_cents"),
      fld("shipping_class"), fld("reserve_hours", "How long a claim holds the piece for payment."),
      fld("opens_at"), fld("closes_at"), check(F.show_remaining.label, F.show_remaining.model.el)),
    early,
  );
  const form = editableForm({
    titleNew: "New release", titleEdit: (r) => `Edit ${r.label}`, saveLabel: "Save release", fields: F, layout,
    path: "/api/admin/member-object/releases", onSaved: () => refresh("Release saved."), lockedWhen: (r) => r.status !== "draft",
  });
  const syncEarly = () => { early.hidden = F.kind.model.el.value !== "early_access"; };
  F.kind.model.el.addEventListener("change", syncEarly);
  form.form.addEventListener("filled", syncEarly);
  syncEarly();

  const actOn = async (r, what, button) => {
    const base = `/api/admin/member-object/releases/${encodeURIComponent(r.id)}`;
    if (what === "close" && !window.confirm(`Close ${r.label} now? Members can no longer claim it.`)) return;
    const out = await act(button, box, () => api(`${base}/${what}`, { method: "POST", body: {} }), r.label);
    if (out) await refresh(what === "open" ? `${r.label} is open.${out.warning ? ` ${out.warning}` : ""}` : `${r.label} is closed.`);
  };
  const guard = async (r, button) => {
    const out = await act(button, box, () => api(`/api/admin/member-object/guard?release=${encodeURIComponent(r.id)}`), `Guard for ${r.label}`);
    if (out) say(box, "ok", `Guard: ${out.ok ? `${r.label} is safe to sell only through the portal.` : `Not safe to open — ${guardText(out.reasons)}.`}`);
  };
  const btn = (label, r, cls, fn) => {
    const b = h("button", { type: "button", class: `small ${cls || ""}`.trim() }, label, h("span", { class: "visually-hidden" }, ` ${r.label}`));
    b.addEventListener("click", () => fn(b));
    return b;
  };
  const estimate = (r) => !!(r.shipping_class && ship[r.shipping_class] && ship[r.shipping_class].estimate !== false);
  const claims = (c) => `${c.paid} paid · ${c.invoiced} reserved · ${c.creating} creating${c.expired || c.failed || c.cancelled ? ` · ${c.expired} expired, ${c.failed} failed, ${c.cancelled} cancelled` : ""}`;

  render("Members' object",
    h("p", { class: "lede" }, "One object a year, sold only through the portal by draft order; early access is a pre-order before the public release. Every figure here is yours."),
    box,
    table("Releases", [
      { label: "Release", cell: (r) => h("span", {}, r.label, h("span", { class: "sub" }, r.public_title || "No public title yet")) },
      { label: "Kind", cell: (r) => KIND[r.kind] || r.kind },
      { label: "Status", cell: (r) => REL_STATUS[r.status] || r.status },
      { label: "Price", num: true, cell: (r) => money(r.price_cents) },
      { label: "Minimum price", num: true, cell: (r) => (isNum(r.min_price_cents) ? withEstimate(money(r.min_price_cents), estimate(r)) : "needs cost and shipping") },
      { label: "Edition", num: true, cell: (r) => (isNum(r.edition_size) ? String(r.edition_size) : "—") },
      { label: "Claims", cell: (r) => claims(r.claims) },
      { label: "Window (UTC)", cell: (r) => h("span", {}, `${fmtDateTime(r.opens_at)} – ${fmtDateTime(r.closes_at)}`,
        r.kind === "early_access" ? h("span", { class: "sub" }, `Public release ${fmtDateTime(r.public_release_at)}`) : null) },
      { label: "Guard", cell: (r) => (r.guard_ok ? `OK${r.guard_checked_at ? `, ${fmtDateTime(r.guard_checked_at)}` : ""}` : r.guard_reasons.length ? guardText(r.guard_reasons) : "Not checked") },
      { label: "Actions", cell: (r) => h("div", { class: "row-actions" },
        btn("Edit", r, "secondary", () => form.edit(r)),
        r.status !== "open" ? btn("Open", r, "", (b) => actOn(r, "open", b)) : btn("Close", r, "secondary", (b) => actOn(r, "close", b)),
        btn("Check guard", r, "secondary", (b) => guard(r, b))) },
    ], d.releases, "none yet."),
    form.heading, form.form,
  );
}

// ---- Capsules --------------------------------------------------------------------------
const CAP_STATUS = { draft: "Draft", scheduled: "Scheduled", closed: "Closed" };

export async function capsules() {
  const d = await api("/api/admin/capsules");
  const box = msgBox();
  const creditsModel = (name) => {
    const el = textInput(name, "", { inputmode: "numeric", class: "num-in" });
    return { el, read: () => { const n = parseWhole(el.value); return n === null ? null : Number.isInteger(n) ? n * 100 : NaN; }, fill: (v) => { el.value = isNum(v) ? String(v / 100) : ""; } };
  };
  const F = {
    season: { model: text("season", 80), label: "Season", required: true },
    title: { model: text("title", 80), label: "Title", required: true },
    shopify_product_gid: { model: gidField("shopify_product_gid", "Product"), label: "Shopify product id", required: true },
    price_cents: { model: creditsModel("price"), label: "Price (credits)", required: true },
    min_consecutive_months: { model: whole("min_consecutive_months"), label: "Minimum consecutive months" },
    opens_at: { model: utc("opens_at"), label: "Opens (UTC)", required: true },
    closes_at: { model: utc("closes_at"), label: "Closes (UTC)", required: true },
  };
  const fld = (k, hint) => field(F[k].label, F[k].model.el, hint);
  const layout = h("div", { class: "stack" },
    fld("season", "For example “Winter 2026”."), fld("title"),
    fld("shopify_product_gid", "A Shopify product tagged capsule (number or gid://shopify/Product/…)."),
    fld("price_cents", "Whole credits; members pay with credits."),
    fld("min_consecutive_months", "Empty = 2 months of membership in a row."),
    fld("opens_at"), fld("closes_at"));
  const form = editableForm({
    titleNew: "New capsule", titleEdit: (c) => `Edit ${c.title}`, saveLabel: "Save capsule", fields: F, layout,
    path: "/api/admin/capsules", onSaved: () => refresh("Capsule saved."),
  });
  const close = async (c, button) => {
    if (!window.confirm(`Close ${c.title}? Members can no longer claim it.`)) return;
    const out = await act(button, box, () => api(`/api/admin/capsules/${encodeURIComponent(c.id)}`, { method: "PATCH", body: { status: "closed" } }), c.title);
    if (out) await refresh(`${c.title} is closed.`);
  };
  const btn = (label, c, cls, fn) => {
    const b = h("button", { type: "button", class: `small ${cls}` }, label, h("span", { class: "visually-hidden" }, ` ${c.title}`));
    b.addEventListener("click", () => fn(b));
    return b;
  };

  render("Capsules",
    h("p", { class: "lede" }, "Seasonal capsules members claim with credits during their window. Members may skip a capsule until it opens."),
    box,
    table("Capsules", [
      { label: "Capsule", cell: (c) => h("span", {}, c.title, h("span", { class: "sub" }, c.season)) },
      { label: "Product", cell: (c) => h("span", { class: "mono" }, c.shopify_product_gid) },
      { label: "Price", num: true, cell: (c) => credits(c.price_cents) },
      { label: "Membership needed", cell: (c) => `${c.min_consecutive_months} month${c.min_consecutive_months === 1 ? "" : "s"}` },
      { label: "Window (UTC)", cell: (c) => `${fmtDateTime(c.opens_at)} – ${fmtDateTime(c.closes_at)}` },
      { label: "Status", cell: (c) => CAP_STATUS[c.status] || c.status },
      { label: "Announced", cell: (c) => fmtDateTime(c.announced_at) },
      { label: "Actions", cell: (c) => h("div", { class: "row-actions" },
        btn("Edit", c, "secondary", () => form.edit(c)),
        c.status !== "closed" ? btn("Close", c, "secondary", (b) => close(c, b)) : null) },
    ], d.capsules, "none yet."),
    form.heading, form.form,
  );
}
