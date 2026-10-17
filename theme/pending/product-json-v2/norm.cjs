// Tries to reproduce Shopify's stored form of a JSON template (size 16217,
// md5 9efff782d185ba8fbc44acd8fd837f82 for the current product.json).
const fs = require('fs');
const crypto = require('crypto');
const file = process.argv[2] || 'product.before.json';
const raw = fs.readFileSync(__dirname + '/' + file, 'utf8');
const i = raw.indexOf('*/');
const header = raw.slice(0, i + 2);
const obj = JSON.parse(raw.slice(i + 2));
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const min = JSON.stringify(obj);
const BS = String.fromCharCode(92);
const uesc = (s) => s.replace(/[\u007f-￿]/g, (ch) => BS + 'u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
const htmlesc = (s) => s.replace(/</g, BS + 'u003c').replace(/>/g, BS + 'u003e').replace(/&/g, BS + 'u0026');
const v = {
  min,
  u: uesc(min),
  slash: min.split('/').join(BS + '/'),
  u_slash: uesc(min).split('/').join(BS + '/'),
  html: htmlesc(min),
  u_html: htmlesc(uesc(min)),
  hdr_u: header + '\n' + uesc(min),
};
for (const [k, s] of Object.entries(v)) console.log(k, Buffer.byteLength(s), md5(s));
