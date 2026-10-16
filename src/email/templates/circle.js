// Circle emails (spec v1.1 §11, docs/tz-v2-circle.md §16). Calm and short;
// no exclamation marks, no capitals for emphasis. Every membership email links
// to online cancellation. Lines about terms, renewal and credits after
// cancellation are drafts pending legal review (P0.7).
//
// Each builder returns { subject, heading, paragraphs, button } for
// renderEmail (layout.js). Amounts arrive in cents, dates as YYYY-MM-DD.

const usd = (cents) => (cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`);
const credits = (cents) => {
  const n = Math.floor(cents / 100);
  return `${n} ${n === 1 ? "credit" : "credits"}`;
};
export const longDate = (isoDate) => (isoDate
  ? new Date(`${String(isoDate).slice(0, 10)}T00:00:00.000Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })
  : "");

const cancelLine = (portal) => `You can cancel online at any time: ${portal}/account/membership`;

export const CIRCLE_TEMPLATES = {
  welcome: ({ portal, invoiceUrl, monthlyCents, nextChargeOn }) => ({
    subject: "Welcome to the Circle",
    heading: "Welcome to the Circle",
    paragraphs: [
      "Your membership has begun.",
      `You'll be charged ${usd(monthlyCents)} plus applicable tax each month, next on ${longDate(nextChargeOn)}, until you cancel. Each paid month becomes 20 credits to spend in the house.`,
      ...(invoiceUrl ? [`Your receipt: ${invoiceUrl}`] : []),
      cancelLine(portal),
      "Your sealed piece is waiting to be chosen.",
    ],
    button: { label: "Choose your sealed piece", url: `${portal}/circle/welcome` },
  }),

  welcome_back: ({ portal, invoiceUrl, monthlyCents, nextChargeOn }) => ({
    subject: "Welcome back to the Circle",
    heading: "Welcome back to the Circle",
    paragraphs: [
      "Your membership has begun again, and 20 credits are in your treasury.",
      `You'll be charged ${usd(monthlyCents)} plus applicable tax each month, next on ${longDate(nextChargeOn)}, until you cancel.`,
      ...(invoiceUrl ? [`Your receipt: ${invoiceUrl}`] : []),
      cancelLine(portal),
    ],
    button: { label: "Open your Circle", url: `${portal}/circle` },
  }),

  credits_added: ({ portal, invoiceUrl, amountCents, balanceCents }) => ({
    subject: `${credits(amountCents)} added`,
    heading: `${credits(amountCents)} added`,
    paragraphs: [
      `Your monthly credits are in your treasury. Your balance is now ${credits(balanceCents)}.`,
      ...(invoiceUrl ? [`Your receipt: ${invoiceUrl}`] : []),
      cancelLine(portal),
    ],
    button: { label: "Use credits", url: `${portal}/circle/credits` },
  }),

  payment_failed: ({ portal, amountCents }) => ({
    subject: "We couldn't process your payment",
    heading: "We couldn't process your payment",
    paragraphs: [
      `Your monthly payment of ${usd(amountCents)} didn't go through. We'll try again over the next few days.`,
      "Credits you already have are still yours to use. Update your card to keep your member price.",
    ],
    button: { label: "Update card", url: `${portal}/account/membership` },
  }),

  payment_action_required: ({ hostedInvoiceUrl, amountCents }) => ({
    subject: "We couldn't process your payment",
    heading: "Your bank asked for a confirmation",
    paragraphs: [
      `Your monthly payment of ${usd(amountCents)} needs a quick confirmation from you before it can go through.`,
    ],
    button: { label: "Confirm payment", url: hostedInvoiceUrl },
  }),

  membership_canceled: ({ portal, endsOn, graceUntil, balanceCents }) => ({
    subject: `Your membership will end on ${longDate(endsOn)}`,
    heading: `Your membership will end on ${longDate(endsOn)}`,
    paragraphs: [
      `There will be no further charges. Your member price ends on ${longDate(endsOn)}.`,
      `Your ${credits(balanceCents)} stay usable until ${longDate(graceUntil)}, then expire.`,
      `Changed your mind? You can undo this until ${longDate(endsOn)}.`,
    ],
    button: { label: "Keep my membership", url: `${portal}/circle` },
  }),

  membership_ended_payment: ({ portal, graceUntil, balanceCents }) => ({
    subject: "Your membership has ended",
    heading: "Your membership has ended",
    paragraphs: [
      "We couldn't collect your payment after several tries, so your membership has ended.",
      `Your ${credits(balanceCents)} stay usable until ${longDate(graceUntil)}.`,
      "You can rejoin for $20 a month whenever you like.",
    ],
    button: { label: "Open your Circle", url: `${portal}/circle` },
  }),

  renewal_reminder: ({ portal, chargeOn, amountCents }) => ({
    subject: `Your membership renews on ${longDate(chargeOn)}`,
    heading: `Your membership renews on ${longDate(chargeOn)}`,
    paragraphs: [
      `We'll charge ${usd(amountCents)} on ${longDate(chargeOn)}, and 20 credits will be added to your treasury.`,
      cancelLine(portal),
    ],
    button: { label: "Membership & billing", url: `${portal}/account/membership` },
  }),

  credits_expiring: ({ portal, balanceCents, expiresOn }) => ({
    subject: `Your ${credits(balanceCents)} expire on ${longDate(expiresOn)}`,
    heading: `Your ${credits(balanceCents)} expire on ${longDate(expiresOn)}`,
    paragraphs: ["Your membership has ended. Credits you haven't used expire on that date."],
    button: { label: "Use credits", url: `${portal}/circle/credits` },
  }),

  redemption_code: ({ portal, amountCents, code }) => ({
    subject: "Your credits are ready to use",
    heading: "Your credits are ready to use",
    paragraphs: [
      `Here is your single-use gift card for ${usd(amountCents)}: ${code}`,
      "Enter it at checkout. Any balance left stays on the card.",
    ],
    button: { label: "Shop now", url: "https://springrenaissance.store" },
  }),

  welcome_piece_reminder: ({ portal }) => ({
    subject: "Your sealed piece is waiting",
    heading: "Your sealed piece is waiting",
    paragraphs: ["Choose your sealed piece whenever you're ready."],
    button: { label: "Choose your sealed piece", url: `${portal}/circle/welcome` },
  }),

  object_invoice: ({ invoiceUrl, reservedUntil }) => ({
    subject: "Your members' object is reserved",
    heading: "Your members' object is reserved",
    paragraphs: [`It's reserved for you until ${reservedUntil}.`],
    button: { label: "Pay now", url: invoiceUrl },
  }),

  anniversary: ({ portal }) => ({
    subject: "A year in the Circle",
    heading: "A year in the Circle",
    paragraphs: ["To mark your anniversary, we'd like to send you something. Please confirm where it should go."],
    button: { label: "Confirm the address", url: `${portal}/circle/anniversary` },
  }),

  referral_credited: ({ portal, rewardCents }) => ({
    subject: `${credits(rewardCents)} from your invitation`,
    heading: `${credits(rewardCents)} from your invitation`,
    paragraphs: ["The friend you invited has paid their second month. Thank you for bringing them to the Circle."],
    button: { label: "Open your Circle", url: `${portal}/circle` },
  }),

  capsule_open: ({ portal, season, priceCents, closesOn }) => ({
    subject: `The ${season} capsule is open`,
    heading: `The ${season} capsule is open`,
    paragraphs: [`It is ${credits(priceCents)}, reserved for you until ${longDate(closesOn)}.`],
    button: { label: "See the capsule", url: `${portal}/circle/capsules` },
  }),

  concierge_reply: ({ portal }) => ({
    subject: "You have a reply from the Maison",
    heading: "You have a reply from the Maison",
    paragraphs: ["Read it in your Circle."],
    button: { label: "Open the concierge", url: `${portal}/circle/concierge` },
  }),

  circle_open: ({ portal }) => ({
    subject: "The Circle is open",
    heading: "The Circle is open",
    paragraphs: ["You asked us to tell you when the Circle opens. It is open now."],
    button: { label: "About the Circle", url: `${portal}/circle` },
  }),

  // To Felix (ADMIN_NOTIFY_EMAIL), never to a member.
  admin_signal: ({ title, lines }) => ({
    subject: `Circle: ${title}`,
    heading: title,
    paragraphs: lines,
    button: null,
  }),
};
