// /account/security (spec §6.8, S4 part): passkeys — list, add, remove.
// Active sessions arrive with S9.

import { useEffect, useState } from "preact/hooks";
import { api, ApiError } from "../api";
import { copy } from "../copy/en";
import { addPasskey, browserSupportsWebAuthn, deviceAuthName, isCancelled, type Passkey } from "../passkeys";
import { EmptyState, ErrorState, Skeleton } from "../ui/states";
import { StepUpDialog } from "../ui/StepUpDialog";
import { SectionHeading } from "./Placeholder";
import "./security.css";

const fmt = (iso: string) =>
  new Intl.DateTimeFormat(navigator.language, { month: "short", day: "numeric", year: "numeric" }).format(new Date(iso));

type Load = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; passkeys: Passkey[] };

export function Security({ email }: { email: string }) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingRemove, setPendingRemove] = useState<Passkey | null>(null);
  const name = deviceAuthName();
  const supported = browserSupportsWebAuthn();

  async function refresh() {
    setLoad({ kind: "loading" });
    try {
      const res = await api<{ passkeys: Passkey[] }>("/api/passkeys");
      setLoad({ kind: "ready", passkeys: res.passkeys });
    } catch (e) {
      setLoad({ kind: "error", message: e instanceof ApiError ? e.message : copy.errors.generic });
    }
  }

  useEffect(() => { void refresh(); }, []);

  async function onAdd() {
    setBusy(true);
    setNotice(null);
    try {
      const passkey = await addPasskey();
      setLoad((l) => (l.kind === "ready" ? { kind: "ready", passkeys: [...l.passkeys, passkey] } : l));
    } catch (e) {
      if (!isCancelled(e)) setNotice(e instanceof ApiError ? e.message : copy.security.addFailed);
    } finally {
      setBusy(false);
    }
  }

  async function remove(passkey: Passkey): Promise<"done" | "step_up"> {
    try {
      await api(`/api/passkeys/${encodeURIComponent(passkey.credential_id)}`, { method: "DELETE" });
      setLoad((l) => (l.kind === "ready"
        ? { kind: "ready", passkeys: l.passkeys.filter((p) => p.credential_id !== passkey.credential_id) }
        : l));
      return "done";
    } catch (e) {
      if (e instanceof ApiError && e.code === "step_up_required") return "step_up";
      setNotice(e instanceof ApiError ? e.message : copy.errors.generic);
      return "done";
    }
  }

  async function onRemove(passkey: Passkey) {
    setNotice(null);
    if ((await remove(passkey)) === "step_up") setPendingRemove(passkey);
  }

  const passkeys = load.kind === "ready" ? load.passkeys : [];

  return (
    <>
      <SectionHeading title={copy.security.title} />
      <section class="security-section" aria-labelledby="passkeys-title">
        <h2 id="passkeys-title">{copy.security.passkeysTitle}</h2>
        <p class="security-lede">{copy.security.passkeysBody}</p>
        {notice && <p class="field-error" role="alert">{notice}</p>}

        {load.kind === "loading" && <Skeleton lines={2} label={copy.security.loading} />}
        {load.kind === "error" && <ErrorState body={load.message} onRetry={refresh} />}
        {load.kind === "ready" && passkeys.length === 0 && (
          <EmptyState title={copy.security.emptyTitle} body={copy.security.emptyBody(name)} />
        )}
        {passkeys.length > 0 && (
          <ul class="passkey-list">
            {passkeys.map((p) => {
              const label = p.device_label || copy.security.unnamed;
              return (
                <li key={p.credential_id} class="passkey">
                  <div>
                    <p class="passkey-label">{label}</p>
                    <p class="small">
                      {copy.security.added(fmt(p.created_at))}
                      {" · "}
                      {p.last_used_at ? copy.security.lastUsed(fmt(p.last_used_at)) : copy.security.neverUsed}
                    </p>
                  </div>
                  <button type="button" class="button-link" aria-label={copy.security.removeLabel(label)} onClick={() => onRemove(p)}>
                    {copy.security.remove}
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {supported && load.kind === "ready" && (
          <button type="button" class="button button-secondary" disabled={busy} onClick={onAdd}>
            {busy ? copy.security.adding : copy.security.add(name)}
          </button>
        )}
      </section>

      {pendingRemove && (
        <StepUpDialog
          email={email}
          hasPasskeys={passkeys.length > 0}
          onCancel={() => setPendingRemove(null)}
          onConfirmed={async () => {
            const p = pendingRemove;
            setPendingRemove(null);
            await remove(p);
          }}
        />
      )}
    </>
  );
}
