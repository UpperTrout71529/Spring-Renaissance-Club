import { defineConfig, loadEnv, type Plugin } from "vite";
import preact from "@preact/preset-vite";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

declare const process: { cwd(): string };

const DEFAULT_API_BASE = "https://api.springrenaissance.store";

// Static portal routes (spec §5.3). GitHub Pages serves /login from
// login.html with status 200; without these files every deep link would be
// answered by 404.html with HTTP 404. Dynamic paths (/orders/:id) still fall
// back to 404.html and are resolved by the client router.
const STATIC_ROUTES = [
  "login", "auth", "orders", "saved", "circle", "account",
  "account/security", "account/privacy", "terms/membership",
];

// Spec §13.1: the CSP lives in a <meta> tag (GitHub Pages cannot set headers).
// Build only — the dev server injects inline scripts for HMR.
function csp(apiBase: string): string {
  const api = apiBase ? ` ${new URL(apiBase).origin}` : "";
  return [
    "default-src 'self'",
    `connect-src 'self'${api} https://challenges.cloudflare.com https://cloudflareinsights.com`,
    "img-src 'self' https://cdn.shopify.com data:",
    "font-src 'self'",
    "style-src 'self'",
    "frame-src https://challenges.cloudflare.com",
    "script-src 'self' https://challenges.cloudflare.com https://static.cloudflareinsights.com",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
}

function portalHtml(env: Record<string, string>): Plugin {
  const apiBase = env.VITE_API_BASE ?? DEFAULT_API_BASE;
  const beacon = env.VITE_CF_BEACON_TOKEN;
  let outDir = "dist";
  return {
    name: "sr-portal-html",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    transformIndexHtml() {
      const tags = [
        { tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: csp(apiBase) }, injectTo: "head-prepend" as const },
      ];
      // Cloudflare Web Analytics (cookieless), only when a site token is set.
      if (beacon) {
        tags.push({
          tag: "script",
          attrs: {
            defer: true,
            src: "https://static.cloudflareinsights.com/beacon.min.js",
            "data-cf-beacon": JSON.stringify({ token: beacon }),
          },
          injectTo: "body",
        } as never);
      }
      return tags;
    },
    // GitHub Pages serves 404.html for unknown paths: a copy of index.html
    // lets the client router take over deep links like /orders/1042.
    closeBundle() {
      const index = resolve(outDir, "index.html");
      copyFileSync(index, resolve(outDir, "404.html"));
      for (const route of STATIC_ROUTES) {
        const target = resolve(outDir, `${route}.html`);
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(index, target);
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  return {
    plugins: [preact(), portalHtml(env)],
    build: { target: "es2022", sourcemap: false },
    test: {
      environment: "jsdom",
      include: ["src/**/*.test.{ts,tsx}"],
    },
  };
});
