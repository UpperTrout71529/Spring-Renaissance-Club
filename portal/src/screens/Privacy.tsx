// /account/privacy (spec §6.8, §13.3–13.4): download my data, delete account.
// Both need a fresh step-up (§10.4).

import { useState } from "preact/hooks";
import { API_BASE, ApiError } from "../api";
import { copy } from "../copy/en";
import { useStepUp } from "../ui/useStepUp";
import { SectionHeading } from "./Placeholder";
import "./security.css";

// fetch with the API's error shape, for the two calls that are not JSON in,
// JSON out (a file download and a DELETE with a body).
async function call(path: string, init: RequestInit): Promise<Response> {
  const res = await fetch(`${API_BASE}${path}`, { credentials: "include", ...init });
  if (!res.ok) {
    const data = await res.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
    throw new ApiError(res.status, data?.error?.code || "http_error", data?.error?.message || copy.errors.generic);
  }
  return res;
}

export function Privacy({ email, onDeleted }: { email: string; onDeleted: () => void }) {
  const { run, dialog } = useStepUp(email);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function download() {
    setError(null);
    try {
      const res = await run(() => call("/api/account/export", { method: "GET" }));
      if (!res) return;
      const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") || "")?.[1] || "spring-renaissance-account.json";
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : copy.errors.generic);
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      const res = await run(() => call("/api/account", {
        method: "DELETE",
        headers: { "Content-Type": "application/json", "X-SR-Client": "portal" },
        body: JSON.stringify({ confirm: "DELETE" }),
      }));
      if (res) onDeleted();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : copy.errors.generic);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <SectionHeading title={copy.privacy.title} />
      {error && <p class="field-error" role="alert">{error}</p>}
      <section class="account-section" aria-labelledby="download-title">
        <h2 id="download-title">{copy.privacy.downloadTitle}</h2>
        <p class="small">{copy.privacy.downloadBody}</p>
        <button type="button" class="button button-secondary" onClick={download}>{copy.privacy.download}</button>
      </section>
      <section class="account-section" aria-labelledby="delete-title">
        <h2 id="delete-title">{copy.privacy.deleteTitle}</h2>
        {!confirming ? (
          <button type="button" class="button-link danger-link" onClick={() => setConfirming(true)}>{copy.privacy.deleteStart}</button>
        ) : (
          <div class="notice delete-confirm" role="group" aria-labelledby="delete-title">
            <p>{copy.privacy.deleteBody}</p>
            <div class="account-actions">
              <button type="button" class="button button-primary" disabled={busy} onClick={remove}>{copy.privacy.deleteConfirm}</button>
              <button type="button" class="button-link" onClick={() => setConfirming(false)}>{copy.privacy.keep}</button>
            </div>
          </div>
        )}
      </section>
      {dialog}
    </>
  );
}
