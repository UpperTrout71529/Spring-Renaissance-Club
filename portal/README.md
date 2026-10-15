# Portal — club.springrenaissance.store

Vite + Preact + TypeScript single-page app (spec "ЛК — ТЗ v1.1", §3.4–§6).

```bash
npm ci
npm run dev          # local dev server; set VITE_API_BASE / ALLOWED_ORIGINS for a local Worker
npm run build        # tsc + vite build → dist/ (with 404.html and one .html per static route)
npm test             # Vitest unit tests
npm run e2e          # Playwright: Chromium + WebKit at 375×812 and 1280×800, axe, real-Worker sign-in
npm run lighthouse   # Lighthouse accessibility on /login, fails below 95
```

- **Copy:** every UI string is in `src/copy/en.ts`; a unit test fails on literal
  text in JSX.
- **Design tokens:** `src/ui/tokens.css`, taken from the storefront theme
  (WORK 4 `config/settings_data.json`): `#FBFBF9` background, `#000000` ink,
  `#E6E6E6` lines, `#5E4638` accent; DM Serif Display headings, the theme's
  system serif stack for body text, Chivo 700 for small caps labels. Fonts are
  self-hosted (`@fontsource`, OFL), so the CSP needs no font CDN.
- **Routing:** History API (`src/router.ts`). GitHub Pages serves `login.html`
  etc. for static routes (HTTP 200) and `404.html` for dynamic ones such as
  `/orders/1042`; both are copies of `index.html`.
- **CSP:** a `<meta>` tag added at build time (`vite.config.ts`), derived from
  `VITE_API_BASE`.
- **Build variables:** `VITE_API_BASE` (default `https://api.springrenaissance.store`),
  `VITE_TURNSTILE_SITE_KEY` (without it no sign-in link can be requested),
  `VITE_CF_BEACON_TOKEN` (Cloudflare Web Analytics; omitted when empty).
- **E2E server** (`e2e/server.mjs`): serves `dist-e2e/` and the real Worker app
  (`../src/app.js`) on `https://localhost:4443` with D1 emulated by the Worker
  test harness and Resend/Turnstile faked. Same origin stands in for
  `club.`/`api.`; the cross-subdomain check belongs to staging (S11).
- **Deploy:** `.github/workflows/pages.yml`, manual only — see the note there.
