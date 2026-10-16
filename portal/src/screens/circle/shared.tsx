// Small pieces shared by the V2 Circle screens: a loader for one GET, the
// back link of inner screens (spec §5.4), and the "code shown once" block
// (Use credits step 3, a capsule claim).

import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { ArrowLeft } from "lucide-preact";
import { api, ApiError } from "../../api";
import { copy } from "../../copy/en";
import { Link } from "../../ui/Link";
import "./circle-v2.css";

export const errMessage = (e: unknown) => (e instanceof ApiError ? e.message : copy.errors.generic);

export type Load<T> =
  | { kind: "loading" }
  | { kind: "error"; status: number; code: string; message: string }
  | { kind: "ready"; data: T };

export function toError(e: unknown): Load<never> {
  return e instanceof ApiError
    ? { kind: "error", status: e.status, code: e.code, message: e.message }
    : { kind: "error", status: 0, code: "unknown", message: copy.errors.generic };
}

// One GET, with reload (skeleton first), refresh (keeps what is shown until
// the answer arrives) and a local setter for optimistic updates.
export function useApi<T>(path: string) {
  const [state, setState] = useState<Load<T>>({ kind: "loading" });
  async function load(quiet = false) {
    if (!quiet) setState({ kind: "loading" });
    try {
      setState({ kind: "ready", data: await api<T>(path) });
    } catch (e) {
      setState(toError(e));
    }
  }
  useEffect(() => { void load(); }, [path]);
  const set = (data: T) => setState({ kind: "ready", data });
  return { state, reload: () => load(), refresh: () => load(true), set };
}

export function BackLink({ href, text, label }: { href: string; text: string; label: string }) {
  return (
    <Link href={href} class="back-link">
      <ArrowLeft size={20} strokeWidth={1.5} aria-hidden="true" />
      <span class="visually-hidden">{label}</span>
      <span aria-hidden="true">{text}</span>
    </Link>
  );
}

export const BackToCircle = () => <BackLink href="/circle" text={copy.back.circle} label={copy.back.circleLabel} />;

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// The full code is in this one response only (spec §6.7, §8.4); it is also
// emailed. It is selectable, so copying works without the clipboard API.
export function CodeReveal({ code, label, note, actions }: {
  code: string; label: string; note: string; actions?: ComponentChildren;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div class="code-reveal">
      <p class="small">{label}</p>
      <p class="code-value">{code}</p>
      <p class="small">{note}</p>
      <div class="circle-actions">
        <button type="button" class="button button-primary" onClick={async () => setCopied(await copyText(code))}>
          {copy.use.copyCode}
        </button>
        {actions}
        {copied && <span class="small" role="status">{copy.use.copied}</span>}
      </div>
    </div>
  );
}
