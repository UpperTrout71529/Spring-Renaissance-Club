// Overview V1 (spec §15.2, S10): the Club metrics. V2 metrics (active
// members, churn, MRR, credits, …) join here once their tables exist.
//
// A range is [from, to) in ISO UTC. Definitions:
//   accounts.total          accounts not deleted, created before `to`
//   accounts.new_in_period  created in the range and not deleted since
//   logins                  `login_succeeded` events in the range
//   saved                   `wishlist_added` events in the range; members
//                           with at least one saved piece now
//   waitlist                `circle_waitlist_joined` in the range; open
//                           circle_waitlist places now
//   orders                  `order_placed` (Shopify orders/create) in the
//                           range; a buyer is a Shopify customer id
//   repeat_purchase_90d     buyers with 2+ orders in the 90 days ending at
//                           `to` / all buyers then. "Club" = the buyer had an
//                           account on at least one of those orders.
// Orders count only from the day the orders/create webhook is switched on,
// so the 90-day rate needs 90 days of history before it means anything.

import { badRequest } from "../http/errors.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DAYS = 30;
const MAX_DAYS = 366;
const REPEAT_WINDOW_DAYS = 90;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function dayStart(value) {
  if (!DATE_RE.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== value ? null : ms;
}

// ?from=YYYY-MM-DD&to=YYYY-MM-DD, both whole UTC days, `to` inclusive.
export function parseRange(params, nowMs) {
  const fromRaw = params.get("from");
  const toRaw = params.get("to");
  const today = Math.floor(nowMs / DAY_MS) * DAY_MS;
  const to = toRaw ? dayStart(toRaw) : today;
  const toEnd = to === null ? null : to + DAY_MS;
  const from = fromRaw ? dayStart(fromRaw) : toEnd === null ? null : toEnd - DEFAULT_DAYS * DAY_MS;
  if (from === null || toEnd === null || from >= toEnd || toEnd - from > MAX_DAYS * DAY_MS) {
    throw badRequest("invalid_range", "Choose a valid date range of up to a year.");
  }
  return { from: new Date(from).toISOString(), to: new Date(toEnd).toISOString() };
}

const pct = (part, whole) => (whole ? Math.round((part / whole) * 1000) / 10 : null);

// Monday of the week, as YYYY-MM-DD (SQLite: date(x, '-6 days', 'weekday 1')).
function mondayOf(ms) {
  const d = new Date(ms);
  const back = (d.getUTCDay() + 6) % 7;
  return new Date(Math.floor(ms / DAY_MS) * DAY_MS - back * DAY_MS).toISOString().slice(0, 10);
}

export async function computeMetrics(db, { from, to }) {
  const one = (sql, ...a) => db.prepare(sql).bind(...a).first();
  const all = (sql, ...a) => db.prepare(sql).bind(...a).all().then((r) => r.results);
  const windowFrom = new Date(Date.parse(to) - REPEAT_WINDOW_DAYS * DAY_MS).toISOString();

  const buyersSql = `
    WITH b AS (
      SELECT json_extract(props_json, '$.customer_id') AS customer, COUNT(*) AS n, MAX(user_id IS NOT NULL) AS acct
      FROM events
      WHERE name = 'order_placed' AND created_at >= ?1 AND created_at < ?2
        AND json_extract(props_json, '$.customer_id') IS NOT NULL
      GROUP BY customer
    )
    SELECT COUNT(*) AS buyers, COALESCE(SUM(n >= 2), 0) AS repeat_buyers, COALESCE(SUM(acct), 0) AS acct_buyers,
           COALESCE(SUM(acct AND n >= 2), 0) AS acct_repeat, COALESCE(SUM(n), 0) AS orders
    FROM b`;

  const [accounts, logins, saved, waitlist, period, window, weekAccounts, weekLogins, weekOrders] = await Promise.all([
    one(`SELECT COUNT(*) AS total, COALESCE(SUM(created_at >= ?1), 0) AS fresh,
                COALESCE(SUM(tier = 'club'), 0) AS club, COALESCE(SUM(tier = 'vip'), 0) AS vip
         FROM users WHERE deleted_at IS NULL AND created_at < ?2`, from, to),
    one(`SELECT COUNT(*) AS n, COUNT(DISTINCT user_id) AS members,
                COALESCE(SUM(json_extract(props_json, '$.method') = 'passkey'), 0) AS passkey
         FROM events WHERE name = 'login_succeeded' AND created_at >= ?1 AND created_at < ?2`, from, to),
    one(`SELECT (SELECT COUNT(*) FROM events WHERE name = 'wishlist_added' AND created_at >= ?1 AND created_at < ?2) AS added,
                (SELECT COUNT(DISTINCT w.user_id) FROM wishlist_items w JOIN users u ON u.id = w.user_id
                 WHERE u.deleted_at IS NULL) AS members`, from, to),
    one(`SELECT (SELECT COUNT(*) FROM events WHERE name = 'circle_waitlist_joined' AND created_at >= ?1 AND created_at < ?2) AS joined,
                (SELECT COUNT(*) FROM holds WHERE kind = 'circle_waitlist' AND status = 'open') AS total`, from, to),
    one(buyersSql, from, to),
    one(buyersSql, windowFrom, to),
    all(`SELECT date(created_at, '-6 days', 'weekday 1') AS wk, COUNT(*) AS n FROM users
         WHERE deleted_at IS NULL AND created_at >= ?1 AND created_at < ?2 GROUP BY wk`, from, to),
    all(`SELECT date(created_at, '-6 days', 'weekday 1') AS wk, COUNT(*) AS n FROM events
         WHERE name = 'login_succeeded' AND created_at >= ?1 AND created_at < ?2 GROUP BY wk`, from, to),
    all(`SELECT date(created_at, '-6 days', 'weekday 1') AS wk, COUNT(*) AS n FROM events
         WHERE name = 'order_placed' AND created_at >= ?1 AND created_at < ?2 GROUP BY wk`, from, to),
  ]);

  const byWeek = (rows) => new Map(rows.map((r) => [r.wk, r.n]));
  const [wa, wl, wo] = [byWeek(weekAccounts), byWeek(weekLogins), byWeek(weekOrders)];
  const weekly = [];
  for (let ms = Date.parse(`${mondayOf(Date.parse(from))}T00:00:00.000Z`); ms < Date.parse(to); ms += 7 * DAY_MS) {
    const wk = new Date(ms).toISOString().slice(0, 10);
    weekly.push({ week_start: wk, new_accounts: wa.get(wk) || 0, logins: wl.get(wk) || 0, orders: wo.get(wk) || 0 });
  }

  const rate = (buyers, repeat) => ({ buyers, repeat, rate_pct: pct(repeat, buyers) });
  return {
    range: { from, to },
    accounts: { total: accounts.total, new_in_period: accounts.fresh, club: accounts.club, vip: accounts.vip },
    logins: { count: logins.n, unique_members: logins.members, by_passkey: logins.passkey },
    saved: { added_in_period: saved.added, members_with_saved: saved.members },
    waitlist: { joined_in_period: waitlist.joined, total: waitlist.total },
    orders: { count: period.orders, buyers: period.buyers, buyers_with_account_pct: pct(period.acct_buyers, period.buyers) },
    repeat_purchase_90d: {
      window_from: windowFrom, window_to: to,
      all: rate(window.buyers, window.repeat_buyers),
      club: rate(window.acct_buyers, window.acct_repeat),
      no_account: rate(window.buyers - window.acct_buyers, window.repeat_buyers - window.acct_repeat),
    },
    weekly,
  };
}
