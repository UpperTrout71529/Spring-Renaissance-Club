// Active sessions (spec §6.8): device, last activity, sign out one, sign out
// everywhere else. No IP is stored or shown — only a coarse city when known.

import { useEffect, useState } from "preact/hooks";
import { api, ApiError } from "../api";
import { copy } from "../copy/en";
import { formatDate } from "../format";
import { ErrorState, Skeleton } from "../ui/states";

type Session = { id: string; current: boolean; auth_method: string; ua_summary: string | null; geo_city: string | null; last_seen_at: string };
type Load = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; sessions: Session[] };

export function Sessions() {
  const [load, setLoad] = useState<Load>({ kind: "loading" });

  async function refresh() {
    setLoad({ kind: "loading" });
    try {
      setLoad({ kind: "ready", sessions: (await api<{ sessions: Session[] }>("/api/sessions")).sessions });
    } catch (e) {
      setLoad({ kind: "error", message: e instanceof ApiError ? e.message : copy.errors.generic });
    }
  }
  useEffect(() => { void refresh(); }, []);

  async function signOut(s: Session) {
    await api(`/api/sessions/${encodeURIComponent(s.id)}`, { method: "DELETE" }).catch(() => {});
    void refresh();
  }
  async function signOutOthers() {
    await api("/api/sessions", { method: "DELETE" }).catch(() => {});
    void refresh();
  }

  return (
    <section class="security-section" aria-labelledby="sessions-title">
      <h2 id="sessions-title">{copy.sessions.title}</h2>
      {load.kind === "loading" && <Skeleton lines={2} label={copy.sessions.loading} />}
      {load.kind === "error" && <ErrorState body={load.message} onRetry={refresh} />}
      {load.kind === "ready" && (
        <>
          <ul class="passkey-list">
            {load.sessions.map((s) => {
              const label = [s.ua_summary || copy.sessions.unknownDevice, s.geo_city].filter(Boolean).join(" · ");
              return (
                <li key={s.id} class="passkey">
                  <div>
                    <p class="passkey-label">{label}{s.current && <span class="session-current">{` — ${copy.sessions.thisDevice}`}</span>}</p>
                    <p class="small">
                      {s.auth_method === "passkey" ? copy.sessions.viaPasskey : copy.sessions.viaLink}
                      {" · "}
                      {copy.sessions.lastActive(formatDate(s.last_seen_at))}
                    </p>
                  </div>
                  {!s.current && (
                    <button type="button" class="button-link" aria-label={copy.sessions.signOutLabel(label)} onClick={() => signOut(s)}>
                      {copy.sessions.signOut}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          {load.sessions.some((s) => !s.current) && (
            <button type="button" class="button button-secondary" onClick={signOutOthers}>{copy.sessions.signOutOthers}</button>
          )}
        </>
      )}
    </section>
  );
}
