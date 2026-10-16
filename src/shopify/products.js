// Product data for Saved and Held for you (spec §8.3, §6.5). Queries
// validated against 2026-07 (read_products). Product data is the same for
// every visitor, so it is cached in KV per product for 10 minutes (§8.3).

import { shopifyGraphql } from "./admin.js";
import { toCents } from "./orders.js";
import { cached } from "../lib/kv-cache.js";

const PRODUCT_TTL_SECONDS = 10 * 60;

const FRAGMENT = `fragment SavedProduct on Product {
  id handle title status onlineStoreUrl
  featuredMedia { preview { image { url } } }
  priceRangeV2 { minVariantPrice { amount currencyCode } }
  variants(first: 20) { nodes { availableForSale } }
}`;

const BY_HANDLE = `${FRAGMENT}
query ProductByHandle($handle: String!) { productByIdentifier(identifier: { handle: $handle }) { ...SavedProduct } }`;

const BY_IDS = `${FRAGMENT}
query ProductsByIds($ids: [ID!]!) { nodes(ids: $ids) { ... on Product { ...SavedProduct } } }`;

export const HANDLE_RE = /^[a-z0-9][a-z0-9-]{0,254}$/;

// "No longer available" (§6.5) when the product is not active, not on the
// online store, or no variant can be bought.
export function shapeProduct(p) {
  if (!p || !p.id) return null;
  const variants = (p.variants && p.variants.nodes) || [];
  return {
    id: p.id,
    handle: p.handle,
    title: p.title,
    url: p.onlineStoreUrl || null,
    image_url: (p.featuredMedia && p.featuredMedia.preview && p.featuredMedia.preview.image && p.featuredMedia.preview.image.url) || null,
    price_cents: p.priceRangeV2 ? toCents(p.priceRangeV2.minVariantPrice.amount) : null,
    currency: p.priceRangeV2 ? p.priceRangeV2.minVariantPrice.currencyCode : "USD",
    available: p.status === "ACTIVE" && !!p.onlineStoreUrl && variants.some((v) => v.availableForSale),
  };
}

export async function productByHandle(env, fetchImpl, handle) {
  const p = await cached(env, `product_by_handle:v1:${handle}`, async () => {
    const data = await shopifyGraphql(env, fetchImpl, BY_HANDLE, { handle });
    return shapeProduct(data.productByIdentifier) || { missing: true };
  }, PRODUCT_TTL_SECONDS);
  return p.missing ? null : p;
}

// Returns a Map gid → shaped product (null for a deleted product).
export async function productsByIds(env, fetchImpl, ids) {
  const out = new Map();
  const missing = [];
  for (const id of ids) {
    try {
      const hit = await env.CLIENT_KV.get(`product:v1:${id}`, { type: "json" });
      if (hit) { out.set(id, hit.missing ? null : hit); continue; }
    } catch (e) {
      console.error("product cache read failed", e && e.name);
    }
    missing.push(id);
  }
  for (let i = 0; i < missing.length; i += 50) {
    const batch = missing.slice(i, i + 50);
    const data = await shopifyGraphql(env, fetchImpl, BY_IDS, { ids: batch });
    batch.forEach((id, j) => {
      const shaped = shapeProduct(data.nodes && data.nodes[j]);
      out.set(id, shaped);
      env.CLIENT_KV.put(`product:v1:${id}`, JSON.stringify(shaped || { missing: true }), { expirationTtl: PRODUCT_TTL_SECONDS })
        .catch((e) => console.error("product cache write failed", e && e.name));
    });
  }
  return out;
}
