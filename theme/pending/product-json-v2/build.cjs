// Builds product.after.json from product.before.json + edits.cjs, prints the
// expected Shopify checksum (minified, "/" escaped) and writes review.md.
const fs = require('fs');
const crypto = require('crypto');
const { edits, newBlocks, apply } = require('./edits.cjs');
const dir = __dirname;
const raw = fs.readFileSync(dir + '/product.before.json', 'utf8');
const i = raw.indexOf('*/');
const header = raw.slice(0, i + 2);
const before = JSON.parse(raw.slice(i + 2));
const after = apply(JSON.parse(JSON.stringify(before)));
const out = header + '\n' + JSON.stringify(after, null, 2) + '\n';
fs.writeFileSync(dir + '/product.after.json', out);
const stored = (o) => JSON.stringify(o).split('/').join(String.fromCharCode(92) + '/');
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
console.log('before stored md5', md5(stored(before)), Buffer.byteLength(stored(before)));
console.log('after  stored md5', md5(stored(after)), Buffer.byteLength(stored(after)));

// Review table, grouped by section.
const names = { sr_patron_tiers_BiUh9r: 'SR — Patron Tiers', sr_archival_roadmap_i9zijy: 'SR — Archival Roadmap', sr_patron_faq_prbhgK: 'SR — Patron FAQ', sr_patron_notes_hgdryy: 'SR — Patron Notes' };
const show = (v, isTo) => (v === undefined ? (isTo ? '(убрать)' : '—') : v === '' ? '(пусто)' : String(v).replace(/\|/g, '\\|'));
let md = '';
for (const sec of Object.keys(names)) {
  md += `\n## ${names[sec]}\n\n| Поле | Было | Стало | Почему |\n|---|---|---|---|\n`;
  for (const e of edits.filter((x) => x.sec === sec)) {
    const field = e.path[0] === 'blocks' ? `${e.path[1]} · ${e.path[3]}` : e.path.join('.');
    md += `| ${field} | ${show(e.from)} | ${show(e.to, true)} | ${e.why || ''} |\n`;
  }
  for (const nb of newBlocks.filter((x) => x.sec === sec)) {
    const st = nb.block.settings;
    md += `| ${nb.id} (новая строка) | — | ${show(st.label)} · ${show(st.value)}${st.note ? ' · ' + show(st.note) : ''} | V2 benefit (§16) |\n`;
  }
}
fs.writeFileSync(dir + '/review.md', md);
console.log('edits', edits.length, 'new blocks', newBlocks.length);
