import { isAvailable, recordSuccess, recordFailure } from "../circuitBreaker.js";
import { tryAcquire } from "../cache.js";
import { recordSourceResult } from "./resolver.js";

const BASE_URL = "https://api.rugcheck.xyz/v1/tokens";

export interface RugCheckSummary {
  mint_authority_revoked: boolean | null;
  freeze_authority_revoked: boolean | null;
  top_10_holder_pct: number | null;
  is_honeypot: boolean | null;
  has_rug_history: boolean;
}

interface RawRisk {
  name: string;
  value: string;
  description: string;
  score: number;
  level: string;
}

interface RawHolder {
  address: string;
  amount: number;
  decimals?: number;
  pct: number;
  uiAmount: number;
  uiAmountString: string;
}

interface RawReport {
  mint: string;
  score?: number;
  score_normalised?: number;
  risks?: RawRisk[];
  topHolders?: RawHolder[];
  mintAuthority?: string | null;
  freezeAuthority?: string | null;
  rugged?: boolean;
  token?: unknown;
}

export async function getRugCheckSummary(
  address: string,
  options: { timeout?: number } = {}
): Promise<RugCheckSummary | null> {
  if (!isAvailable("rugcheck")) return null;
  if (!tryAcquire("rugcheck")) return null;

  const timeout = options.timeout ?? 3000;
  const url = `${BASE_URL}/${address}/report`;
  const start = Date.now();

  let res: Response;
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(timeout),
      headers: { Accept: "application/json" },
    });
  } catch (err) {
    recordSourceResult("rugcheck", false, Date.now() - start);
    recordFailure("rugcheck");
    throw err;
  }

  // 400/404 = bad address — don't penalise the breaker, but return null
  if (res.status === 400 || res.status === 404) {
    return null;
  }

  if (!res.ok) {
    recordSourceResult("rugcheck", false, Date.now() - start);
    recordFailure("rugcheck");
    const err = new Error(`RugCheck HTTP ${res.status}`) as any;
    err.status = res.status;
    throw err;
  }

  const raw = (await res.json()) as RawReport;
  recordSourceResult("rugcheck", true, Date.now() - start);
  recordSuccess("rugcheck");

  // mint/freeze authority: null field means revoked (no authority set)
  const mint_authority_revoked =
    "mintAuthority" in raw ? raw.mintAuthority == null : null;
  const freeze_authority_revoked =
    "freezeAuthority" in raw ? raw.freezeAuthority == null : null;

  // Top-10 holder concentration: sum of top 10 pct values
  // RugCheck returns pct as 0–100
  let top_10_holder_pct: number | null = null;
  if (Array.isArray(raw.topHolders) && raw.topHolders.length > 0) {
    const top10 = raw.topHolders.slice(0, 10);
    top_10_holder_pct = Math.min(100, top10.reduce((sum, h) => sum + (h.pct ?? 0), 0));
  }

  // Honeypot: check risks array for a honeypot-named entry at danger level
  const risks = raw.risks ?? [];
  const is_honeypot =
    risks.some(
      (r) =>
        r.name?.toLowerCase().includes("honeypot") ||
        r.description?.toLowerCase().includes("honeypot")
    ) || false;

  // Rug history: explicit `rugged` flag
  const has_rug_history = raw.rugged === true;

  return {
    mint_authority_revoked,
    freeze_authority_revoked,
    top_10_holder_pct,
    is_honeypot,
    has_rug_history,
  };
}
