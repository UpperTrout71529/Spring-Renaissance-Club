// Wires the Circle's later tasks into the shared hooks (webhook events, the
// member page, the admin gift queue). Imported once by src/app.js and by the
// cron dispatcher, so both run the same Circle.

import { circleHooks } from "./stripe-events.js";
import { anniversaryOnPaid, anniversaryQueue } from "./anniversary.js";
import { giftQueues } from "../routes/admin-gifts.js";
import { memberSections } from "../routes/circle-member.js";

let done = false;
export function registerCircle() {
  if (done) return;
  done = true;
  circleHooks.invoicePaid.push(anniversaryOnPaid);
  giftQueues.push(anniversaryQueue);
  memberSections.push(async (ctx, { userId }) => {
    const g = await ctx.env.DB.prepare(
      "SELECT status FROM anniversary_gifts WHERE user_id = ?1 AND status = 'awaiting_address' LIMIT 1"
    ).bind(userId).first();
    return g ? { key: "anniversary", value: { status: g.status } } : null;
  });
}
