// Passkeys in the browser (spec §10.3) on top of @simplewebauthn/browser.

import {
  browserSupportsWebAuthn,
  browserSupportsWebAuthnAutofill,
  startAuthentication,
  startRegistration,
  WebAuthnAbortService,
} from "@simplewebauthn/browser";
import { api, type User } from "./api";

export { browserSupportsWebAuthn, browserSupportsWebAuthnAutofill };

// Label only (§6.2): "Face ID" on iPhone/iPad, "Touch ID" on a Mac, otherwise
// null and the copy says "your device". The ceremony itself is standard.
export function deviceAuthName(ua: string = navigator.userAgent): "Face ID" | "Touch ID" | null {
  if (/iPhone|iPad/.test(ua)) return "Face ID";
  if (/Macintosh|Mac OS X/.test(ua) && !/Mobile/.test(ua)) return "Touch ID";
  return null;
}

// The user closed the system sheet or it timed out — not an error to show.
export function isCancelled(e: unknown): boolean {
  const name = (e as { name?: string; cause?: { name?: string } } | null)?.name;
  const cause = (e as { cause?: { name?: string } } | null)?.cause?.name;
  return name === "NotAllowedError" || name === "AbortError" || cause === "NotAllowedError" || cause === "AbortError";
}

export async function signInWithPasskey({ autofill = false } = {}): Promise<User> {
  const optionsJSON = await api<Parameters<typeof startAuthentication>[0]["optionsJSON"]>(
    "/api/auth/passkey/login/options", { method: "POST", body: {} },
  );
  const response = await startAuthentication({ optionsJSON, useBrowserAutofill: autofill });
  const res = await api<{ user: User }>("/api/auth/passkey/login/verify", { method: "POST", body: { response } });
  return res.user;
}

export function cancelPendingCeremony() {
  WebAuthnAbortService.cancelCeremony();
}

export type Passkey = {
  credential_id: string;
  device_label: string | null;
  created_at: string;
  last_used_at: string | null;
  backed_up: boolean;
};

export async function addPasskey(): Promise<Passkey> {
  const optionsJSON = await api<Parameters<typeof startRegistration>[0]["optionsJSON"]>(
    "/api/auth/passkey/register/options", { method: "POST", body: {} },
  );
  const response = await startRegistration({ optionsJSON });
  const res = await api<{ passkey: Passkey }>("/api/auth/passkey/register/verify", { method: "POST", body: { response } });
  return res.passkey;
}

export async function stepUpWithPasskey(): Promise<void> {
  const optionsJSON = await api<Parameters<typeof startAuthentication>[0]["optionsJSON"]>(
    "/api/auth/step-up/passkey/options", { method: "POST", body: {} },
  );
  const passkey_response = await startAuthentication({ optionsJSON });
  await api("/api/auth/step-up/verify", { method: "POST", body: { passkey_response } });
}
