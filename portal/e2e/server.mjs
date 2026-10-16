// E2E server: the built portal and the real Worker app (src/app.js) on one
// HTTPS origin, with D1 emulated over node:sqlite (the worker test harness)
// and the outside world faked — emails are captured, Turnstile accepts the
// stub token, Shopify is not configured. HTTPS is required: the session cookie
// is __Host- (Secure). Same origin stands in for club./api. same-site; the
// real cross-subdomain check is on staging (S11).
//
//   node e2e/server.mjs   (serves portal/dist-e2e on https://localhost:4443)

import { createServer } from "node:https";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { createApp } from "../../src/app.js";
import { makeEnv } from "../../test/harness.mjs";
import { AUD, TEAM, makeAccess } from "../../test/access-helpers.mjs";
import { STRIPE_WHSEC, createCircleFakes } from "./circle-fakes.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const DIST = resolve(HERE, "..", "dist-e2e");
const PUBLIC = resolve(HERE, "..", "..", "public");
export const PORT = Number(process.env.E2E_PORT || 4443);
const ORIGIN = `https://localhost:${PORT}`;

function certificate() {
  const dir = join(tmpdir(), "sr-portal-e2e-cert");
  const key = join(dir, "key.pem");
  const cert = join(dir, "cert.pem");
  if (!existsSync(key) || !existsSync(cert)) {
    mkdirSync(dir, { recursive: true });
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "30",
      "-keyout", key, "-out", cert, "-subj", "/CN=localhost",
      "-addext", "subjectAltName=DNS:localhost",
    ], { stdio: "ignore" });
  }
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

// A fake Cloudflare Access for the admin (S10): its certs answer the
// Worker's JWT check, and /__e2e/access-jwt mints a token for a test.
const access = await makeAccess();
const ADMIN_EMAIL = "felix@example.com";

const emails = [];
const outside = async (url, init = {}) => {
  const u = String(url);
  const certs = access.fetch(u);
  if (certs) return certs;
  if (u.startsWith("https://api.resend.com/")) {
    emails.push(JSON.parse(init.body));
    return Response.json({ id: `re_${emails.length}` });
  }
  if (u.startsWith("https://api.stripe.com/")) return circle.fakeStripe(u, init);
  if (u.startsWith("https://challenges.cloudflare.com/")) {
    return Response.json({ success: init.body.get("response") === "e2e-token" });
  }
  throw new Error(`e2e: unexpected outbound fetch ${u}`);
};

const env = makeEnv({
  SESSION_PEPPER: "e2e-pepper",
  TURNSTILE_SECRET: "e2e-secret",
  RESEND_API_KEY: "e2e-resend",
  ALLOWED_ORIGINS: ORIGIN,
  PORTAL_URL: ORIGIN,
  PASSKEY_RP_ID: "localhost",
  PASSKEY_ORIGINS: ORIGIN,
  ACCESS_TEAM_DOMAIN: TEAM,
  ACCESS_AUD: AUD,
  ADMIN_EMAILS: ADMIN_EMAIL,
  // V2 Circle: Stripe is the fake in e2e/circle-fakes.mjs (test-mode key shape).
  STRIPE_SECRET_KEY: "sk_test_e2e",
  STRIPE_CIRCLE_WEBHOOK_SECRET: STRIPE_WHSEC,
  CIRCLE_JOIN_OPEN: "on",
  // Workers Static Assets stand-in: public/ on disk.
  ASSETS: {
    async fetch(request) {
      const file = normalize(join(PUBLIC, decodeURIComponent(new URL(request.url).pathname)));
      if (!file.startsWith(PUBLIC + sep) || !existsSync(file)) return new Response("Not found", { status: 404 });
      return new Response(readFileSync(file), { headers: { "Content-Type": TYPES[extname(file)] || "application/octet-stream" } });
    },
  },
});
const app = createApp({ fetch: outside });
const circle = createCircleFakes({ origin: ORIGIN, env, app });

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
  ".woff2": "font/woff2", ".woff": "font/woff", ".svg": "image/svg+xml", ".png": "image/png",
};

// Cloudflare Pages compresses text responses; so does this server, so that
// Lighthouse's throttled transfer times match production rather than an
// uncompressed bundle (fonts and images are already compressed formats).
function send(req, res, status, type, body) {
  const headers = { "Content-Type": type };
  if (/^(text\/|application\/json)/.test(type) && /\bgzip\b/.test(req.headers["accept-encoding"] || "")) {
    body = gzipSync(body);
    headers["Content-Encoding"] = "gzip";
    headers["Vary"] = "Accept-Encoding";
  }
  res.writeHead(status, headers);
  res.end(body);
}

function serveStatic(req, pathname, res) {
  const file = normalize(join(DIST, decodeURIComponent(pathname)));
  if (file.startsWith(DIST + sep) && existsSync(file) && extname(file)) {
    send(req, res, 200, TYPES[extname(file)] || "application/octet-stream", readFileSync(file));
    return;
  }
  // GitHub Pages behaviour: /login is served from login.html (200); unknown
  // paths get 404.html with status 404.
  const page = pathname === "/" ? join(DIST, "index.html") : normalize(join(DIST, `${decodeURIComponent(pathname).replace(/\/+$/, "")}.html`));
  if (page.startsWith(DIST + sep) && existsSync(page)) {
    send(req, res, 200, TYPES[".html"], readFileSync(page));
    return;
  }
  send(req, res, 404, TYPES[".html"], readFileSync(join(DIST, "404.html")));
}

async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

const server = createServer(certificate(), async (req, res) => {
  const url = new URL(req.url, ORIGIN);
  try {
    if (url.pathname === "/__e2e/last-code") {
      const to = url.searchParams.get("email");
      const mail = [...emails].reverse().find((m) => m.to.includes(to) && m.subject === "Your confirmation code");
      const code = mail ? /\b(\d{6})\b/.exec(mail.text)[1] : null;
      res.writeHead(code ? 200 : 404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code }));
      return;
    }
    const fake = await circle.route(url, req, () => body(req));
    if (fake) {
      const out = {};
      fake.headers.forEach((v, k) => { out[k] = v; });
      res.writeHead(fake.status, out);
      res.end(Buffer.from(await fake.arrayBuffer()));
      return;
    }
    if (url.pathname === "/__e2e/access-jwt") {
      const nowS = Math.floor(Date.now() / 1000);
      const jwt = await access.sign({ email: url.searchParams.get("email") || ADMIN_EMAIL, iat: nowS, nbf: nowS, exp: nowS + 3600 });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jwt }));
      return;
    }
    if (url.pathname === "/__e2e/last-link") {
      const to = url.searchParams.get("email");
      const mail = [...emails].reverse().find((m) => m.to.includes(to));
      const link = mail ? /https:\/\/\S+\/auth#t=[A-Za-z0-9_-]+/.exec(mail.text)[0] : null;
      res.writeHead(link ? 200 : 404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ link }));
      return;
    }
    if (url.pathname === "/health" || url.pathname === "/webhooks/stripe" || url.pathname.startsWith("/api/") || url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers.set(k, v);
      }
      // Cloudflare sets the client address at the edge. Give each connection
      // its own, so parallel tests do not share the §10.6 per-IP limits.
      const port = req.socket.remotePort || 0;
      headers.set("CF-Connecting-IP", `198.18.${(port >> 8) & 255}.${port & 255}`);
      const request = new Request(url, {
        method: req.method,
        headers,
        body: ["GET", "HEAD"].includes(req.method) ? undefined : await body(req),
      });
      const pending = [];
      const response = await app.fetch(request, env, { waitUntil: (p) => pending.push(p) });
      const out = {};
      response.headers.forEach((v, k) => { if (k !== "set-cookie") out[k] = v; });
      const cookies = response.headers.getSetCookie();
      if (cookies.length) out["set-cookie"] = cookies;
      res.writeHead(response.status, out);
      res.end(Buffer.from(await response.arrayBuffer()));
      await Promise.all(pending);
      return;
    }
    serveStatic(req, url.pathname, res);
  } catch (e) {
    console.error("e2e server error", e);
    res.writeHead(500);
    res.end();
  }
});

server.listen(PORT, () => console.log(`e2e server on ${ORIGIN}`));
