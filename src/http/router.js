// Minimal path router. A route is { method, path, handler, ...options }.
// Paths are literal segments or `:name` params. `match` answers two separate
// questions — "does any route own this path?" and "which one for this
// method?" — because the app needs the first to decide between the new API and
// the legacy worker, and the second to answer 405 rather than 404.

export function createRouter(routes) {
  const compiled = routes.map((r) => ({ ...r, segments: split(r.path) }));

  return {
    match(method, pathname) {
      const parts = split(pathname);
      const owners = [];
      for (const r of compiled) {
        const params = matchSegments(r.segments, parts);
        if (params) owners.push({ route: r, params });
      }
      if (owners.length === 0) return null;
      const hit = owners.find((o) => o.route.method === method)
        // HEAD is answered by the GET handler; the runtime drops the body.
        || (method === "HEAD" && owners.find((o) => o.route.method === "GET"))
        || null;
      return {
        route: hit ? hit.route : null,
        params: hit ? hit.params : {},
        allowed: [...new Set(owners.map((o) => o.route.method))],
      };
    },
  };
}

function split(path) {
  return path.split("/").filter(Boolean);
}

function matchSegments(pattern, parts) {
  if (pattern.length !== parts.length) return null;
  const params = {};
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i];
    if (p.startsWith(":")) {
      let value;
      try {
        value = decodeURIComponent(parts[i]);
      } catch {
        return null;
      }
      params[p.slice(1)] = value;
    } else if (p !== parts[i]) {
      return null;
    }
  }
  return params;
}
