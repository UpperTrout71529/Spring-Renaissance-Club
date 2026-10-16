// Home — Club (spec §6.3; S6): usefulness first. Greeting, the latest active
// order, the gift card balance, the "Make it yours" card (§6.10). Saved and
// Held for you arrive with S7, the Circle teaser with S8.

import { useEffect, useState } from "preact/hooks";
import { Check, Circle } from "lucide-preact";
import { api, type Me, type User } from "../api";
import { copy } from "../copy/en";
import { formatDate, formatMoney, sized } from "../format";
import { dayPart } from "../greeting";
import { deviceAuthName } from "../passkeys";
import { STOREFRONT_ORIGIN } from "../router";
import { Link } from "../ui/Link";
import { Skeleton } from "../ui/states";
import type { Hold, Preorder, SavedItem } from "./Saved";
import { CircleTeaser } from "./Circle";
import "./home.css";
import "./saved.css";

type OrderSummary = { id: string; name: string; status: string; items_count: number };
type OrderDetail = OrderSummary & {
  line_items: { title: string; image_url: string | null }[];
  fulfillments: { tracking_url: string | null; carrier: string | null; delivered_at: string | null; estimated_delivery_at: string | null }[];
};
type GiftCards = { cards: { last4: string; balance_cents: number; currency: string; expires_on: string | null }[]; total_balance_cents: number };

const ACTIVE = new Set(["processing", "preorder", "shipped"]);

function monthYear(iso: string) {
  return new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric" }).format(new Date(iso));
}

export function Home({ user, takeBootMe }: { user: User; takeBootMe?: () => Me | null }) {
  const [me, setMe] = useState<Me | null>(() => takeBootMe?.() ?? null);
  const [order, setOrder] = useState<OrderDetail | null | "loading">("loading");
  const [cards, setCards] = useState<GiftCards | null>(null);
  const [saved, setSaved] = useState<SavedItem[]>([]);
  const [held, setHeld] = useState(0);

  useEffect(() => {
    // Each block loads on its own; one that fails simply does not show.
    if (!me) api<Me>("/api/me").then(setMe).catch(() => {});
    api<GiftCards>("/api/gift-cards").then(setCards).catch(() => {});
    api<{ items: SavedItem[] }>("/api/wishlist").then((r) => setSaved(r.items)).catch(() => {});
    api<{ holds: Hold[]; preorders: Preorder[] }>("/api/holds").then((r) => setHeld(r.holds.length + r.preorders.length)).catch(() => {});
    (async () => {
      try {
        const { orders } = await api<{ orders: OrderSummary[] }>("/api/orders");
        const active = orders.find((o) => ACTIVE.has(o.status));
        setOrder(active ? (await api<{ order: OrderDetail }>(`/api/orders/${encodeURIComponent(active.id)}`)).order : null);
      } catch {
        setOrder(null);
      }
    })();
  }, []);

  const name = (me?.user.first_name ?? user.first_name)?.trim();
  const title = name ? copy.home.greeting(dayPart(new Date().getHours()), name) : copy.home.welcomeBack;
  const since = me?.user.created_at ?? user.created_at;

  return (
    <div class="home">
      <header class="section-heading appear">
        <h1>{title}</h1>
        {since && <p class="eyebrow">{copy.home.memberSince(monthYear(since))}</p>}
      </header>

      {order === "loading" && <Skeleton lines={3} label={copy.home.loading} />}
      {order && order !== "loading" && <OnItsWay order={order} />}

      {/* Everything below waits for the order block: when the skeleton turns
          into nothing (no active order), blocks already drawn under it would
          jump up (S11, CLS). */}
      {order !== "loading" && (
        <>
          {cards && cards.cards.length > 0 && cards.total_balance_cents > 0 && <GiftCardRow cards={cards} />}

          {saved.length > 0 && <SavedStrip items={saved} />}
          {held > 0 && (
            <section class="home-strip home-card" aria-labelledby="home-held">
              <div class="home-strip-head">
                <p id="home-held" class="eyebrow">{copy.saved.count(copy.saved.tabHeld, held)}</p>
                <Link href="/saved?view=held">{copy.saved.seeAll}</Link>
              </div>
            </section>
          )}

          {me && <Onboarding me={me} onDismissed={setMe} />}

          {/* §6.3: the invitation always sits below the useful blocks. */}
          <CircleTeaser />
        </>
      )}
    </div>
  );
}

function OnItsWay({ order }: { order: OrderDetail }) {
  const first = order.line_items[0];
  const parcel = order.fulfillments.find((f) => f.tracking_url) ?? order.fulfillments[0];
  const statusLine = [
    copy.orders.status[order.status] ?? copy.orders.status.processing,
    // §6.3: the arrival date only when Shopify has one.
    parcel && !parcel.delivered_at && parcel.estimated_delivery_at ? copy.orders.arrives(formatDate(parcel.estimated_delivery_at)) : null,
  ].filter(Boolean).join(" · ");

  return (
    <section class="home-card appear" aria-labelledby="on-its-way">
      <p id="on-its-way" class="eyebrow">{copy.home.onItsWay}</p>
      <div class="home-order">
        <span class="order-thumb" aria-hidden="true">
          {first?.image_url && <img src={sized(first.image_url, 160)} alt="" width={64} height={64} />}
        </span>
        <span class="home-order-meta">
          <span>{first?.title ?? order.name}{order.items_count > 1 ? ` ${copy.orders.moreItems(order.items_count - 1)}` : ""}</span>
          <span class="small">{statusLine}</span>
        </span>
      </div>
      <div class="home-actions">
        {parcel?.tracking_url ? (
          <a class="button button-primary" href={parcel.tracking_url} target="_blank" rel="noopener noreferrer">{copy.orders.trackParcel}</a>
        ) : null}
        <Link href={`/orders/${order.id}`} class={parcel?.tracking_url ? "button-link" : "button button-secondary"}>{copy.home.viewOrder}</Link>
      </div>
    </section>
  );
}

// §6.3: a ribbon of 3–6 saved pieces.
function SavedStrip({ items }: { items: SavedItem[] }) {
  return (
    <section class="home-strip home-card" aria-labelledby="home-saved">
      <div class="home-strip-head">
        <p id="home-saved" class="eyebrow">{copy.saved.count(copy.saved.tabSaved, items.length)}</p>
        <Link href="/saved">{copy.saved.seeAll}</Link>
      </div>
      <ul class="saved-ribbon">
        {items.slice(0, 6).map((i) => (
          <li key={i.product_handle} class={i.available ? "saved-card" : "saved-card is-unavailable"}>
            <span class="saved-image">{i.image_url && <img src={sized(i.image_url, 320)} alt="" loading="lazy" width={160} height={160} />}</span>
            <span class="saved-title">{i.title ?? copy.saved.untitled}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function GiftCardRow({ cards }: { cards: GiftCards }) {
  const currency = cards.cards[0]?.currency ?? "USD";
  return (
    <details class="home-row">
      <summary>
        <span>{copy.home.giftCardBalance}</span>
        <span class="home-row-value">{formatMoney(cards.total_balance_cents, currency)}</span>
      </summary>
      <ul class="gift-cards">
        {cards.cards.map((c) => (
          <li key={c.last4 + c.balance_cents}>
            <span>{copy.home.cardEnding(c.last4)}</span>
            {c.expires_on && <span class="small">{copy.home.expires(formatDate(c.expires_on))}</span>}
            <span class="home-row-value">{formatMoney(c.balance_cents, c.currency)}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function Onboarding({ me, onDismissed }: { me: Me; onDismissed: (me: Me) => void }) {
  const items = [
    { key: "account", label: copy.home.onboardingAccount, done: true, href: null as string | null, external: false },
    { key: "passkey", label: copy.home.onboardingPasskey(deviceAuthName()), done: me.onboarding.passkey, href: "/account/security", external: false },
    { key: "saved", label: copy.home.onboardingSave, done: me.onboarding.saved, href: STOREFRONT_ORIGIN, external: true },
  ];
  const doneCount = items.filter((i) => i.done).length;
  if (me.onboarding.dismissed || doneCount === items.length) return null;

  async function dismiss() {
    try {
      onDismissed(await api<Me>("/api/me", { method: "PATCH", body: { onboarding_dismissed: true } }));
    } catch {
      // Keep the card; it will offer itself again next time.
    }
  }

  return (
    <section class="home-card onboarding appear" aria-labelledby="onboarding-title">
      <div class="onboarding-head">
        <h2 id="onboarding-title">{copy.home.onboardingTitle}</h2>
        <span class="small">{copy.home.onboardingProgress(doneCount, items.length)}</span>
      </div>
      <ul class="onboarding-list">
        {items.map((i) => (
          <li key={i.key} class={i.done ? "is-done" : undefined}>
            {i.done
              ? <Check size={18} strokeWidth={1.5} aria-hidden="true" />
              : <Circle size={18} strokeWidth={1.25} aria-hidden="true" />}
            {i.done || !i.href ? (
              <span>{i.label}{i.done && <span class="visually-hidden">{` — ${copy.home.done}`}</span>}</span>
            ) : i.external ? (
              <a href={i.href}>{i.label}</a>
            ) : (
              <Link href={i.href}>{i.label}</Link>
            )}
          </li>
        ))}
      </ul>
      <button type="button" class="button-link" onClick={dismiss}>{copy.home.dismiss}</button>
    </section>
  );
}
