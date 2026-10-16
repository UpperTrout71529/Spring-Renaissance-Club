// The Circle FAQ (spec §6.6). Kept out of en.ts on purpose: it is only
// imported behind VITE_CIRCLE_FAQ, so a production build without the flag
// does not even ship these strings.

export const CIRCLE_FAQ_TITLE = "Questions";

// PENDING LEGAL REVIEW. Answers restate the spec's decisions (ТЗ v1.1
// §14.1, §16.2, §9.2.5); shown only with VITE_CIRCLE_FAQ=1 until the
// lawyer and Felix approve the terms (P0.7) — see docs/v1-decisions.md.
export const CIRCLE_FAQ = [
  { q: "What are credits?", a: "Each month, $20 of your membership becomes 20 credits. One credit is $1 to spend on anything in the house. Credits are store credit for Spring Renaissance only." },
  { q: "What does Skip mean?", a: "Skip lets you pass on a season's capsule. Your membership and monthly credits continue as usual, and nothing is refunded." },
  { q: "How do I cancel?", a: "Online, in your account, at any time. Cancelling takes effect at the end of the month you have paid for." },
  { q: "What happens to my credits if I cancel?", a: "They stay usable for 30 days after the end of your last paid month, then they expire." },
  { q: "What does the 25% apply to?", a: "Our collections. It does not apply to Small Pleasures, gift cards or seasonal capsules." },
];
