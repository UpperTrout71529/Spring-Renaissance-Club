// club.springrenaissance.store until the V1 launch: only the Private Client
// Portal page at "/" is served; every other path is a real 404, decided here
// before any asset lookup (security finding P1, 16 Oct 2026).
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/index.html") return env.ASSETS.fetch(request);
    return new Response(
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Not found — Spring Renaissance</title></head><body><p>Not found.</p><p><a href="/">Private Client Portal</a></p></body></html>',
      { status: 404, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } },
    );
  },
};
