// Account emails (spec §11): email_change_confirm (to the new address), the
// notice to the old address, account_deleted, and the internal notice to
// Felix when an account is deleted.

import { renderEmail } from "./layout.js";

const CONCIERGE = "concierge@springrenaissance.store";

export function emailChangeConfirmEmail({ to, link, portalUrl }) {
  return renderEmail({
    to,
    subject: "Confirm your new email",
    heading: "Confirm your new email",
    paragraphs: [
      "Please confirm that this is the address you would like to use for your Spring Renaissance account.",
      "This link works once, for one hour. If you didn't ask for this, you can ignore this email — nothing changes.",
    ],
    button: { label: "Confirm email", url: link },
    portalUrl,
  });
}

export function emailChangeNoticeEmail({ to, newEmail, portalUrl }) {
  return renderEmail({
    to,
    subject: "A change to your account email",
    heading: "A change to your account email",
    paragraphs: [
      `We received a request to change your account email to ${newEmail}. It changes only once that address is confirmed.`,
      `If this wasn't you, write to us at ${CONCIERGE} and nothing will change.`,
    ],
    portalUrl,
  });
}

export function accountDeletedEmail({ to, portalUrl }) {
  return renderEmail({
    to,
    subject: "Your account has been deleted",
    heading: "Your account has been deleted",
    paragraphs: [
      "Your Spring Renaissance account has been deleted. Your saved pieces, holds, sign-in methods and sessions have been erased.",
      "Records of orders stay with us, as tax law requires.",
      `If you have a question, write to us at ${CONCIERGE}.`,
    ],
    portalUrl,
  });
}

// Internal (§11: notices to Felix go to ADMIN_NOTIFY_EMAIL). No customer
// email or name here — only the ids needed to find the record.
export function adminAccountDeletedEmail({ to, userId, shopifyCustomerId, portalUrl }) {
  return renderEmail({
    to,
    subject: "Account deleted — Shopify data to review",
    heading: "An account was deleted",
    paragraphs: [
      `Portal user ${userId} deleted their account.`,
      shopifyCustomerId
        ? `Shopify customer: ${shopifyCustomerId}. Our tags were removed. If the customer's data should be erased in Shopify, request it from the Shopify admin (orders stay on record).`
        : "No Shopify customer was linked.",
    ],
    portalUrl,
  });
}
