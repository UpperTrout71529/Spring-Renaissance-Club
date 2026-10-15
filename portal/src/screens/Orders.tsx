// /orders and /orders/:id (spec §6.4; S5).

import { useEffect, useState } from "preact/hooks";
import { ArrowLeft } from "lucide-preact";
import { api, ApiError } from "../api";
import { copy } from "../copy/en";
import { formatDate, formatMoney, sized } from "../format";
import { STOREFRONT_COLLECTIONS } from "../router";
import { Link } from "../ui/Link";
import { EmptyState, ErrorState, Skeleton } from "../ui/states";
import { SectionHeading } from "./Placeholder";
import "./orders.css";

type OrderSummary = {
  id: string; name: string; created_at: string; total_cents: number; currency: string;
  status: string; is_preorder: boolean; thumb_url: string | null; items_count: number;
};

type Fulfillment = {
  status: string; carrier: string | null; tracking_number: string | null; tracking_url: string | null;
  shipped_at: string | null; delivered_at: string | null; estimated_delivery_at: string | null;
};

type OrderDetailData = OrderSummary & {
  line_items: { title: string; variant_title: string | null; qty: number; price_cents: number | null; image_url: string | null; is_preorder: boolean }[];
  fulfillments: Fulfillment[];
  shipping_city: string | null;
};

const statusLabel = (s: string) => copy.orders.status[s] ?? copy.orders.status.processing;

function StatusTag({ status }: { status: string }) {
  return <span class={`order-status order-status-${status}`}>{statusLabel(status)}</span>;
}

export function Orders() {
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "more" | { error: string }>("loading");

  async function load(cursor: string | null) {
    setState(cursor ? "more" : "loading");
    try {
      const page = await api<{ orders: OrderSummary[]; next_cursor: string | null }>(
        `/api/orders${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      setOrders((prev) => (cursor ? [...prev, ...page.orders] : page.orders));
      setNext(page.next_cursor);
      setState("ready");
    } catch (e) {
      setState({ error: e instanceof ApiError ? e.message : copy.errors.generic });
    }
  }

  useEffect(() => { void load(null); }, []);

  return (
    <>
      <SectionHeading eyebrow={copy.eyebrows.orders} title={copy.nav.orders} />
      {state === "loading" && <Skeleton lines={4} label={copy.orders.loading} />}
      {typeof state === "object" && <ErrorState body={state.error} onRetry={() => load(orders.length ? next : null)} />}
      {state !== "loading" && typeof state !== "object" && orders.length === 0 && (
        <EmptyState
          title={copy.orders.emptyTitle}
          body={copy.orders.emptyBody}
          action={<a class="button button-secondary" href={STOREFRONT_COLLECTIONS}>{copy.orders.emptyAction}</a>}
        />
      )}
      {orders.length > 0 && (
        <ul class="order-list appear">
          {orders.map((o) => (
            <li key={o.id}>
              <Link href={`/orders/${o.id}`} class="order-card">
                <span class="order-thumb" aria-hidden="true">
                  {o.thumb_url && <img src={sized(o.thumb_url, 160)} alt="" loading="lazy" width={64} height={64} />}
                  {o.items_count > 1 && <span class="order-more">{copy.orders.moreItems(o.items_count - 1)}</span>}
                </span>
                <span class="order-meta">
                  <span class="order-name">{o.name}</span>
                  <span class="small">{formatDate(o.created_at)}{" · "}{formatMoney(o.total_cents, o.currency)}</span>
                  <StatusTag status={o.status} />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {next && typeof state !== "object" && (
        <button type="button" class="button button-secondary order-load-more" disabled={state === "more"} onClick={() => load(next)}>
          {copy.orders.loadMore}
        </button>
      )}
    </>
  );
}

export function OrderDetail({ id }: { id: string }) {
  const [state, setState] = useState<{ kind: "loading" } | { kind: "notFound" } | { kind: "error"; message: string } | { kind: "ready"; order: OrderDetailData }>({ kind: "loading" });

  async function load() {
    setState({ kind: "loading" });
    try {
      const res = await api<{ order: OrderDetailData }>(`/api/orders/${encodeURIComponent(id)}`);
      setState({ kind: "ready", order: res.order });
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setState({ kind: "notFound" });
      else setState({ kind: "error", message: e instanceof ApiError ? e.message : copy.errors.generic });
    }
  }

  useEffect(() => { void load(); }, [id]);

  const back = (
    <Link href="/orders" class="back-link">
      <ArrowLeft size={20} strokeWidth={1.5} aria-hidden="true" />
      <span class="visually-hidden">{copy.orders.backLabel}</span>
      <span aria-hidden="true">{copy.orders.back}</span>
    </Link>
  );

  if (state.kind === "loading") return <>{back}<Skeleton lines={6} label={copy.orders.loading} /></>;
  if (state.kind === "error") return <>{back}<ErrorState body={state.message} onRetry={load} /></>;
  if (state.kind === "notFound") return <>{back}<EmptyState title={copy.orders.notFoundTitle} body={copy.orders.notFoundBody} /></>;

  const o = state.order;
  const mail = `mailto:concierge@springrenaissance.store?subject=${encodeURIComponent(`Order ${o.name}`)}`;
  return (
    <>
      {back}
      <SectionHeading eyebrow={copy.eyebrows.orders} title={o.name} />
      <p class="order-placed small">{copy.orders.placed(formatDate(o.created_at))}</p>
      <StatusTag status={o.status} />

      <section class="order-section" aria-labelledby="items-title">
        <h2 id="items-title">{copy.orders.items}</h2>
        <ul class="line-items">
          {o.line_items.map((l, i) => (
            <li key={i} class="line-item">
              <span class="line-thumb">{l.image_url && <img src={sized(l.image_url, 160)} alt={l.title} loading="lazy" width={64} height={64} />}</span>
              <span class="line-meta">
                <span>{l.title}</span>
                {l.variant_title && <span class="small">{l.variant_title}</span>}
                <span class="small">{copy.orders.qty(l.qty)}</span>
                {l.is_preorder && <span class="small">{copy.orders.preorderLabel}{" · "}{copy.orders.preorderNote}</span>}
              </span>
              {l.price_cents !== null && <span class="line-price">{formatMoney(l.price_cents * l.qty, o.currency)}</span>}
            </li>
          ))}
        </ul>
        <p class="order-total"><span>{copy.orders.total}</span><span>{formatMoney(o.total_cents, o.currency)}</span></p>
        {o.shipping_city && <p class="small">{copy.orders.shippingTo(o.shipping_city)}</p>}
      </section>

      {o.fulfillments.length > 0 && (
        <section class="order-section" aria-labelledby="shipments-title">
          <h2 id="shipments-title">{copy.orders.shipments}</h2>
          <ul class="shipments">
            {o.fulfillments.map((f, i) => (
              <li key={i} class="shipment">
                {f.carrier && <span>{f.carrier}</span>}
                {f.tracking_number && <span class="small">{copy.orders.trackingNumber(f.tracking_number)}</span>}
                <span class="small">
                  {f.delivered_at
                    ? copy.orders.deliveredOn(formatDate(f.delivered_at))
                    : f.shipped_at ? copy.orders.shippedOn(formatDate(f.shipped_at)) : statusLabel("shipped")}
                </span>
                {/* Only a date Shopify actually has (§6.4: never invent one). */}
                {!f.delivered_at && f.estimated_delivery_at && (
                  <span class="small">{copy.orders.arrives(formatDate(f.estimated_delivery_at))}</span>
                )}
                {f.tracking_url && (
                  <a class="button button-secondary" href={f.tracking_url} target="_blank" rel="noopener noreferrer">
                    {f.carrier ? copy.orders.trackWith(f.carrier) : copy.orders.trackParcel}
                  </a>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {o.is_preorder && o.fulfillments.length === 0 && <p class="notice">{copy.orders.preorderNote}</p>}

      <p class="order-help"><a href={mail}>{copy.orders.help}</a></p>
    </>
  );
}
