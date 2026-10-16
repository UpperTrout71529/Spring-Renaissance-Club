// Audit of storefront orders (docs/tz-v2-circle.md §6.2; Felix §19 #2).
//
// The member price is an automatic discount that Shopify gives to listed
// customers, identified by a signed-in account or the email typed at checkout.
// Someone who types a member's email looks like that member to Shopify and
// cannot be told apart here; rule 2 keeps such an order above the minimum
// margin. What this audit catches: an order that got the "Circle price" for a
// buyer who is not an entitled member now (a stale discount, a lapsed member's
// email) → admin flag + email to Felix. Every Circle-price order is recorded
// as an event, so the admin can list them.
//
// Later tasks add checks (members' object bypass): (svc, { order, user }).

import { isEntitled, TITLE } from "./member-price.js";
import { raiseFlag } from "./notify.js";
import { recordEvent } from "../lib/events.js";
import { maskEmail } from "../lib/email-address.js";

import { objectOrderCheck } from "./member-object.js";

export const orderChecks = [objectOrderCheck];

export async function auditOrder(svc, { order, user }) {
  const apps = (order.discountApplications && order.discountApplications.nodes) || [];
  const circle = apps.some((d) => d && d.__typename === "AutomaticDiscountApplication" && String(d.title || "").startsWith(TITLE));
  if (circle) {
    const entitled = user ? await isEntitled(svc.env, user.id, svc.nowIso()) : false;
    await recordEvent(svc.env, { id: `circle_price_order:${order.id}`, userId: user ? user.id : null, name: "circle_price_order",
      props: { order_id: order.id, entitled }, createdAt: svc.nowIso() });
    if (!entitled) {
      await raiseFlag(svc, {
        kind: "circle_price_non_member", dedupeKey: `circle_price_non_member:${order.id}`, userId: user ? user.id : null, ref: order.id,
        title: "Circle price on an order from a non-member",
        lines: [`Order ${order.id} received the Circle price, but the buyer (${order.email ? maskEmail(order.email) : "no email"}) is not an active member.`,
          "It may be a lapsed member or someone using a member's email. The margin rule kept the order above the minimum."],
      });
    }
  }
  for (const check of orderChecks) await check(svc, { order, user });
}
