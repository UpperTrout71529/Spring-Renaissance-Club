// Gift pools (welcome set, anniversary pool) and the gift queue (welcome
// pieces and anniversary gifts: assign, create the $0 Shopify order).
// Orders are created only when Felix confirms.

import {
  CLASS_OPTIONS, act, api, centsInput, check, field, fmtDate, gid, h, isNum, money, msgBox, namedForm, parseDollars, parseWhole,
  refresh, render, say, section, select, table, textInput, withEstimate, yesNo,
} from "./ui.js";

const POOLS = { welcome: "Welcome pieces", anniversary: "Anniversary options" };

// ---- Gift pools --------------------------------------------------------------------
function optionForm(onSaved) {
  const box = msgBox();
  const kind = select("kind", [["welcome", "Welcome piece"], ["anniversary", "Anniversary option"]], "welcome");
  const title = textInput("title", "", { maxlength: "120", required: true });
  const blurb = h("textarea", { name: "blurb", rows: "3", maxlength: "500" });
  const variant = textInput("variant", "", { required: true });
  const image = textInput("image_url", "", { inputmode: "url" });
  const landed = textInput("landed_cost", "", { inputmode: "decimal", class: "num-in" });
  const cls = select("shipping_class", CLASS_OPTIONS, "");
  const active = h("input", { type: "checkbox", name: "active" });
  const sort = textInput("sort", "0", { inputmode: "numeric", class: "num-in" });
  const save = h("button", { type: "submit" }, "Save option");
  const cancel = h("button", { type: "button", class: "secondary", hidden: true }, "Cancel edit");
  let editing = null;

  const f = namedForm("Add an option", { class: "stack" },
    field("Pool", kind),
    field("Title", title, "Shown to members (welcome pieces) — up to 120 characters."),
    field("Blurb", blurb),
    field("Shopify variant id", variant, "The number from Shopify, or gid://shopify/ProductVariant/…"),
    field("Image URL (https)", image),
    field("Landed cost ($)", landed, "Goods, inbound freight, duties and packaging. Required for an active option."),
    field("Shipping class", cls),
    check("Active", active),
    field("Sort", sort, "Lower comes first."),
    h("div", { class: "actions" }, save, cancel),
    box,
  );

  const fill = (o) => {
    editing = o;
    kind.value = o ? o.kind : "welcome";
    kind.disabled = false;
    title.value = o ? o.title : "";
    blurb.value = o ? o.blurb || "" : "";
    variant.value = o ? o.shopify_variant_gid : "";
    image.value = o ? o.image_url || "" : "";
    landed.value = o ? centsInput(o.landed_cost_cents) : "";
    cls.value = o ? o.shipping_class || "" : "";
    active.checked = o ? !!o.active : false;
    sort.value = o ? String(o.sort ?? 0) : "0";
    cancel.hidden = !o;
    f.setTitle(o ? `Edit ${o.title}` : "Add an option");
    box.replaceChildren();
  };
  cancel.addEventListener("click", () => { fill(null); title.focus(); });

  f.form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const cost = parseDollars(landed.value);
    const s = parseWhole(sort.value, { signed: true });
    const problems = [];
    if (!title.value.trim()) problems.push([title, "a title"]);
    if (!variant.value.trim()) problems.push([variant, "the Shopify variant id"]);
    if (Number.isNaN(cost)) problems.push([landed, "the landed cost in dollars and cents"]);
    if (s !== null && Number.isNaN(s)) problems.push([sort, "a whole number for sort"]);
    for (const el of [title, variant, landed, sort]) el.removeAttribute("aria-invalid");
    if (problems.length) {
      for (const [el] of problems) el.setAttribute("aria-invalid", "true");
      say(box, "error", `Please enter ${problems.map((p) => p[1]).join(", ")}.`);
      problems[0][0].focus();
      return;
    }
    const body = {
      kind: kind.value, title: title.value.trim(), blurb: blurb.value.trim() || null, shopify_variant_gid: gid("ProductVariant", variant.value),
      image_url: image.value.trim() || null, landed_cost_cents: cost, shipping_class: cls.value || null, active: active.checked, sort: s ?? 0,
    };
    const out = await act(save, box, () => (editing
      ? api(`/api/admin/gift-options/${encodeURIComponent(editing.id)}`, { method: "PATCH", body })
      : api("/api/admin/gift-options", { method: "POST", body })));
    if (out) await onSaved();
  });
  return { heading: f.heading, form: f.form, edit: (o) => { fill(o); f.form.scrollIntoView({ block: "start" }); title.focus(); } };
}

export async function giftPools() {
  const [g, eco] = await Promise.all([api("/api/admin/gift-options"), api("/api/admin/economics")]);
  const s = eco.settings;
  const est = eco.estimates.length > 0;
  const shipEst = (o) => isNum(o.shipping_cents) && !!(s.shipping[o.shipping_class] && s.shipping[o.shipping_class].estimate !== false);
  const form = optionForm(() => refresh("Option saved."));
  const editButton = (o) => {
    const b = h("button", { type: "button", class: "secondary small" }, "Edit", h("span", { class: "visually-hidden" }, ` ${o.title}`));
    b.addEventListener("click", () => form.edit(o));
    return b;
  };
  const columns = (kind) => [
    { label: "Title", cell: (o) => h("span", {}, o.title, o.blurb ? h("span", { class: "sub" }, o.blurb) : null) },
    { label: "Shopify variant", cell: (o) => h("span", { class: "mono" }, o.shopify_variant_gid) },
    { label: "Image", cell: (o) => (o.image_url ? h("a", { href: o.image_url, target: "_blank", rel: "noopener noreferrer" }, "Open", h("span", { class: "visually-hidden" }, ` image of ${o.title} (opens in a new tab)`)) : "—") },
    { label: "Landed cost", num: true, cell: (o) => money(o.landed_cost_cents) },
    { label: "Shipping", num: true, cell: (o) => (o.shipping_class ? h("span", {}, `${o.shipping_class} `, withEstimate(money(o.shipping_cents), shipEst(o))) : "—") },
    { label: "With shipping", num: true, cell: (o) => (isNum(o.landed_cost_cents) && isNum(o.shipping_cents) ? withEstimate(money(o.landed_cost_cents + o.shipping_cents), shipEst(o)) : "—") },
    kind === "welcome"
      ? { label: "Cap", cell: (o) => (o.within_cap ? "Within cap" : "Over cap or incomplete") }
      : { label: "Budget", cell: (o) => (o.within_budget ? "Within budget" : "Over budget or incomplete") },
    { label: "Active", cell: (o) => yesNo(o.active) },
    { label: "Sort", num: true, cell: (o) => String(o.sort) },
    { label: "Edit", cell: editButton },
  ];
  const of = (kind) => g.options.filter((o) => o.kind === kind);
  const activeWelcome = of("welcome").filter((o) => o.active).length;

  render("Gift pools",
    h("p", { class: "lede" }, "Welcome pieces come from Small Pleasures: at least two active, each within the cap with shipping. Anniversary options are allowed only within the budget per gift."),
    section(POOLS.welcome,
      h("p", {}, `Cap: landed cost plus shipping ≤ ${money(s.welcome_cap_cents)}. Active: ${activeWelcome}${activeWelcome < 2 ? " — at least 2 are needed before the Circle can open." : "."}`),
      table(POOLS.welcome, columns("welcome"), of("welcome"), "none yet."),
    ),
    section("Anniversary pool",
      h("p", {}, "Anniversary budget per gift: ", withEstimate(money(g.anniversary_budget_cents), est && isNum(eco.cost_per_credit_ppm)),
        g.anniversary_budget_cents > 0 ? "." : " — with no budget, anniversaries are skipped (",
        g.anniversary_budget_cents > 0 ? null : h("a", { href: "#/circle/economics" }, "Economics"),
        g.anniversary_budget_cents > 0 ? null : " lists the missing data)."),
      table(POOLS.anniversary, columns("anniversary"), of("anniversary"), "none yet."),
    ),
    form.heading, form.form,
  );
}

// ---- Gift queue -----------------------------------------------------------------------
const WELCOME_STATUS = { awaiting_choice: "Awaiting choice", chosen: "Chosen", order_created: "Order created" };
const ANNIV_STATUS = { awaiting_address: "Awaiting address", ready: "Ready", order_created: "Order created", skipped_budget: "Skipped (budget)" };
const SKIP_REASONS = {
  budget_zero: "The budget was $0.00 — cost data missing or no contribution left.",
  no_option_within_budget: "No active option was within the budget.",
};

export async function giftQueue() {
  const [q, g] = await Promise.all([api("/api/admin/gift-queue"), api("/api/admin/gift-options")]);
  const box = msgBox();
  // Only pieces a member could choose: active and within the cap with shipping.
  const welcomeOptions = g.options.filter((o) => o.kind === "welcome" && o.active && o.within_cap);
  const annivOptions = g.options.filter((o) => o.kind === "anniversary" && o.active);
  const who = (r) => r.email + (r.name ? ` (${r.name})` : "");

  const createOrder = async (path, label, button) => {
    if (!window.confirm(`Create the $0 Shopify order for ${label}? This creates a real order in Shopify.`)) return;
    const out = await act(button, box, () => api(path, { method: "POST", body: {} }), `Order for ${label}`);
    if (out) await refresh(`Order created for ${label}.`);
  };
  const assign = (path, options, label) => {
    const sel = select("gift_option_id", [["", "Choose…"], ...options.map((o) => [o.id, o.title])], "", { "aria-label": `Piece for ${label}` });
    const b = h("button", { type: "button", class: "small" }, "Assign", h("span", { class: "visually-hidden" }, ` for ${label}`));
    b.addEventListener("click", async () => {
      if (!sel.value) { say(box, "error", `Choose a piece for ${label} first.`); sel.focus(); return; }
      const out = await act(b, box, () => api(path, { method: "POST", body: { gift_option_id: sel.value } }), `Assign for ${label}`);
      if (out) await refresh(`Assigned for ${label}.`);
    });
    return h("span", { class: "row-actions" }, sel, b);
  };
  const orderButton = (path, label) => {
    const b = h("button", { type: "button", class: "small" }, "Create order", h("span", { class: "visually-hidden" }, ` for ${label}`));
    b.addEventListener("click", () => createOrder(path, label, b));
    return b;
  };

  const welcomeAction = (r) => {
    const base = `/api/admin/gift-queue/${encodeURIComponent(r.id)}`;
    if (r.status === "awaiting_choice") {
      if (r.can_assign) return welcomeOptions.length ? assign(`${base}/assign`, welcomeOptions, r.email) : "No active welcome piece to assign.";
      const left = Math.max(1, 14 - r.days_waiting);
      return `The member can choose for ${left} more day${left === 1 ? "" : "s"}.`;
    }
    if (r.status === "chosen") return r.has_address ? orderButton(`${base}/create-order`, r.email) : "No delivery address.";
    if (r.status === "order_created") return h("span", { class: "mono" }, r.shopify_order_gid || "Order created");
    return "—";
  };
  const annivAction = (r) => {
    const base = `/api/admin/anniversary/${encodeURIComponent(r.id)}`;
    if (r.status === "awaiting_address" || r.status === "ready") {
      const within = annivOptions.filter((o) => isNum(o.landed_cost_cents) && isNum(o.shipping_cents) && o.landed_cost_cents + o.shipping_cents <= (r.budget_cents || 0));
      const parts = [];
      if (within.length) parts.push(assign(`${base}/assign`, within, r.email));
      else parts.push(h("span", { class: "sub" }, "No active option within this gift's budget."));
      if (r.status === "ready" && r.option_title) parts.push(orderButton(`${base}/create-order`, r.email));
      else if (r.status === "awaiting_address") parts.push(h("span", { class: "sub" }, "Waiting for the member to confirm the address."));
      return h("div", { class: "stack-tight" }, parts);
    }
    if (r.status === "order_created") return h("span", { class: "mono" }, r.shopify_order_gid || "Order created");
    return "—";
  };

  render("Gift queue",
    h("p", { class: "lede" }, "Members choose their welcome piece within 14 days; after that you can assign one. Orders are created in Shopify only when you press Create order."),
    box,
    section("Welcome pieces",
      table("Welcome queue", [
        { label: "Member", cell: who },
        { label: "Status", cell: (r) => h("span", {}, WELCOME_STATUS[r.status] || r.status, r.needs_attention ? h("strong", { class: "sub warn" }, "Needs attention: the last order attempt failed") : null) },
        { label: "Piece", cell: (r) => r.option_title || "—" },
        { label: "Waiting", num: true, cell: (r) => `${r.days_waiting} day${r.days_waiting === 1 ? "" : "s"}` },
        { label: "Address", cell: (r) => yesNo(r.has_address) },
        { label: "Action", cell: welcomeAction },
      ], q.welcome, "nothing waiting."),
    ),
    section("Anniversary gifts",
      table("Anniversary queue", [
        { label: "Member", cell: (r) => r.email },
        { label: "Anniversary", num: true, cell: (r) => `Year ${r.n}` },
        { label: "Status", cell: (r) => ANNIV_STATUS[r.status] || r.status },
        { label: "Reason", cell: (r) => (r.reason ? SKIP_REASONS[r.reason] || r.reason.replace(/_/g, " ") : "—") },
        { label: "Budget", num: true, cell: (r) => money(r.budget_cents) },
        { label: "Piece", cell: (r) => r.option_title || "—" },
        { label: "Address", cell: (r) => yesNo(r.has_address) },
        { label: "Since", cell: (r) => fmtDate(r.created_at) },
        { label: "Action", cell: annivAction },
      ], q.anniversary || [], "nothing waiting."),
    ),
  );
}
