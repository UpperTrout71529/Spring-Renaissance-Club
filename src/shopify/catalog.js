// Read-only snapshot of the Shopify catalog for the Circle economics
// (docs/tz-v2-circle.md §12.5): every variant with its price, product tags,
// gift-card flag, status and whether it is on the Online Store. Query only —
// nothing is written to Shopify. Validated against 2026-07 (read_products).

import { shopifyGraphql } from "./admin.js";
import { toCents } from "./orders.js";

const CATALOG_PAGE = `query CatalogPage($after: String) {
  products(first: 50, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id handle title status tags isGiftCard onlineStoreUrl
      variants(first: 100) { nodes { id title price } }
    }
  }
}`;

const MAX_PAGES = 40; // 2 000 products; Workers Free allows 50 subrequests per run

export async function syncCatalog(env, fetchImpl, nowIso, syncId) {
  const rows = [];
  let after = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await shopifyGraphql(env, fetchImpl, CATALOG_PAGE, { after });
    const conn = data.products;
    for (const p of conn.nodes || []) {
      for (const v of (p.variants && p.variants.nodes) || []) {
        const price = toCents(v.price);
        if (price === null) continue;
        rows.push([v.id, p.id, p.handle, p.title || null, v.title || null, price, JSON.stringify(p.tags || []),
          p.isGiftCard ? 1 : 0, p.status, p.onlineStoreUrl ? 1 : 0]);
      }
    }
    if (!conn.pageInfo || !conn.pageInfo.hasNextPage) { after = null; break; }
    after = conn.pageInfo.endCursor;
  }
  if (after) throw new Error("catalog larger than the sync limit");

  const upsert = env.DB.prepare(
    `INSERT INTO catalog_variants (variant_gid, product_gid, handle, product_title, variant_title, price_cents, product_tags,
       is_gift_card, status, published, synced_at, sync_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
     ON CONFLICT(variant_gid) DO UPDATE SET product_gid = ?2, handle = ?3, product_title = ?4, variant_title = ?5,
       price_cents = ?6, product_tags = ?7, is_gift_card = ?8, status = ?9, published = ?10, synced_at = ?11, sync_id = ?12`
  );
  await env.DB.batch([
    ...rows.map((r) => upsert.bind(...r, nowIso, syncId)),
    env.DB.prepare("DELETE FROM catalog_variants WHERE sync_id <> ?1").bind(syncId),
  ]);
  return { variants: rows.length };
}
