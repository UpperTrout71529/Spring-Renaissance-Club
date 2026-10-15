// Screen states (spec §6.1): loading = skeletons (never spinners), empty =
// what this is + why it is empty + one action, error = what happened + what
// to do + "Try again", and an offline notice.

import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { WifiOff } from "lucide-preact";
import { copy } from "../copy/en";
import "./states.css";

export function Skeleton({ lines = 3, label }: { lines?: number; label: string }) {
  return (
    <div class="skeleton" role="status" aria-live="polite">
      <span class="visually-hidden">{label}</span>
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} class="skeleton-line" aria-hidden="true" />
      ))}
    </div>
  );
}

export function EmptyState({ title, body, action }: { title: string; body: string; action?: ComponentChildren }) {
  return (
    <section class="state appear">
      <h2>{title}</h2>
      <p>{body}</p>
      {action && <div class="state-action">{action}</div>}
    </section>
  );
}

export function ErrorState({ title = copy.errors.errorTitle, body, onRetry }: { title?: string; body: string; onRetry?: () => void }) {
  return (
    <section class="state appear" role="alert">
      <h2>{title}</h2>
      <p>{body}</p>
      {onRetry && (
        <div class="state-action">
          <button type="button" class="button button-secondary" onClick={onRetry}>{copy.errors.tryAgain}</button>
        </div>
      )}
    </section>
  );
}

export function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  return online;
}

export function OfflineBanner() {
  const online = useOnline();
  if (online) return null;
  return (
    <div class="offline" role="status">
      <WifiOff size={16} strokeWidth={1.5} aria-hidden="true" />
      <span>{copy.offline}</span>
    </div>
  );
}
