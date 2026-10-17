// Draft theme 189482795229, templates/product.json — V2 copy (for Felix's review).
// One source for the review table and for the upload after his "yes".
// Each edit: section key, path inside it, the value that must be there now, the new value.
const T = 'sr_patron_tiers_BiUh9r';
const R = 'sr_archival_roadmap_i9zijy';
const F = 'sr_patron_faq_prbhgK';
const N = 'sr_patron_notes_hgdryy';

const s = (sec, key, from, to, why = '') => ({ sec, path: ['settings', key], from, to, why });
const b = (sec, block, key, from, to, why = '') => ({ sec, path: ['blocks', block, 'settings', key], from, to, why });

exports.edits = [
  // ---- SR — Patron Tiers
  s(T, 'standfirst', '<p>One buys an object. The other opens an account with the atelier, and returns the price of that object to you in credit before the first quarter closes.</p>',
    '<p>One buys a single piece. The other is the Renaissance Circle: $20 a month becomes 20 credits to spend on anything in the house, plus 25% off eligible pieces.</p>', 'V2 value line (§16)'),
  s(T, 'standard_price', '$85', '$48', 'Le Vase Livre is $48 in Shopify today'),
  s(T, 'standard_desc', 'Le Vase Livre, first edition, delivered once. Nothing accrues and nothing is held for you.',
    'Le Vase Livre, first edition, delivered once. No credits and no Circle price.', 'no "held for you" in V2'),
  s(T, 'patron_kicker', 'The Patron Society', 'The Renaissance Circle'),
  s(T, 'patron_name', 'Patron membership', 'Circle membership'),
  s(T, 'patron_price_after', 'today, then $20 monthly', 'to join, then $20 a month'),
  s(T, 'patron_price_note', 'Cancel any month — accrued credit stays yours', 'Cancel online at any time', 'credits expire 30 days after the last paid month'),
  s(T, 'patron_desc', 'The welcome vase arrives immediately. Every month after adds $20 of credit toward the seasonal capsule and holds your allocation on limited releases.',
    'Your first month is included. Each paid month\'s $20 becomes 20 credits, and after you join you choose your first piece from a small sealed selection.', 'no named welcome object, no allocation'),
  s(T, 'patron_product', 'patron-membership', undefined, 'joining is in the portal (Stripe), not a Shopify product'),
  s(T, 'patron_url', '', 'https://club.springrenaissance.store/circle/join', 'signed-out visitors go to sign-in and come back to the join page'),
  s(T, 'patron_cta', 'Claim membership — $50 today', 'Join the Circle'),
  s(T, 'patron_reassure', 'No lock-in. Pause or cancel from your account in two clicks.',
    '$50 to join, which includes your first month. Then $20 a month until you cancel. Cancel online at any time.', '§16 terms line, verbatim; no pause in V2'),
  s(T, 'calc_label', 'Credit accrued', 'Credits'),
  s(T, 'calc_symbol', '$', '', 'credits, not dollars'),
  s(T, 'calc_eligible_months', 2, 1, 'no two-month capsule rule in V2; the status line is then always the one below'),
  s(T, 'calc_month_single', 'month of membership', 'paid month'),
  s(T, 'calc_month_plural', 'months of membership', 'paid months'),
  s(T, 'calc_status_under', 'One more month and the seasonal capsule is yours this quarter.', 'One credit is $1 to spend on anything in the house.'),
  s(T, 'calc_status_over', 'Seasonal capsule secured for this quarter.', 'One credit is $1 to spend on anything in the house.'),
  b(T, 'standard_line_3HwxG6', 'value', '$85', '$48', 'Shopify price'),
  b(T, 'standard_line_mmr7bC', 'label', 'Monthly credit', 'Monthly credits'),
  b(T, 'standard_line_aLmm6j', 'label', 'Member pricing on future releases', 'Circle price'),
  b(T, 'standard_line_88GK6c', 'label', 'Allocation held on limited runs', 'Early access'),
  b(T, 'patron_line_JKfKPy', 'label', 'Le Vase Livre, numbered edition', 'Your sealed piece', 'objects are never named'),
  b(T, 'patron_line_JKfKPy', 'value', '$85 value', 'Included'),
  b(T, 'patron_line_JKfKPy', 'note', 'Numbered 001–300, hardcover packaging, digital certificate of authenticity.', 'Chosen from a small selection after you join.'),
  b(T, 'patron_line_88VePy', 'label', 'Credit toward the seasonal capsule', 'Credits'),
  b(T, 'patron_line_88VePy', 'value', '$20 / month', '20 a month'),
  b(T, 'patron_line_88VePy', 'note', 'Accrues from the first month and carries forward in full.', 'One credit is $1 to spend on anything in the house.'),
  b(T, 'patron_line_Ayrxfn', 'label', 'Member pricing on every future release', 'Circle price'),
  b(T, 'patron_line_Ayrxfn', 'value', '25–50% off', '25% off'),
  b(T, 'patron_line_Ayrxfn', 'note', '', 'On eligible pieces, applied at checkout while your membership is active.', 'how (email or code) depends on the spike — not promised'),
  b(T, 'patron_line_MyaAf4', 'label', 'Allocation held on limited editions', 'Early access'),
  b(T, 'patron_line_MyaAf4', 'value', 'Automatic', 'Pre-order'),
  b(T, 'patron_line_MyaAf4', 'note', 'Your piece is reserved before the public release opens.', 'New pieces before their public release.'),
  b(T, 'patron_line_LEFnYr', 'label', 'Living Library quarterly edition', 'Seasonal capsules', 'the guide is free for everyone'),
  b(T, 'patron_line_LEFnYr', 'value', 'Included', 'Members only'),
  b(T, 'patron_line_LEFnYr', 'note', '', 'Skip any season.'),
  b(T, 'patron_line_bDyXF8', 'label', 'Concierge styling correspondence', 'The concierge'),
  b(T, 'patron_line_bDyXF8', 'note', '', 'Write to us, and a person answers.'),

  // ---- SR — Archival Roadmap
  s(R, 'standfirst', '<p>Each run is cast once and retired. Members are allocated before a release opens; everyone else meets it already closed.</p>',
    '<p>Each run is cast once and retired. When a release has early access, Circle members can pre-order it before the public release.</p>', 'no allocations in V2'),
  s(R, 'footnote', 'Dates are indicative. Members are notified by correspondence two weeks before any release opens.', 'Dates are indicative.', 'no two-week notice in V2'),
  s(R, 'label_reserved', 'Reserved for members', 'Members\' early access', 'no "reserved" in V2; no release uses this status now'),
  b(R, 'milestone_CmqgmY', 'members_note', 'Included with membership as the welcome gift.', '', 'not a welcome piece'),
  b(R, 'milestone_7fjwmn', 'status', 'reserved', 'live', 'Felix 17 Oct: on sale now, no early access'),
  b(R, 'milestone_7fjwmn', 'members_note', 'Members allocated first. Public release only if units remain.', ''),
  b(R, 'milestone_QQH8b9', 'members_note', 'Member pricing applies from the first hour.', '', 'Circle price only on eligible pieces'),
  b(R, 'milestone_Tj4fyV', 'members_note', 'Private allocation. Waitlist opens to members only.', ''),
  b(R, 'milestone_M4P3r4', 'members_note', 'Forty pieces. Members hold every one of them at release.', ''),

  // ---- SR — Patron FAQ
  s(F, 'standfirst', '<p>Everything about the membership in plain terms. If something is still unclear, the concierge answers within a day.</p>',
    '<p>Everything about the membership in plain terms. If something is still unclear, write to the concierge — a person answers.</p>', '"within a day" is not a V2 promise'),
  b(F, 'question_EPjpeL', 'question', 'How does the $20 monthly membership work?', 'How does the membership work?'),
  b(F, 'question_EPjpeL', 'answer', '<p>Each month adds $20 of credit to your account. The credit is yours to spend on any release, and it accumulates toward the seasonal capsule delivered at the close of each quarter.</p>',
    '<p>$50 to join, which includes your first month. Then $20 a month until you cancel. Each paid month\'s $20 becomes 20 credits; one credit is $1 to spend on anything in the house. The joining fee does not add credits.</p>'),
  b(F, 'question_fDQnUH', 'question', 'Can I pause or cancel at any time?', 'How do I cancel?'),
  b(F, 'question_fDQnUH', 'answer', '<p>Yes, from your account, in two clicks. There is no minimum term, no cancellation fee and no call to make. Pausing keeps your accrued credit intact.</p>',
    '<p>Online, in your account, at any time. Cancelling takes effect at the end of the month you have paid for.</p>', 'no pause in V2'),
  b(F, 'question_fDQnUH', 'pin', 'No lock-in', 'Cancel online'),
  b(F, 'question_PWimBx', 'question', 'Does my monthly credit ever expire?', 'What happens to my credits if I cancel?'),
  b(F, 'question_PWimBx', 'answer', '<p>No. Credit carries forward in full for as long as your membership is active, and it applies to any release at member pricing.</p>',
    '<p>They stay usable for 30 days after the end of your last paid month, then they expire.</p>'),
  b(F, 'question_PWimBx', 'pin', 'Carries forward in full', 'Usable 30 days after'),
  b(F, 'question_7y6h9f', 'question', 'When does my welcome vase arrive?', 'What is the sealed piece?'),
  b(F, 'question_7y6h9f', 'answer', '<p>Le Vase Livre is dispatched within 24 to 48 hours of enrolment, individually numbered between 001 and 300, in hardcover packaging with a digital certificate of authenticity.</p>',
    '<p>After you join, you choose your first piece from a small sealed selection — revealed only after joining. It is included in the joining fee.</p>'),
  b(F, 'question_cqgW4T', 'question', 'What do I need to receive the seasonal capsule?', 'What are seasonal capsules?'),
  b(F, 'question_cqgW4T', 'answer', '<p>An active membership for at least two months before the quarter closes. Enrol later than that and the capsule ships to the members who held their place through the quarter; yours begins accruing for the next one.</p>',
    '<p>Seasonal capsules are reserved for members. Skip lets you pass on a season\'s capsule; your membership and monthly credits continue as usual, and nothing is refunded.</p>'),
  b(F, 'question_cqgW4T', 'pin', 'Two months before quarter end', ''),
  b(F, 'question_9UdLzM', 'question', 'How does member pricing apply to future releases?', 'What is the Circle price?'),
  b(F, 'question_9UdLzM', 'answer', '<p>Member rates of 25 to 50 percent are applied automatically at checkout while your membership is active. Nothing to enter and no code to remember.</p>',
    '<p>25% off eligible pieces, applied at checkout while your membership is active. It does not apply to Small Pleasures, gift cards or seasonal capsules.</p>', 'how (email or code) depends on the spike — not promised'),
  b(F, 'question_9mNdcy', 'question', 'What happens to my allocation on limited editions?', 'What is early access?'),
  b(F, 'question_9mNdcy', 'answer', '<p>Your piece is reserved before the public release opens and held for a set window. You are notified by correspondence; if you pass, the allocation returns to the run.</p>',
    '<p>When a new piece has early access, members can pre-order it from their account before its public release. One per member.</p>'),

  // ---- SR — Patron Notes: off, kept
  { sec: N, path: ['disabled'], from: undefined, to: true, why: 'fabricated reviews — section off, not deleted' },
];

// New lines in the membership column (after the concierge line).
exports.newBlocks = [
  { sec: T, id: 'patron_line_object', after: 'patron_line_bDyXF8',
    block: { type: 'patron_line', settings: { label: 'The members\' object', value: 'Once a year', note: 'A piece offered only to members.', included: true } } },
  { sec: T, id: 'patron_line_anniversary', after: 'patron_line_object',
    block: { type: 'patron_line', settings: { label: 'An anniversary gift', value: 'Each year', note: '', included: true } } },
];

// Applies the edits to the parsed template; throws if any current value differs
// from what was reviewed (someone changed the file in the meantime).
exports.apply = (tpl) => {
  for (const e of exports.edits) {
    let node = tpl.sections[e.sec];
    if (!node) throw new Error(`missing section ${e.sec}`);
    const path = e.path.slice();
    const last = path.pop();
    for (const k of path) {
      node = node[k];
      if (!node) throw new Error(`missing ${e.sec}.${e.path.join('.')}`);
    }
    if (node[last] !== e.from) throw new Error(`${e.sec}.${e.path.join('.')} is ${JSON.stringify(node[last])}, expected ${JSON.stringify(e.from)}`);
    // to: undefined removes the key (an unset resource picker, not "").
    if (e.to === undefined) delete node[last];
    else node[last] = e.to;
  }
  // Shopify writes a section's "disabled" right after "block_order".
  const notes = tpl.sections[N];
  const { type, blocks, block_order, disabled, ...rest } = notes;
  tpl.sections[N] = { type, blocks, block_order, disabled, ...rest };
  for (const nb of exports.newBlocks) {
    const sec = tpl.sections[nb.sec];
    if (sec.blocks[nb.id]) throw new Error(`block ${nb.id} exists`);
    sec.blocks[nb.id] = nb.block;
    const i = sec.block_order.indexOf(nb.after);
    if (i < 0) throw new Error(`no ${nb.after}`);
    sec.block_order.splice(i + 1, 0, nb.id);
  }
  return tpl;
};
