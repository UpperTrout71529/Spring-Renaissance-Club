// Import of "Let us hold these for you" reservations into Held for you
// (spec §6.5, §9.2.7; S7).
//
// The storefront form (live theme, sections/sr-reserve-intercept.liquid,
// "SR — Hold, not checkout") posts a customer form whose only record of the
// pieces is customer tags: the base tag `reserve` plus one tag per cart line,
// slug("reserve-" + handle + "-" + variant title), e.g. reserve-the-gourd-bone.
// Quantities are not kept in Shopify. Handles contain hyphens too, so the
// handle is the longest prefix of the remainder that is an existing product.

import { productByHandle } from "./products.js";

const MAX_TAGS = 20;
const MAX_PARTS = 8;

export function reserveTagRemainders(tags) {
  return (tags || [])
    .filter((t) => typeof t === "string" && t.startsWith("reserve-"))
    .map((t) => t.slice("reserve-".length).toLowerCase())
    .filter((r) => /^[a-z0-9][a-z0-9-]*$/.test(r))
    .slice(0, MAX_TAGS);
}

// Inserts one open object_hold per resolved product (source "import"),
// skipping products already held. Returns the handles imported.
export async function importReserveHolds({ env, fetchImpl, newId, nowIso }, userId, tags) {
  const imported = [];
  for (const rest of reserveTagRemainders(tags)) {
    const parts = rest.split("-").filter(Boolean);
    let product = null;
    for (let k = Math.min(parts.length, MAX_PARTS); k >= 1 && !product; k--) {
      product = await productByHandle(env, fetchImpl, parts.slice(0, k).join("-"));
    }
    if (!product) continue;
    const res = await env.DB.prepare(
      `INSERT INTO holds (id, user_id, kind, product_handle, source, status, created_at)
       SELECT ?1, ?2, 'object_hold', ?3, 'import', 'open', ?4
        WHERE NOT EXISTS (SELECT 1 FROM holds WHERE user_id = ?2 AND kind = 'object_hold'
                            AND product_handle = ?3 AND status = 'open')`
    ).bind(newId(), userId, product.handle, nowIso).run();
    if (res.meta && res.meta.changes === 1) imported.push(product.handle);
  }
  return imported;
}
