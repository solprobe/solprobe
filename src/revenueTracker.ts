import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { MiddlewareHandler } from "hono";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "../data");
const DB_PATH = join(DATA_DIR, "revenue.db");

const SERVICE_PRICES: Record<string, number> = {
  sol_quick_scan: 0.01,
  sol_wallet_risk: 0.02,
  sol_market_intel: 0.05,
  sol_deep_dive: 0.5,
};

const PATH_TO_SERVICE: Record<string, string> = {
  "/scan/quick": "sol_quick_scan",
  "/scan/deep": "sol_deep_dive",
  "/wallet/risk": "sol_wallet_risk",
  "/market/intel": "sol_market_intel",
};

mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS revenue_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    service       TEXT    NOT NULL,
    revenue_usdc  REAL    NOT NULL,
    timestamp     TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_service ON revenue_log(service);
`);

const insertStmt = db.prepare(
  "INSERT INTO revenue_log (service, revenue_usdc) VALUES (?, ?)"
);

const summaryStmt = db.prepare(
  `SELECT service,
          COUNT(*)          AS calls,
          SUM(revenue_usdc) AS revenue_usdc
   FROM revenue_log
   GROUP BY service`
);

const sinceStmt = db.prepare(
  "SELECT MIN(timestamp) AS since FROM revenue_log"
);

export function recordRevenue(service: string, amount: number): void {
  insertStmt.run(service, amount);
}

export function getRevenueSummary() {
  const rows = summaryStmt.all() as {
    service: string;
    calls: number;
    revenue_usdc: number;
  }[];

  const sinceRow = sinceStmt.get() as { since: string | null };

  const byService: Record<string, { calls: number; revenue_usdc: number }> = {
    sol_quick_scan: { calls: 0, revenue_usdc: 0 },
    sol_wallet_risk: { calls: 0, revenue_usdc: 0 },
    sol_market_intel: { calls: 0, revenue_usdc: 0 },
    sol_deep_dive: { calls: 0, revenue_usdc: 0 },
  };

  let totalUsdc = 0;

  for (const row of rows) {
    if (Object.prototype.hasOwnProperty.call(byService, row.service)) {
      byService[row.service] = {
        calls: row.calls,
        revenue_usdc: Math.round(row.revenue_usdc * 100) / 100,
      };
    }
    totalUsdc += row.revenue_usdc;
  }

  return {
    total_usdc: Math.round(totalUsdc * 100) / 100,
    by_service: byService,
    since: sinceRow?.since ?? new Date().toISOString(),
  };
}

// Hono middleware — records revenue after each successful scan response
export const revenueMiddleware: MiddlewareHandler = async (c, next) => {
  await next();

  const service = PATH_TO_SERVICE[c.req.path];
  if (service && c.res.status === 200) {
    const price = SERVICE_PRICES[service] ?? 0;
    recordRevenue(service, price);
  }
};
