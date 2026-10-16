// /saved (spec §6.5; S7): segments Saved | Held for you.

import { useEffect, useRef, useState } from "preact/hooks";
import { Heart } from "lucide-preact";
import { api, ApiError } from "../api";
import { copy } from "../copy/en";
import { formatDate, formatMoney, sized } from "../format";
import { navigate, STOREFRONT_ORIGIN } from "../router";
import { Link } from "../ui/Link";
import { EmptyState, ErrorState, Skeleton } from "../ui/states";
import { SectionHeading } from "./Placeholder";
import "./saved.css";

export type SavedItem = {
  product_handle: string; title: string | null; image_url: string | null;
  price_cents: number | null; currency: string; url: string | null; available: boolean;
};
export type Hold = { id: string; kind: string; product_handle: string | null; title: string | null; image_url: string | null; created_at: string };
export type Preorder = { order_id: string; name: string; created_at: string; thumb_url: string | null };

type Tab = "saved" | "held";
type Load<T> = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; data: T };

const errMessage = (e: unknown) => (e instanceof ApiError ? e.message : copy.errors.generic);

export function Saved({ initialTab }: { initialTab: Tab }) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const savedTab = useRef<HTMLButtonElement>(null);
  const heldTab = useRef<HTMLButtonElement>(null);

  function select(next: Tab, focus = false) {
    setTab(next);
    navigate(next === "held" ? "/saved?view=held" : "/saved", { replace: true });
    if (focus) (next === "held" ? heldTab : savedTab).current?.focus();
  }

  // Tabs pattern: arrow keys move between the two tabs.
  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      select(tab === "saved" ? "held" : "saved", true);
    }
  }

  return (
    <>
      <SectionHeading eyebrow={copy.eyebrows.saved} title={copy.nav.saved} />
      <div class="segments" role="tablist" aria-label={copy.saved.tabsLabel} onKeyDown={onKeyDown}>
        <button ref={savedTab} type="button" role="tab" id="tab-saved" aria-controls="panel-saved"
          aria-selected={tab === "saved"} tabIndex={tab === "saved" ? 0 : -1} onClick={() => select("saved")}>
          {copy.saved.tabSaved}
        </button>
        <button ref={heldTab} type="button" role="tab" id="tab-held" aria-controls="panel-held"
          aria-selected={tab === "held"} tabIndex={tab === "held" ? 0 : -1} onClick={() => select("held")}>
          {copy.saved.tabHeld}
        </button>
      </div>
      {tab === "saved"
        ? <div role="tabpanel" id="panel-saved" aria-labelledby="tab-saved"><SavedGrid /></div>
        : <div role="tabpanel" id="panel-held" aria-labelledby="tab-held"><HeldList /></div>}
    </>
  );
}

function SavedGrid() {
  const [state, setState] = useState<Load<SavedItem[]>>({ kind: "loading" });

  async function load() {
    setState({ kind: "loading" });
    try {
      setState({ kind: "ready", data: (await api<{ items: SavedItem[] }>("/api/wishlist")).items });
    } catch (e) {
      setState({ kind: "error", message: errMessage(e) });
    }
  }
  useEffect(() => { void load(); }, []);

  async function remove(item: SavedItem) {
    if (state.kind !== "ready") return;
    const before = state.data;
    setState({ kind: "ready", data: before.filter((i) => i.product_handle !== item.product_handle) });
    try {
      await api(`/api/wishlist/${encodeURIComponent(item.product_handle)}`, { method: "DELETE" });
    } catch {
      setState({ kind: "ready", data: before }); // put it back; nothing was removed
    }
  }

  if (state.kind === "loading") return <Skeleton lines={4} label={copy.saved.loading} />;
  if (state.kind === "error") return <ErrorState body={state.message} onRetry={load} />;
  if (!state.data.length) {
    return (
      <EmptyState
        title={copy.saved.emptyTitle}
        body={copy.saved.emptyBody}
        action={<a class="button button-secondary" href={STOREFRONT_ORIGIN}>{copy.saved.emptyAction}</a>}
      />
    );
  }
  return (
    <ul class="saved-grid appear">
      {state.data.map((item) => {
        const title = item.title ?? copy.saved.untitled;
        const media = (
          <>
            <span class="saved-image">
              {item.image_url && <img src={sized(item.image_url, 480)} alt="" loading="lazy" width={240} height={240} />}
            </span>
            <span class="saved-title">{title}</span>
          </>
        );
        return (
          <li key={item.product_handle} class={item.available ? "saved-card" : "saved-card is-unavailable"}>
            {item.available && item.url ? <a href={item.url} class="saved-link">{media}</a> : <span class="saved-link">{media}</span>}
            <span class="small">
              {item.available
                ? (item.price_cents !== null ? formatMoney(item.price_cents, item.currency) : null)
                : copy.saved.unavailable}
            </span>
            <button type="button" class="saved-remove" aria-label={copy.saved.remove(title)} onClick={() => remove(item)}>
              <Heart size={20} strokeWidth={1.5} aria-hidden="true" class="is-filled-heart" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function HeldList() {
  const [state, setState] = useState<Load<{ holds: Hold[]; preorders: Preorder[] }>>({ kind: "loading" });

  async function load() {
    setState({ kind: "loading" });
    try {
      setState({ kind: "ready", data: await api<{ holds: Hold[]; preorders: Preorder[] }>("/api/holds") });
    } catch (e) {
      setState({ kind: "error", message: errMessage(e) });
    }
  }
  useEffect(() => { void load(); }, []);

  if (state.kind === "loading") return <Skeleton lines={3} label={copy.saved.loading} />;
  if (state.kind === "error") return <ErrorState body={state.message} onRetry={load} />;
  const { holds, preorders } = state.data;
  if (!holds.length && !preorders.length) {
    return <EmptyState title={copy.saved.heldEmptyTitle} body={copy.saved.heldEmptyBody} />;
  }
  return (
    <ul class="held-list appear">
      {holds.map((h) => (
        <li key={h.id} class="held-item">
          <span class="order-thumb" aria-hidden="true">
            {h.image_url && <img src={sized(h.image_url, 160)} alt="" loading="lazy" width={64} height={64} />}
          </span>
          <span class="held-meta">
            <span>{h.kind === "circle_waitlist" ? copy.circle.waitlistHeld : (h.title ?? copy.saved.untitled)}</span>
            <span class="small">{copy.saved.heldSince(formatDate(h.created_at))}</span>
            <span class="small">{h.kind === "circle_waitlist" ? copy.circle.onList : copy.saved.heldNext}</span>
          </span>
        </li>
      ))}
      {preorders.map((p) => (
        <li key={p.order_id} class="held-item">
          <span class="order-thumb" aria-hidden="true">
            {p.thumb_url && <img src={sized(p.thumb_url, 160)} alt="" loading="lazy" width={64} height={64} />}
          </span>
          <span class="held-meta">
            <Link href={`/orders/${p.order_id}`}>{copy.saved.preorder(p.name)}</Link>
            <span class="small">{copy.orders.placed(formatDate(p.created_at))}</span>
            <span class="small">{copy.orders.preorderNote}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
