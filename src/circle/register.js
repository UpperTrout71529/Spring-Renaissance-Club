// Wires the Circle's later tasks into the shared hooks (webhook events, the
// member page, the admin gift queue). Imported once by src/app.js and by the
// cron dispatcher, so both run the same Circle.

import { circleHooks } from "./stripe-events.js";
import { anniversaryOnPaid, anniversaryQueue } from "./anniversary.js";
import { giftQueues } from "../routes/admin-gifts.js";
import { memberSections } from "../routes/circle-member.js";
import { invitations } from "../routes/circle-join.js";
import * as inv from "./invitations.js";
import { deletionClosers } from "./account-delete.js";
import { circleDeletion } from "./account-data.js";

let done = false;
export function registerCircle() {
  if (done) return;
  done = true;
  circleHooks.invoicePaid.push(anniversaryOnPaid);
  circleHooks.invoicePaid.push(inv.onInvoicePaid);
  circleHooks.sessionCompleted.push(inv.onSessionCompleted);
  circleHooks.sessionExpired.push(inv.onSessionExpired);
  circleHooks.chargeRefunded.push(inv.onChargeRefunded);
  circleHooks.dispute.push(inv.onDispute);
  circleHooks.subscriptionEnded.push(inv.onSubscriptionEnded);
  invitations.describe = inv.describeInvitation;
  invitations.forCheckout = inv.invitationForCheckout;
  giftQueues.push(anniversaryQueue);
  deletionClosers.push(circleDeletion);
  memberSections.push(async (ctx, { userId }) => {
    const row = await ctx.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM concierge_messages c JOIN concierge_threads t ON t.id = c.thread_id
        WHERE t.user_id = ?1 AND c.author = 'maison' AND c.read_at IS NULL`
    ).bind(userId).first();
    return { key: "concierge_unread", value: row ? row.n : 0 };
  });
  memberSections.push(async (ctx, { userId }) => {
    const g = await ctx.env.DB.prepare(
      "SELECT status FROM anniversary_gifts WHERE user_id = ?1 AND status = 'awaiting_address' LIMIT 1"
    ).bind(userId).first();
    return g ? { key: "anniversary", value: { status: g.status } } : null;
  });
}
