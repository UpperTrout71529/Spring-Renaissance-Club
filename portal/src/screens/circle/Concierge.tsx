// /circle/concierge (spec v1.1 J11, T13; D35): the member's thread with the
// Maison and a box to write. People answer — nothing here generates text.
// ?priority=1 comes from the cancel offer "An order or delivery didn't go
// well" (§16.1) and marks the message as a priority.

import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../../api";
import { copy } from "../../copy/en";
import { formatDate } from "../../format";
import type { ConciergeMessage } from "../../circle-model";
import { ErrorState, Skeleton } from "../../ui/states";
import { SectionHeading } from "../Placeholder";
import { BackToCircle, errMessage, useApi } from "./shared";

const MAX = 4000;

export function Concierge({ search }: { search: string }) {
  const priority = new URLSearchParams(search).get("priority") === "1";
  const { state, reload, refresh } = useApi<{ messages: ConciergeMessage[]; unread: number }>("/api/circle/concierge");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { if (priority) box.current?.focus(); }, [state.kind]);

  async function send(e: Event) {
    e.preventDefault();
    const text = body.trim();
    if (!text) { setError(copy.concierge.required); box.current?.focus(); return; }
    if (text.length > MAX) { setError(copy.concierge.tooLong(MAX)); box.current?.focus(); return; }
    setBusy(true);
    setError(null);
    try {
      await api("/api/circle/concierge", { method: "POST", body: { body: text, ...(priority ? { priority: true } : {}) } });
      setBody("");
      await refresh();
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <BackToCircle />
      <SectionHeading eyebrow={copy.concierge.eyebrow} title={copy.concierge.title} />
      <div class="circle-intro"><p>{copy.concierge.lede}</p></div>
      {state.kind === "loading" && <Skeleton lines={4} label={copy.concierge.loading} />}
      {state.kind === "error" && <ErrorState body={state.message} onRetry={reload} />}
      {state.kind === "ready" && (
        state.data.messages.length === 0
          ? <p class="circle-notice small">{copy.concierge.empty}</p>
          : (
            <ol class="thread appear" aria-label={copy.concierge.threadLabel}>
              {state.data.messages.map((m) => (
                <li key={m.id} class={`message message-${m.author}`}>
                  <span class="small">{`${m.author === "maison" ? copy.concierge.maison : copy.concierge.you} · ${formatDate(m.created_at)}`}</span>
                  <p>{m.body}</p>
                </li>
              ))}
            </ol>
          )
      )}
      {state.kind === "ready" && (
        <form class="circle-form" onSubmit={send} noValidate>
          {priority && <p class="small">{copy.concierge.priority}</p>}
          <div class="field">
            <label for="concierge-body">{copy.concierge.label}</label>
            <textarea id="concierge-body" ref={box} rows={5} maxLength={MAX} value={body}
              onInput={(e) => setBody((e.target as HTMLTextAreaElement).value)}
              aria-invalid={error ? "true" : undefined} aria-describedby={error ? "concierge-error" : undefined} />
            {error && <p id="concierge-error" class="field-error" role="alert">{error}</p>}
          </div>
          <div><button type="submit" class="button button-primary" disabled={busy}>{busy ? copy.concierge.sending : copy.concierge.send}</button></div>
        </form>
      )}
    </>
  );
}
