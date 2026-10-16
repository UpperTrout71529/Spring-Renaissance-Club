// Economics (tz-v2 §12.4 rule 6) and Costs & Circle price (§3.3). Every
// figure comes from the API; nothing is computed here except unit
// conversion. Figures that rest on estimated shipping carry "estimate".

import {
  CLASS_OPTIONS, act, api, bpsInput, bpsPct, check, credits, field, h, isNum, main, money, moneyInput, msgBox, parseDollars,
  parsePercent, parseWhole, ppmRatio, refresh, render, rule3Reason, rule3Terms, say, section, select, table, textInput, withEstimate,
  fmtDateTime, dash, flash, ApiError, sayError,
} from "./ui.js";

const CLASSES = ["S", "M", "L"];
const PROFILE_LABEL = { expected: "Expected (US card)", worst: "Worst case (premium + international card)" };

// Fee settings, collapsed under "Fees".
const FEES = [
  ["stripe_card_bps", "Stripe card (%)", "pct"], ["stripe_intl_bps", "Stripe international (%)", "pct"],
  ["stripe_fixed_cents", "Stripe fixed fee ($)", "usd"], ["stripe_billing_bps", "Stripe Billing (%)", "pct"],
  ["stripe_tax_bps", "Stripe Tax (%)", "pct"], ["shopify_card_bps", "Shopify card (%)", "pct"],
  ["shopify_premium_bps", "Shopify premium card (%)", "pct"], ["shopify_intl_bps", "Shopify international (%)", "pct"],
  ["shopify_fixed_cents", "Shopify fixed fee ($)", "usd"], ["giftcard_fee_bps", "Gift-card payment fee (%)", "pct"],
];

// ---- the settings form -------------------------------------------------------------
// Each control knows its setting key, how to read it and its current value.
function settingsForm(s, onSaved) {
  const controls = [];
  const box = msgBox();
  const usd = (key, label, hint) => {
    const input = moneyInput(key, s[key]);
    controls.push({ key, input, label, read: () => parseDollars(input.value), current: s[key], kind: "usd" });
    return field(label, input, hint);
  };
  const pct = (key, label, hint) => {
    const input = textInput(key, bpsInput(s[key]), { inputmode: "decimal", class: "num-in" });
    controls.push({ key, input, label, read: () => parsePercent(input.value), current: s[key], kind: "pct" });
    return field(label, input, hint);
  };

  // Shipping: one row per class (dollars + estimate).
  const ship = {};
  const shippingRows = CLASSES.map((c) => {
    const row = s.shipping[c] || { cents: null, estimate: true };
    const input = moneyInput(`shipping_${c}`, row.cents);
    const est = h("input", { type: "checkbox", name: `shipping_${c}_estimate`, checked: row.estimate !== false });
    ship[c] = { input, est, current: row };
    return h("div", { class: "ship-row" }, field(`Shipping ${c} ($)`, input), check(`Shipping ${c} is an estimate`, est));
  });

  const guard = select("guard_profile", [["worst", "Worst case"], ["expected", "Expected"]], s.guard_profile);
  const rewardInput = textInput("referral_reward", isNum(s.referral_reward_cents) ? String(s.referral_reward_cents / 100) : "", { inputmode: "numeric", class: "num-in" });
  controls.push({ key: "referral_reward_cents", input: rewardInput, label: "Member's reward (credits)",
    read: () => { const n = parseWhole(rewardInput.value); return n === null ? null : Number.isInteger(n) ? n * 100 : NaN; }, current: s.referral_reward_cents });

  const save = h("button", { type: "submit" }, "Save settings");
  const form = h("form", { class: "settings", novalidate: true, "aria-labelledby": "settings-h" },
    h("fieldset", {}, h("legend", {}, "Shipping per class (US, duties included)"),
      h("p", { class: "hint" }, "Empty = not entered: nothing in that class is eligible. While a class is an estimate, its pieces need the higher margin below."),
      shippingRows),
    h("fieldset", {}, h("legend", {}, "Margins"),
      pct("min_margin_bps", "Minimum margin (%)", "Of the price the member pays (rules 2 and 5)."),
      pct("estimate_min_margin_bps", "Minimum margin while shipping is an estimate (%)")),
    h("fieldset", {}, h("legend", {}, "Guard profile"),
      field("Card profile the rules use", guard, "Worst case = premium and international cards (your choice for rule 2); expected = a US standard card.")),
    h("fieldset", {}, h("legend", {}, "Invitation"),
      usd("referral_discount_cents", "Friend's discount ($)", "Off the joining fee; not more than the joining fee."),
      field("Member's reward (credits)", rewardInput, "Whole credits, after the friend's second payment.")),
    h("fieldset", {}, h("legend", {}, "Gifts"),
      usd("welcome_cap_cents", "Welcome cap ($)", "Landed cost plus shipping of a welcome piece."),
      usd("anniversary_cap_cents", "Anniversary cap ($)"),
      pct("anniversary_share_bps", "Anniversary share of a year's contribution (%)")),
    h("details", { class: "fees" }, h("summary", {}, "Fees"),
      h("div", { class: "fee-grid" }, FEES.map(([key, label, kind]) => (kind === "usd" ? usd(key, label) : pct(key, label))))),
    h("div", { class: "actions" }, save),
    box,
  );

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const changes = {};
    const bad = [];
    for (const el of form.querySelectorAll("[aria-invalid]")) el.removeAttribute("aria-invalid");
    for (const c of controls) {
      const v = c.read();
      if (v === null || Number.isNaN(v)) { bad.push(c); continue; }
      if (v !== c.current) changes[c.key] = v;
    }
    const shipping = {};
    let shipChanged = false;
    for (const c of CLASSES) {
      const v = parseDollars(ship[c].input.value);
      if (Number.isNaN(v)) { bad.push({ input: ship[c].input, label: `Shipping ${c} ($)` }); continue; }
      shipping[c] = { cents: v, estimate: ship[c].est.checked };
      if (v !== ship[c].current.cents || ship[c].est.checked !== (ship[c].current.estimate !== false)) shipChanged = true;
    }
    if (bad.length) {
      for (const b of bad) b.input.setAttribute("aria-invalid", "true");
      say(box, "error", `Check these fields: ${bad.map((b) => b.label).join(", ")}. Money in dollars and cents (e.g. 6.00), rates in percent (e.g. 2.9).`);
      bad[0].input.focus();
      return;
    }
    if (shipChanged) changes.shipping = shipping;
    if (guard.value !== s.guard_profile) changes.guard_profile = guard.value;
    if (!Object.keys(changes).length) { say(box, "ok", "Nothing changed."); return; }
    const out = await act(save, box, () => api("/api/admin/economics", { method: "PUT", body: { changes } }));
    if (out) onSaved(out);
  });
  return [h("h2", { id: "settings-h" }, "Settings"), form];
}

// ---- the computed figures ----------------------------------------------------------
const PROFILE_ROWS = [
  ["monthly_net_cents", "Monthly net (after Stripe fees)", false],
  ["joining_net_cents", "Joining net (full)", false],
  ["joining_net_with_invitation_cents", "Joining net, with invitation", false],
  ["monthly_contribution_cents", "Monthly contribution (all 20 credits spent)", true],
  ["yearly_contribution_cents", "Yearly contribution", true],
  ["anniversary_budget_cents", "Anniversary budget", true],
];

const REASONS = {
  excluded_gift_card: "Gift card (excluded)", excluded_catalog: "Small Pleasures (excluded)", excluded_capsule: "Capsule (excluded)",
  excluded_members_object: "Members' object (excluded)", excluded_membership: "Membership (excluded)", not_on_list: "Not on the list",
  zero_price: "No price", no_cost: "No cost entered", no_shipping: "No shipping for its class", margin_below_min: "Margin below the minimum",
};
export const reasonLabel = (r) => (r ? REASONS[r] || r.replace(/_/g, " ") : "—");
const EXCLUSIONS = { gift_card: "Gift card", catalog: "Small Pleasures", capsule: "Capsule", membership: "Membership", members_object: "Members' object" };

function figures(d) {
  const est = d.estimates.length > 0;
  const needs = (v, isEst, f = money) => (v === null || v === undefined ? "needs data" : withEstimate(f(v), isEst));
  const ratio = (p) => ppmRatio(p);
  const r = d.referral || {};
  const noCosts = !isNum(d.cost_per_credit_ppm);
  // The anniversary budget is 0 (not null) when data are missing: say so.
  const budget = (v) => (noCosts ? h("span", {}, money(v), h("span", { class: "sub" }, "needs cost data")) : withEstimate(money(v), est));
  const budgetOrFigure = (k, v, dependsOnCosts) => (k === "anniversary_budget_cents" ? budget(v) : needs(v, dependsOnCosts && est));
  return [
    section("Needs data from Felix",
      d.needs_data.length
        ? h("ul", { "aria-label": "Needs data from Felix" }, d.needs_data.map((n) => h("li", {}, n)))
        : h("p", {}, "Nothing — every figure the rules need is entered."),
      d.estimates.length
        ? [h("p", {}, "These are estimates, so the figures computed from them are marked ", h("span", { class: "tag" }, "estimate"), ":"),
          h("ul", { "aria-label": "Estimates in use" }, d.estimates.map((n) => h("li", {}, n)))]
        : null),
    section("What a member brings",
      h("p", { class: "lede" }, `Membership ${money(d.settings.monthly_cents)} a month, joining fee ${money(d.settings.joining_cents)}. The rules use the ${d.guard_profile === "worst" ? "worst-case" : "expected"} profile.`),
      h("div", { class: "table-wrap", role: "region", "aria-label": "Per member, by card profile", tabindex: "0" }, h("table", {},
        h("caption", {}, "Per member, by card profile"),
        h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Figure"),
          ["expected", "worst"].map((p) => h("th", { scope: "col", class: "num" }, PROFILE_LABEL[p], d.guard_profile === p ? h("span", { class: "sub" }, "used by the rules") : null)))),
        h("tbody", {}, PROFILE_ROWS.map(([k, label, dependsOnCosts]) => h("tr", {}, h("th", { scope: "row" }, label),
          ["expected", "worst"].map((p) => h("td", { class: "num" }, budgetOrFigure(k, d.profiles[p][k], dependsOnCosts)))))),
      ))),
    section("Cost per credit-dollar",
      h("dl", { class: "fields" },
        h("dt", {}, "Cost per credit-dollar"), h("dd", {}, needs(d.cost_per_credit_ppm, est, ratio), h("span", { class: "sub" }, "Cost of goods behind $1 of credits (§12.5).")),
        h("dt", {}, "The brief's c"), h("dd", {}, needs(d.brief_c_ppm, est, ratio), h("span", { class: "sub" }, "Cost ÷ retail price, for an all-discounted catalogue.")),
        h("dt", {}, "Worst item"), h("dd", {}, d.worst_item
          ? h("span", {}, h("a", { href: `#/circle/costs?q=${encodeURIComponent(d.worst_item.handle)}` }, d.worst_item.handle), ` — cost is ${(d.worst_item.cost_ratio_ppm / 1e4).toFixed(1)}% of the price`)
          : "needs data"),
      )),
    section("Invitation check",
      h("p", { class: r.ok ? "ok" : "warn" }, r.ok ? "Holds: an invitation brings more than it costs." : rule3Reason(r.reason), est && r.terms ? [" ", h("span", { class: "tag" }, "estimate")] : null),
      r.terms ? h("ul", {}, rule3Terms(r)) : null,
      h("p", { class: "hint" }, `Now: friend's discount ${money(d.settings.referral_discount_cents)}, member's reward ${credits(d.settings.referral_reward_cents)}.`)),
    section("Anniversary budget",
      h("p", {}, "Per gift: ", noCosts ? `${money(d.anniversary_budget_cents)} — needs cost data, so anniversaries are skipped` : withEstimate(money(d.anniversary_budget_cents), est), ` (cap ${money(d.settings.anniversary_cap_cents)}, ${bpsPct(d.settings.anniversary_share_bps)} of a year's contribution).`),
      h("p", {}, "Welcome basis: ", isNum(d.welcome_basis.landed_cost_cents)
        ? `the dearest active welcome piece costs ${money(d.welcome_basis.landed_cost_cents)} + ${money(d.welcome_basis.shipping_cents)} shipping.`
        : "needs the active welcome pieces with landed cost and shipping.")),
    section("Circle price",
      h("p", {}, `${d.circle_price.eligible} variant${d.circle_price.eligible === 1 ? "" : "s"} on the list carry the Circle price. `,
        h("a", { href: "#/circle/costs" }, "Costs & Circle price"), " has every variant."),
      table("Excluded from the Circle price", [
        { label: "Piece", cell: (i) => h("span", {}, i.title || i.handle, h("span", { class: "sub" }, i.handle)) },
        { label: "Price", num: true, cell: (i) => money(i.price_cents) },
        { label: "Reason", cell: (i) => reasonLabel(i.reason) },
        { label: "Max cost that would pass", num: true, cell: (i) => withEstimate(money(i.max_cost_cents), est && isNum(i.max_cost_cents)) },
      ], d.circle_price.excluded, "every variant on the list is eligible.")),
  ];
}

export async function economics() {
  const d = await api("/api/admin/economics");
  const show = (snapshot) => {
    render("Economics",
      h("p", { class: "lede" }, "Never below zero: the figures below are computed on current data. Empty means missing, never zero."),
      ...figures(snapshot),
      ...settingsForm(snapshot.settings, (out) => {
        const warn = out.warning ? ` ${rule3Reason(out.warning)}` : "";
        flash(`Settings saved.${warn}`);
        show(out.economics);
      }),
    );
  };
  show(d);
}

// ---- Costs & Circle price ----------------------------------------------------------
function shippingSummary(shipping) {
  return `Shipping: ${CLASSES.map((c) => {
    const r = shipping[c] || {};
    return `${c} ${isNum(r.cents) ? money(r.cents) : "—"}${isNum(r.cents) && r.estimate !== false ? " (estimate)" : ""}`;
  }).join(" · ")}`;
}

function syncStatus(st, box) {
  const syncNow = h("button", { type: "button", class: "secondary" }, "Sync member price now");
  syncNow.addEventListener("click", async () => {
    const out = await act(syncNow, box, () => api("/api/admin/circle-price/sync", { method: "POST", body: {} }));
    if (out) await refresh("Member price synced.");
  });
  return section("Member price in Shopify",
    h("dl", { class: "fields" },
      h("dt", {}, "Sync"), h("dd", {}, st.sync_enabled ? "On" : "Off (CIRCLE_PRICE_SYNC) — nothing is sent to Shopify"),
      h("dt", {}, "Members with the Circle price"), h("dd", {}, String(st.members_with_price)),
      h("dt", {}, "Eligible variants"), h("dd", {}, String(st.eligible_variants)),
    ),
    table("Discount shards", [
      { label: "Shard", cell: (x) => String(x.shard) },
      { label: "Status", cell: (x) => x.status },
      { label: "Customers", num: true, cell: (x) => String(x.customers) },
      { label: "Variants", num: true, cell: (x) => String(x.variants) },
      { label: "Last synced", cell: (x) => fmtDateTime(x.last_synced_at) },
      { label: "Last error", cell: (x) => dash(x.last_error) },
    ], st.discounts, "none yet."),
    h("div", { class: "actions" }, syncNow),
  );
}

function variantTable(variants, reload) {
  if (!variants.length) return h("p", { class: "empty" }, "No variants yet — run the catalog sync.");
  const byProduct = new Map();
  for (const v of variants) {
    if (!byProduct.has(v.product_gid)) byProduct.set(v.product_gid, []);
    byProduct.get(v.product_gid).push(v);
  }
  const COLS = 11;

  const listToggle = async (body, control, box, focusKey) => {
    const out = await act(control, box, () => api("/api/admin/circle-price/list", { method: "PUT", body }));
    if (out) await reload(body.on_list ? "Added to the Circle price list." : "Taken off the Circle price list.", focusKey);
    else if (control.type === "checkbox") control.checked = !control.checked;
  };

  const variantRow = (v) => {
    const box = msgBox();
    const cost = moneyInput("cost", v.cost_cents, { "aria-label": `Cost ($) for ${v.title}` });
    const cls = select("shipping_class", CLASS_OPTIONS, v.shipping_class, { "aria-label": `Shipping class for ${v.title}` });
    const save = h("button", { type: "button", class: "small", "data-key": `save:${v.variant_gid}` }, "Save", h("span", { class: "visually-hidden" }, ` cost for ${v.title}`));
    const onList = h("input", { type: "checkbox", checked: v.on_list, "aria-label": `On the list: ${v.title}`, "data-key": `list:${v.variant_gid}` });
    onList.addEventListener("change", () => listToggle({ variant_gid: v.variant_gid, on_list: onList.checked }, onList, box, `list:${v.variant_gid}`));
    save.addEventListener("click", async () => {
      const c = parseDollars(cost.value);
      if (Number.isNaN(c)) {
        cost.setAttribute("aria-invalid", "true");
        say(box, "error", "Enter the cost in dollars and cents, or leave it empty (not participating).");
        cost.focus();
        return;
      }
      cost.removeAttribute("aria-invalid");
      const body = { variant_gid: v.variant_gid, cost_cents: c, shipping_class: cls.value || null };
      if (c === 0) {
        if (!window.confirm(`A cost of zero for ${v.title}? Zero means the piece costs nothing to you; an empty field means it does not take part.`)) {
          say(box, "error", "Not saved: a zero cost needs your confirmation.");
          return;
        }
        body.zero_confirmed = true;
      }
      const out = await act(save, box, () => api("/api/admin/costs", { method: "PUT", body }));
      if (out) await reload(`Cost saved for ${v.title}: ${out.item && out.item.eligible ? "eligible" : reasonLabel(out.item && out.item.reason)}.`, `save:${v.variant_gid}`);
    });
    return h("tr", {},
      h("th", { scope: "row" }, v.title, h("span", { class: "sub" }, v.status !== "ACTIVE" || !v.published ? `${v.status.toLowerCase()}${v.published ? "" : ", not on the Online Store"}` : "")),
      h("td", { class: "num" }, money(v.price_cents)),
      h("td", {}, v.exclusion ? EXCLUSIONS[v.exclusion] || v.exclusion : "—"),
      h("td", {}, onList),
      h("td", {}, cost, v.zero_confirmed ? h("span", { class: "sub" }, "zero confirmed") : null),
      h("td", {}, cls),
      h("td", {}, v.eligible ? "Yes" : "No"),
      h("td", {}, reasonLabel(v.reason)),
      h("td", { class: "num" }, withEstimate(money(v.circle_price_cents), !!v.shipping_estimate && isNum(v.circle_price_cents))),
      h("td", { class: "num" }, withEstimate(money(v.max_cost_cents), !!v.shipping_estimate && isNum(v.max_cost_cents))),
      h("td", {}, save, box),
    );
  };

  const groupRow = (productGid, list) => {
    const box = msgBox();
    const handle = list[0].handle;
    const allOn = list.every((v) => v.on_list);
    const anyOn = list.some((v) => v.on_list);
    const buttons = [];
    if (!allOn) {
      const b = h("button", { type: "button", class: "secondary small", "data-key": `put:${productGid}` }, `Put every variant of ${handle} on the list`);
      b.addEventListener("click", () => listToggle({ product_gid: productGid, on_list: true }, b, box, `put:${productGid}`));
      buttons.push(b);
    }
    if (anyOn) {
      const b = h("button", { type: "button", class: "secondary small", "data-key": `take:${productGid}` }, `Take every variant of ${handle} off the list`);
      b.addEventListener("click", () => listToggle({ product_gid: productGid, on_list: false }, b, box, `take:${productGid}`));
      buttons.push(b);
    }
    return h("tr", { class: "group" }, h("th", { scope: "rowgroup", colspan: String(COLS) },
      h("span", {}, `${handle} · ${list.length} variants`), h("span", { class: "row-actions" }, buttons), box));
  };

  return h("div", { class: "table-wrap", role: "region", "aria-label": "Catalog variants", tabindex: "0" }, h("table", { class: "costs" },
    h("caption", {}, "Catalog variants"),
    h("thead", {}, h("tr", {}, ["Variant", "Price", "Exclusion", "On list", "Cost ($)", "Shipping class", "Eligible", "Reason", "Circle price", "Max cost", "Save"]
      .map((l, i) => h("th", { scope: "col", class: [1, 8, 9].includes(i) ? "num" : null }, l)))),
    [...byProduct.entries()].map(([pg, list]) => h("tbody", {}, list.length > 1 ? groupRow(pg, list) : null, list.map(variantRow))),
  ));
}

export async function costs(params) {
  const q = params.get("q") || "";
  const qs = q ? `?q=${encodeURIComponent(q)}` : "";
  const [c, st] = await Promise.all([api(`/api/admin/costs${qs}`), api("/api/admin/circle-price/status")]);
  const box = msgBox();
  const tableHolder = h("div", {});
  const summary = h("p", { class: "lede" }, shippingSummary(c.shipping), ". ", h("a", { href: "#/circle/economics" }, "Change in Economics"), ".");

  // Re-reads the variants only; keeps the page (and focus) where it was.
  const reload = async (message, focusKey) => {
    try {
      const fresh = await api(`/api/admin/costs${qs}`);
      tableHolder.replaceChildren(variantTable(fresh.variants, reload));
    } catch (err) {
      sayError(box, err instanceof ApiError ? err : new ApiError(0, "error", "Something went wrong. Please try again."));
      return;
    }
    say(box, "ok", message);
    const el = focusKey && main.querySelector(`[data-key="${CSS.escape(focusKey)}"]`);
    if (el) el.focus();
  };
  tableHolder.append(variantTable(c.variants, reload));

  const syncCatalog = h("button", { type: "button" }, "Sync catalog from Shopify");
  syncCatalog.addEventListener("click", async () => {
    const out = await act(syncCatalog, box, () => api("/api/admin/catalog/sync", { method: "POST", body: {} }));
    if (out) await refresh(`Catalog synced: ${out.synced} variants, ${out.eligible} eligible.`);
  });

  render("Costs & Circle price",
    h("p", { class: "lede" }, "Landed cost per variant (goods, inbound freight, duties, packaging). An empty cost means the variant does not take part; zero must be confirmed. The Circle price is 25% off for eligible variants on your list."),
    summary,
    h("div", { class: "actions" }, syncCatalog),
    box,
    h("form", { class: "inline", role: "search", onsubmit: (e) => {
      e.preventDefault();
      const v = new FormData(e.target).get("q");
      location.hash = v ? `#/circle/costs?q=${encodeURIComponent(v)}` : "#/circle/costs";
    } },
      h("label", {}, "Search the catalog", h("input", { type: "search", name: "q", value: q, autocomplete: "off" })),
      h("button", { type: "submit" }, "Search"),
    ),
    tableHolder,
    syncStatus(st, box),
  );
}

