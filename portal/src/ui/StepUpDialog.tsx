// Step-up (spec §10.4): confirm with a passkey, or with a 6-digit code sent
// by email. A native <dialog> gives focus trapping and Esc for free.

import { useEffect, useRef, useState } from "preact/hooks";
import { api, ApiError } from "../api";
import { copy } from "../copy/en";
import { browserSupportsWebAuthn, deviceAuthName, isCancelled, stepUpWithPasskey } from "../passkeys";
import "./dialog.css";

type Props = { email: string; hasPasskeys: boolean; onConfirmed: () => void; onCancel: () => void };

export function StepUpDialog({ email, hasPasskeys, onConfirmed, onCancel }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const codeInput = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<"choose" | "code">("choose");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canPasskey = hasPasskeys && browserSupportsWebAuthn();

  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);

  useEffect(() => {
    if (mode === "code") codeInput.current?.focus();
  }, [mode]);

  async function withPasskey() {
    setBusy(true);
    setError(null);
    try {
      await stepUpWithPasskey();
      onConfirmed();
    } catch (e) {
      if (!isCancelled(e)) setError(copy.stepUp.passkeyFailed);
    } finally {
      setBusy(false);
    }
  }

  async function sendCode() {
    setBusy(true);
    setError(null);
    try {
      await api("/api/auth/step-up/email-code", { method: "POST", body: {} });
      setCode("");
      setMode("code");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : copy.errors.generic);
    } finally {
      setBusy(false);
    }
  }

  async function confirmCode(e: Event) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/auth/step-up/verify", { method: "POST", body: { code: code.trim() } });
      onConfirmed();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : copy.errors.generic);
      codeInput.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      class="dialog"
      aria-labelledby="step-up-title"
      aria-describedby="step-up-body"
      onCancel={(e) => { e.preventDefault(); onCancel(); }}
    >
      <h2 id="step-up-title">{copy.stepUp.title}</h2>
      {mode === "choose" ? (
        <div class="dialog-body">
          <p id="step-up-body">{copy.stepUp.body}</p>
          {error && <p class="field-error" role="alert">{error}</p>}
          {canPasskey && (
            <button type="button" class="button button-primary button-block" disabled={busy} onClick={withPasskey}>
              {copy.stepUp.usePasskey(deviceAuthName())}
            </button>
          )}
          <button
            type="button"
            class={`button ${canPasskey ? "button-secondary" : "button-primary"} button-block`}
            disabled={busy}
            onClick={sendCode}
          >
            {copy.stepUp.emailCode}
          </button>
          <button type="button" class="button-link" onClick={onCancel}>{copy.stepUp.cancel}</button>
        </div>
      ) : (
        <form class="dialog-body" onSubmit={confirmCode} noValidate>
          <p id="step-up-body">{copy.stepUp.codeSent(email)}</p>
          <div class="field">
            <label for="step-up-code">{copy.stepUp.codeLabel}</label>
            <input
              ref={codeInput}
              id="step-up-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              value={code}
              onInput={(e) => setCode((e.target as HTMLInputElement).value.replace(/\D/g, ""))}
              aria-invalid={error ? "true" : undefined}
              aria-describedby={error ? "step-up-error" : undefined}
            />
            {error && <p id="step-up-error" class="field-error" role="alert">{error}</p>}
          </div>
          <button type="submit" class="button button-primary button-block" disabled={busy || code.length !== 6}>
            {copy.stepUp.confirm}
          </button>
          <button type="button" class="button-link" disabled={busy} onClick={sendCode}>{copy.stepUp.resend}</button>
          <button type="button" class="button-link" onClick={onCancel}>{copy.stepUp.cancel}</button>
        </form>
      )}
    </dialog>
  );
}
