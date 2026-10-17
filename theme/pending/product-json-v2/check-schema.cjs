// Every settings key in the edited sections must exist in that section's
// {% schema %} (ids copied from the draft theme's sections, read 17 Oct), and
// the few typed values must be valid for their setting type.
const fs = require('fs');
const raw = fs.readFileSync(__dirname + '/product.after.json', 'utf8');
const tpl = JSON.parse(raw.slice(raw.indexOf('*/') + 2));
const ids = (s) => s.split(/\s+/).filter(Boolean);
const schema = {
  'sr-patron-tiers': {
    settings: ids(`eyebrow heading standfirst standard_kicker standard_name standard_price standard_price_note standard_desc standard_product standard_url standard_cta standard_reassure
      patron_badge patron_kicker patron_name patron_price patron_price_after patron_price_note patron_desc patron_product patron_selling_plan patron_url patron_cta patron_reassure sold_out_label
      show_calc calc_label calc_monthly calc_symbol calc_max_months calc_eligible_months calc_month_single calc_month_plural calc_status_under calc_status_over
      bg_color text_color muted_color accent_color border_color feature_bg feature_text font_stack tracking max_width padding_top padding_bottom`),
    blocks: { standard_line: ids('label value note included'), patron_line: ids('label value note included') },
  },
  'sr-archival-roadmap': {
    settings: ids(`eyebrow heading standfirst footnote layout show_arrows card_width image_ratio prev_label next_label label_live label_reserved label_upcoming label_closed
      bg_color text_color muted_color accent_color border_color font_stack tracking max_width padding_top padding_bottom`),
    blocks: { milestone: ids('period title description status status_override members_note image link_label link_url') },
  },
  'sr-patron-faq': {
    settings: ids(`eyebrow heading standfirst contact_label contact_url layout single_open sticky_offset enable_schema_markup answer_size
      bg_color text_color muted_color accent_color border_color font_stack tracking max_width padding_top padding_bottom`),
    blocks: { question: ids('question answer pin open_by_default') },
  },
};
let bad = 0;
const fail = (m) => { bad++; console.log('BAD', m); };
for (const [key, sec] of Object.entries(tpl.sections)) {
  const sc = schema[sec.type];
  if (!sc) continue;
  for (const k of Object.keys(sec.settings)) if (!sc.settings.includes(k)) fail(`${key} setting ${k}`);
  for (const [bid, b] of Object.entries(sec.blocks)) {
    const allowed = sc.blocks[b.type];
    if (!allowed) { fail(`${key} block ${bid} type ${b.type}`); continue; }
    for (const k of Object.keys(b.settings)) if (!allowed.includes(k)) fail(`${key} block ${bid} setting ${k}`);
  }
  const order = sec.block_order || [];
  if (order.length !== Object.keys(sec.blocks).length || order.some((id) => !sec.blocks[id])) fail(`${key} block_order`);
  for (const v of [sec.settings.standfirst].concat(Object.values(sec.blocks).map((b) => b.settings.answer)).filter((x) => x !== undefined)) {
    if (!/^<p>[\s\S]*<\/p>$/.test(v)) fail(`${key} richtext not wrapped in <p>: ${v.slice(0, 40)}`);
  }
}
const t = tpl.sections.sr_patron_tiers_BiUh9r.settings;
if (!/^https:\/\//.test(t.patron_url)) fail('patron_url');
if (t.calc_eligible_months < 1 || t.calc_eligible_months > 6) fail('calc_eligible_months range 1–6');
if ('patron_product' in t) fail('patron_product should be unset');
if (tpl.sections.sr_patron_notes_hgdryy.disabled !== true) fail('notes not disabled');
const text = JSON.stringify(tpl);
for (const banned of ['25–50', 'two clicks', 'never expire', 'Patron Society', 'welcome gift', 'welcome vase', 'verified members', 'within a day', 'allocation']) {
  const hits = Object.entries(tpl.sections).filter(([k, s]) => k !== 'sr_patron_notes_hgdryy' && JSON.stringify(s).toLowerCase().includes(banned.toLowerCase()));
  if (hits.length) fail(`"${banned}" still in ${hits.map(([k]) => k).join(', ')}`);
}
console.log(bad ? `${bad} problems` : 'schema check: ok');
