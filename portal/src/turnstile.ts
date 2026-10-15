// Cloudflare Turnstile, invisible (spec §6.2). The widget runs only when the
// form is submitted. Without a site key no token is produced and the API
// refuses to send a link — "no check, no email".

const SITE_KEY: string = import.meta.env.VITE_TURNSTILE_SITE_KEY ?? "";
const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

type Turnstile = {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  execute: (widgetId: string) => void;
  reset: (widgetId: string) => void;
};
declare global {
  interface Window { turnstile?: Turnstile }
}

let loading: Promise<Turnstile> | null = null;

function load(): Promise<Turnstile> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = SCRIPT_SRC;
      s.async = true;
      s.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("turnstile missing")));
      s.onerror = () => {
        loading = null;
        reject(new Error("turnstile failed to load"));
      };
      document.head.appendChild(s);
    });
  }
  return loading;
}

type Widget = { id: string; ts: Turnstile; pending?: (token: string) => void; fail?: () => void };
let widget: Widget | null = null;

export async function getTurnstileToken(container: HTMLElement): Promise<string> {
  if (!SITE_KEY) return "";
  try {
    const ts = await load();
    if (!widget) {
      const w: Widget = { id: "", ts };
      w.id = ts.render(container, {
        sitekey: SITE_KEY,
        execution: "execute",
        appearance: "interaction-only",
        callback: (token: string) => w.pending?.(token),
        "error-callback": () => w.fail?.(),
      });
      widget = w;
    }
    const w: Widget = widget;
    return await new Promise<string>((resolve) => {
      w.pending = resolve;
      w.fail = () => resolve("");
      w.ts.execute(w.id);
    }).finally(() => w.ts.reset(w.id));
  } catch {
    return "";
  }
}
