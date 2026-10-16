// The members' object guard (docs/tz-v2-circle.md §8.1, §8.3): the product
// must be ACTIVE, published to no sales channel (not even the Online Store),
// with inventory tracked and the policy DENY — so it cannot be put in a
// normal cart. Query validated against 2026-07 (read_products,
// read_publications, read_inventory). Fails closed.

import { shopifyGraphql } from "./admin.js";

const GUARD = `query CircleObjectGuard($id: ID!) {
  product(id: $id) {
    id status
    resourcePublicationsV2(first: 20, onlyPublished: true) { nodes { publication { id } } }
    variants(first: 10) { nodes { id price inventoryPolicy inventoryQuantity inventoryItem { tracked } } }
  }
}`;

export async function guardProduct(env, fetchImpl, productGid, variantGid) {
  const data = await shopifyGraphql(env, fetchImpl, GUARD, { id: productGid });
  const p = data.product;
  if (!p) return { ok: false, reasons: ["product_missing"] };
  const reasons = [];
  if (p.status !== "ACTIVE") reasons.push("not_active");
  const pubs = (p.resourcePublicationsV2 && p.resourcePublicationsV2.nodes) || [];
  if (pubs.length) reasons.push("published_to_a_sales_channel");
  const v = ((p.variants && p.variants.nodes) || []).find((x) => x.id === variantGid);
  if (!v) reasons.push("variant_missing");
  else {
    if (v.inventoryPolicy !== "DENY") reasons.push("inventory_policy_not_deny");
    if (!v.inventoryItem || !v.inventoryItem.tracked) reasons.push("inventory_not_tracked");
  }
  return { ok: reasons.length === 0, reasons };
}
