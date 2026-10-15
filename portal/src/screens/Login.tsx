// /login (spec §6.2): one form for sign-in and sign-up; email → link.

import { useEffect, useRef, useState } from "preact/hooks";
import { api, ApiError } from "../api";
import { copy } from "../copy/en";
import { getTurnstileToken } from "../turnstile";
import "./login.css";

const RESEND_AFTER_S = 30;
const EMAIL_RE = /^[^\s@"\\]+@[^\s@."\\]+(\.[^\s@."\\]+)+$/;

export function Login({ returnTo }: { returnTo: string | null }) {
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; field: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [resendIn, setResendIn] = useState(0);
  const [resent, setResent] = useState(false);
  const turnstileBox = useRef<HTMLDivElement>(null);
  const emailInput = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  useEffect(() => {
    if (sentTo) heading.current?.focus();
  }, [sentTo]);

  async function send(address: string): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const turnstile_token = turnstileBox.current ? await getTurnstileToken(turnstileBox.current) : "";
      await api("/api/auth/magic-link", {
        method: "POST",
        body: { email: address, turnstile_token, ...(returnTo ? { return_to: returnTo } : {}) },
      });
      setResendIn(RESEND_AFTER_S);
      return true;
    } catch (e) {
      const err = e instanceof ApiError ? e : null;
      setError({ message: err ? err.message : copy.errors.generic, field: err?.code === "invalid_email" });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function onSubmit(e: Event) {
    e.preventDefault();
    const address = email.trim();
    if (!EMAIL_RE.test(address)) {
      setError({ message: copy.login.invalidEmail, field: true });
      emailInput.current?.focus();
      return;
    }
    if (await send(address)) setSentTo(address);
  }

  async function onResend() {
    if (sentTo && (await send(sentTo))) setResent(true);
  }

  if (sentTo) {
    const s = copy.login.sentTo(sentTo);
    return (
      <div class="login appear">
        <p class="login-wordmark" aria-hidden="true">{copy.brand}</p>
        <h1 ref={heading} tabIndex={-1}>{copy.login.checkInbox}</h1>
        <p class="login-lede">{s.before}<strong>{s.email}</strong>{s.after}</p>
        {resent && <p class="small" role="status">{copy.login.resent}</p>}
        {error && <p class="field-error" role="alert">{error.message}</p>}
        <div class="login-actions">
          <button type="button" class="button button-secondary button-block" disabled={busy || resendIn > 0} onClick={onResend}>
            {resendIn > 0 ? copy.login.resendIn(resendIn) : copy.login.resend}
          </button>
          <button type="button" class="button-link" onClick={() => { setSentTo(null); setResent(false); setError(null); }}>
            {copy.login.differentEmail}
          </button>
        </div>
        <div ref={turnstileBox} class="turnstile" />
      </div>
    );
  }

  return (
    <div class="login appear">
      <p class="login-wordmark" aria-hidden="true">{copy.brand}</p>
      <h1>{copy.login.title}</h1>
      <p class="login-lede">{copy.login.lede}</p>
      <form class="login-form" onSubmit={onSubmit} noValidate>
        <div class="field">
          <label for="email">{copy.login.emailLabel}</label>
          <input
            ref={emailInput}
            id="email"
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            autoCapitalize="off"
            spellcheck={false}
            required
            value={email}
            onInput={(e) => setEmail((e.target as HTMLInputElement).value)}
            aria-invalid={error?.field ? "true" : undefined}
            aria-describedby={error ? "login-error" : undefined}
          />
          {error && <p id="login-error" class="field-error" role="alert">{error.message}</p>}
        </div>
        <button type="submit" class="button button-primary button-block" disabled={busy}>
          {busy ? copy.login.sending : copy.login.submit}
        </button>
        <div ref={turnstileBox} class="turnstile" />
      </form>
      <p class="small">{copy.login.newHere}</p>
    </div>
  );
}
