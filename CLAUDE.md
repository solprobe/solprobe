# SolProbe — Claude Code Instructions

## Project Status

SolProbe is a **live** Solana token scanner agent on the Virtuals Protocol ACP marketplace.
- Agent ID: #24456 — Chain: Base (Ethereum L2) — Ticker: SPROBE (Pegasus launch)
- Agent wallet: `0xbCcc964d5748C1601059853a38a8D3f424e7193E`
- All 4 services registered and operational
- Scanner backend: `/root/solprobe` — ACP seller runtime: `/root/virtuals-acp`
- Both processes managed by PM2. Do not touch production unless explicitly asked.

---

## Project Vision

SolProbe sells 4 tiered Solana token intelligence services to other AI agents on the
Virtuals Protocol ACP marketplace. Revenue comes from per-call USDC fees and a SPROBE
token flywheel. First-mover advantage on Solana within ACP is the core opportunity.

---

## Language & Stack

TypeScript throughout. Node.js 22+, ESM modules.

- **Hono** — HTTP service layer on port 8000
- **Node.js native `fetch`** — all async HTTP, no extra deps
- **`Promise.allSettled()`** — parallel source fetching with per-source fault isolation
- **`@solana/web3.js` + `@solana/spl-token`** — on-chain data
- **ACP integration** — OpenClaw runtime at `/root/virtuals-acp`

---

## Available Skills
- cost-aware-llm-pipeline: routing scan requests to model tier
- autonomous-loops: building service pipeline chains
- api-design: ACP-facing service endpoints
- search-first: before any on-chain data analysis

---

## Services

| Service | Price | SLA | LLM call |
|---|---|---|---|
| `sol_quick_scan` | $0.02 | < 5s | Haiku — `summary` field only |
| `sol_wallet_risk` | $0.02 | < 10s | None — deterministic output |
| `sol_market_intel` | $0.05 | < 10s | None — deterministic output |
| `sol_deep_dive` | $0.50 | < 30s | Sonnet — `full_risk_report` only |

---

## Project Structure

```
solprobe/
├── src/
│   ├── scanner/
│   │   ├── quickScan.ts
│   │   ├── deepDive.ts
│   │   ├── walletRisk.ts
│   │   ├── marketIntel.ts
│   │   └── riskScorer.ts
│   ├── sources/
│   │   ├── dexscreener.ts
│   │   ├── rugcheck.ts
│   │   ├── helius.ts           # includes getTokenMintInfo()
│   │   ├── birdeye.ts
│   │   ├── solscan.ts
│   │   ├── resolver.ts         # weighted source resolver
│   │   └── jupiterTokenList.ts # authority exemption via Jupiter strict list
│   ├── api/
│   │   ├── server.ts
│   │   └── rateLimiter.ts      # inbound per-IP rate limiter
│   ├── llm/
│   │   └── narrativeEngine.ts  # Haiku/Sonnet prose generation
│   ├── utils/
│   │   └── retry.ts
│   ├── circuitBreaker.ts
│   ├── validate.ts
│   ├── cache.ts
│   └── constants.ts            # PROGRAMS, Virtuals protocol addresses
├── scripts/
│   ├── revenueTracker.ts
│   ├── buyback.ts
│   └── healthWatchdog.ts
├── tests/
│   ├── quickScan.test.ts
│   ├── deepDive.test.ts
│   ├── sources.test.ts
│   └── circuitBreaker.test.ts
├── package.json
├── tsconfig.json
├── .env
├── ecosystem.config.cjs
└── start.sh
```

---

## Response Shapes

### `sol_quick_scan`
```typescript
{
  is_honeypot: boolean;
  mint_authority_revoked: boolean;       // Helius only — always live on-chain
  freeze_authority_revoked: boolean;     // Helius only — always live on-chain
  top_10_holder_pct: number | null;      // Helius only — always live on-chain
  liquidity_usd: number | null;
  risk_grade: "A" | "B" | "C" | "D" | "F";
  summary: string;                       // LLM (Haiku) or deterministic fallback
  authority_exempt: boolean;             // true if Jupiter strict list exempts this token
  authority_exempt_reason: string | null; // why authority penalties were skipped
  rugcheck_report_age_seconds: number | null;
  data_confidence: "HIGH" | "MEDIUM" | "LOW";
}
```

### `sol_deep_dive`
```typescript
{
  // all quick_scan fields, plus:
  authority_exempt: boolean;             // inherited from quick_scan fields
  authority_exempt_reason: string | null;
  dev_wallet_analysis: {
    address: string;
    is_protocol_address?: boolean;       // true if Virtuals protocol address
    sol_balance: number | null;
    created_tokens_count: number | null;
    previous_rugs: boolean;
  };
  liquidity_lock_status: {
    locked: boolean;
    lock_duration_days: number;
    locked_pct: number;
  };
  trading_pattern: {
    buy_sell_ratio_1h: number;
    unique_buyers_24h: number;
    wash_trading_score: number;          // 0–100
  };
  pump_fun_launched: boolean;
  bundled_launch_detected: boolean;      // RugCheck
  volume_24h: number;
  price_change_24h_pct: number;
  momentum_score: number;               // 0–100, on-chain signals only — no social API
  full_risk_report: string;             // LLM (Sonnet) or deterministic fallback
  recommendation: "BUY" | "AVOID" | "WATCH" | "DYOR";
  rugcheck_report_age_seconds: number | null;
  data_confidence: "HIGH" | "MEDIUM" | "LOW";
}
```

### `sol_wallet_risk`
```typescript
{
  wallet_age_days: number;
  total_transactions: number;
  is_bot: boolean;
  rug_involvement_count: number;
  whale_status: boolean;
  risk_score: number;                   // 0–100
  trading_style: "sniper" | "hodler" | "flipper" | "bot" | "unknown";
  data_confidence: "HIGH" | "MEDIUM" | "LOW";
}
```

### `sol_market_intel`
```typescript
{
  current_price_usd: number;
  price_change_1h_pct: number;
  price_change_24h_pct: number;
  volume_1h_usd: number;
  volume_24h_usd: number;
  liquidity_usd: number;
  buy_pressure: "HIGH" | "MEDIUM" | "LOW";
  sell_pressure: "HIGH" | "MEDIUM" | "LOW";
  large_txs_last_hour: number;          // txs > $10k
  signal: "BULLISH" | "BEARISH" | "NEUTRAL";
  data_confidence: "HIGH" | "MEDIUM" | "LOW";
}
```

---

## Input Validation (`src/validate.ts`)

Always validate before hitting any external API.

```typescript
import { PublicKey } from "@solana/web3.js";

export function isValidSolanaAddress(address: string): boolean {
  if (typeof address !== "string") return false;
  if (address.length < 32 || address.length > 44) return false;
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

export function isValidSolanaWallet(address: string): boolean {
  return isValidSolanaAddress(address);
}
```

All four ACP handlers and all four Hono endpoints must call `isValidSolanaAddress()`
before any downstream work. Return HTTP 400 immediately on failure:

```typescript
app.post("/scan/quick", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || !isValidSolanaAddress(body?.token_address)) {
    return c.json(
      { error: "INVALID_ADDRESS", message: "token_address must be a valid Solana base58 address (32–44 chars)", data_confidence: "LOW" },
      400
    );
  }
  // scanner logic...
});
```

For `sol_wallet_risk` the field is `wallet_address` — adjust the message accordingly.
Never return 500 for a bad address. The review team explicitly tests rejection behaviour.

---

## Source Responsibility Split

Each source owns specific fields exclusively. No field is fetched from two sources
and merged. This eliminates the RugCheck cache staleness problem entirely for
safety-critical fields.

```
┌─────────────────────────────────────────────────────────────┐
│  HELIUS — live on-chain, always fresh (~400ms)              │
│                                                             │
│  mint_authority_revoked     ← getAccountInfo (MintLayout)   │
│  freeze_authority_revoked   ← getAccountInfo (MintLayout)   │
│  top_10_holder_pct          ← getTokenLargestAccounts       │
│  dev_wallet_address         ← getAsset (Metaplex DAS)       │
│  dev_wallet_sol_balance     ← getBalance                    │
│  pump_fun_launched          ← creator program ID check      │
│  token_age_days             ← first tx signature            │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  RUGCHECK — historical pattern data, staleness acceptable   │
│                                                             │
│  has_rug_history            ← cross-token flagged DB        │
│  bundled_launch_detected    ← proprietary launch analysis   │
│  rugcheck_risk_score        ← their aggregate score         │
│  insider_flags              ← insider trading detection     │
│  report_age_seconds         ← tracked for confidence only   │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  DEXSCREENER — market data (Birdeye as fallback)            │
│                                                             │
│  liquidity_usd    price_usd    volume_24h                   │
│  price_change_24h_pct    buy_sell_ratio    large_txs        │
└─────────────────────────────────────────────────────────────┘
```

RugCheck staleness is acceptable for its owned fields because rug history,
bundled launches, and insider flags are historical events — they do not change
after the fact. The RugCheck paid tier (fresh reports, websocket stream) is
currently listed as "coming soon" and is not available.

---

## Helius: Authority Flags (`src/sources/helius.ts`)

Add `getTokenMintInfo()` if not already present. This is the canonical implementation
for authority checks — called on every scan, unconditionally.

```typescript
import { Connection, PublicKey } from "@solana/web3.js";
import { MintLayout } from "@solana/spl-token";

export async function getTokenMintInfo(
  mintAddress: string,
  connection: Connection
): Promise<{ mint_authority_revoked: boolean; freeze_authority_revoked: boolean } | null> {
  try {
    const pubkey = new PublicKey(mintAddress);
    const info = await connection.getAccountInfo(pubkey, { commitment: "confirmed" });
    if (!info || info.data.length < MintLayout.span) return null;
    const mint = MintLayout.decode(info.data);
    return {
      mint_authority_revoked: !mint.mintAuthorityOption,
      freeze_authority_revoked: !mint.freezeAuthorityOption,
    };
  } catch {
    return null;
  }
}
```

Use the Helius RPC URL from `process.env.SOLANA_RPC_URL`. Wrap with the existing
RPC rotation logic. On null return, default both flags to `false` (conservative —
not revoked). Never default to `true`.

The `RugCheckResult` interface must NOT contain `mint_authority_revoked` or
`freeze_authority_revoked`. These fields must never come from RugCheck.

---

## Jupiter Token List (`src/sources/jupiterTokenList.ts`)

The Jupiter verified token list is the authoritative source for identifying tokens
with legitimately retained authorities — stablecoins, wrapped assets, and bridge
tokens. This replaces any static token whitelist. The list is fetched once at
startup and refreshed every 24 hours in the background.

**Why Jupiter:** Actively maintained by the most authoritative source in Solana
DeFi, covers thousands of verified tokens, has semantic tags built in, and
requires no guesswork. USDC, USDT, wETH, wBTC, mSOL, JitoSOL and any future
verified tokens are handled automatically without manual list maintenance.

**API details:**
- Endpoint: `https://lite-api.jup.ag/tokens/v2/tag?query=verified`
- No API key required — free public endpoint
- Response: array of token objects where each token has `id` (the mint address),
  `symbol`, `name`, `tags[]`
- The v2 API uses `id` not `address` for the mint — important for map population

**Confirmed working tags in v2 response (verified from live API):**

| Tag | Meaning | In EXEMPT_TAGS |
|---|---|---|
| `"stable"` | Stablecoins (USDC, USDT etc) — primary tag in v2 | ✅ yes |
| `"stablecoin"` | Legacy tag — seed list compatibility | ✅ yes |
| `"wormhole"` | Wormhole bridge-wrapped assets | ✅ yes |
| `"wrapped"` | Other wrapped assets and liquid staking tokens | ✅ yes |
| `"verified"` | Jupiter identity verification — applies to memecoins too | ❌ NO |
| `"strict"` | Jupiter strict list membership — applies to memecoins too | ❌ NO |
| `"community"` | Community-submitted token | ❌ NO |

> **Critical:** `"verified"` and `"strict"` must NEVER be in EXEMPT_TAGS.
> These tags confirm a token's identity but say nothing about whether retained
> authority is legitimate. BONK, WIF, and thousands of memecoins carry these
> tags — including them incorrectly exempts memecoins from authority penalties,
> which are the most important safety signal SolProbe provides.
>
> Only `"stable"`, `"stablecoin"`, `"wormhole"`, and `"wrapped"` indicate that
> retained mint/freeze authority is by institutional design rather than rug risk.

```typescript
// src/sources/jupiterTokenList.ts

interface JupiterToken {
  address: string;
  symbol: string;
  name: string;
  tags: string[];
}

// Tags that indicate legitimately retained authority — not a rug risk
// "verified" and "strict" intentionally excluded — they apply to memecoins like BONK
const EXEMPT_TAGS = new Set([
  "stable",       // v2 API tag for stablecoins (USDC, USDT etc)
  "stablecoin",   // seed list compatibility
  "wormhole",     // Wormhole-wrapped assets
  "wrapped",      // other wrapped assets and liquid staking
]);

const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Seed list — always populated at module load, no network cost
// Ensures known majors work even if the Jupiter API fetch fails
const SEED_LIST: JupiterToken[] = [
  { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC",    name: "USD Coin",           tags: ["stablecoin"] },
  { address: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",  symbol: "USDT",    name: "Tether USD",          tags: ["stablecoin"] },
  { address: "USDH1SM1ojwWUga67PGrgFWUHibbjqMvuMaDkRJTgkX",   symbol: "USDH",    name: "USDH",                tags: ["stablecoin"] },
  { address: "UXPhBoR3qG4UCiGNJfV7MqhHyFqKN68g45GoYvAeL2m",  symbol: "UXD",     name: "UXD Stablecoin",      tags: ["stablecoin"] },
  { address: "So11111111111111111111111111111111111111112",    symbol: "SOL",     name: "Wrapped SOL",         tags: ["wrapped"] },
  { address: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs",  symbol: "WETH",    name: "Wrapped Ether",       tags: ["wormhole"] },
  { address: "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh",  symbol: "WBTC",    name: "Wrapped Bitcoin",     tags: ["wormhole"] },
  { address: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",  symbol: "mSOL",    name: "Marinade staked SOL", tags: ["wrapped"] },
  { address: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",  symbol: "JitoSOL", name: "Jito Staked SOL",     tags: ["wrapped"] },
  { address: "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1",   symbol: "bSOL",    name: "BlazeStake SOL",      tags: ["wrapped"] },
];

// Populate from seed at module load — synchronous, zero network cost
let tokenMap = new Map<string, JupiterToken>();
for (const t of SEED_LIST) tokenMap.set(t.address, t);
console.info(`[jupiter] seed list loaded (${tokenMap.size} tokens)`);

let lastFetched = 0;

export async function loadJupiterTokenList(): Promise<void> {
  try {
    const res = await fetch(
      "https://lite-api.jup.ag/tokens/v2/tag?query=verified",
      { signal: AbortSignal.timeout(10_000) }
    );
    if (!res.ok) throw new Error(`Jupiter list HTTP ${res.status}`);

    // v2 response: array of objects with "id" (mint address), not "address"
    const tokens: Array<{ id: string; name: string; symbol: string; tags: string[] }> =
      await res.json();

    // Merge fetched tokens on top of seed — API wins on conflict
    // Seed entries remain even if the API fetch fails
    for (const t of tokens) {
      tokenMap.set(t.id, {
        address: t.id,
        name: t.name,
        symbol: t.symbol,
        tags: t.tags ?? [],
      });
    }

    lastFetched = Date.now();
    console.info(`[jupiter] loaded ${tokenMap.size} tokens (API + seed)`);
  } catch (err) {
    console.warn("[jupiter] fetch failed — serving from seed list only", err);
  }
}

export async function ensureFresh(): Promise<void> {
  if (Date.now() - lastFetched > REFRESH_INTERVAL_MS) {
    await loadJupiterTokenList();
  }
}

export function isAuthorityExempt(address: string): boolean {
  const token = tokenMap.get(address);
  if (!token) return false;
  return token.tags.some(tag => EXEMPT_TAGS.has(tag));
}

export function getExemptReason(address: string): string | null {
  const token = tokenMap.get(address);
  if (!token) return null;
  const matchedTag = token.tags.find(tag => EXEMPT_TAGS.has(tag));
  if (!matchedTag) return null;
  const reasons: Record<string, string> = {
    stable:     `${token.symbol} is a verified stablecoin — mint authority retained by regulated issuer`,
    stablecoin: `${token.symbol} is a verified stablecoin — mint authority retained by regulated issuer`,
    wormhole:   `${token.symbol} is a Wormhole-wrapped asset — authority retained by bridge program`,
    wrapped:    `${token.symbol} is a wrapped asset — authority retained by wrapping protocol`,
  };
  return reasons[matchedTag] ?? `${token.symbol} is a verified token with legitimate retained authority`;
}
```

**On fetch failure:** the seed list remains in the map and all known majors
continue to work. The API fetch is additive — it never clears the seed.

**Integration in `src/api/server.ts`:**

Load at startup (fire-and-forget — does not block server start):
```typescript
import { loadJupiterTokenList, ensureFresh } from "../sources/jupiterTokenList.js";

loadJupiterTokenList().catch(err =>
  console.warn("[startup] Jupiter token list unavailable:", err)
);
```

Call `ensureFresh()` inside the `/health` endpoint so the list refreshes
automatically every 24h without a server restart:
```typescript
app.get("/health", async (c) => {
  await ensureFresh();
  // ... rest of handler unchanged
});
```

**Integration in `src/scanner/riskScorer.ts`:**

Check `isAuthorityExempt()` before applying authority penalties. Only these
two penalties are bypassed for exempt tokens:
- `mint_authority_revoked === false`: skip the -25 penalty
- `freeze_authority_revoked === false`: skip the -15 penalty

All other penalties still apply (concentration, liquidity, bundled launch, etc).

```typescript
import { isAuthorityExempt } from "../sources/jupiterTokenList.js";

export function calculateRiskScore(factors: RiskFactors, tokenAddress?: string) {
  const exempt = tokenAddress ? isAuthorityExempt(tokenAddress) : false;
  let score = 100;

  // Authority penalties — skipped for exempt tokens (stablecoins, wrapped assets)
  if (!exempt) {
    if (!factors.mint_authority_revoked)  score -= 25;
    if (!factors.freeze_authority_revoked) score -= 15;
  }

  // All other penalties apply regardless of exempt status
  // ... concentration, liquidity, bundled launch, etc
}
```

**Integration in `src/scanner/quickScan.ts` and `src/scanner/deepDive.ts`:**

```typescript
import { isAuthorityExempt, getExemptReason } from "../sources/jupiterTokenList.js";

const exempt = isAuthorityExempt(address);
const exemptReason = getExemptReason(address);

// Include in response
const result = {
  ...scanData,
  authority_exempt: exempt,
  authority_exempt_reason: exemptReason,
};

// Include in LLM prompt so narrative reflects it correctly
const llmInput = {
  ...result,
  ...(exempt ? { note: `This token is authority-exempt: ${exemptReason}` } : {}),
};
```

---

## Parallel Data Fetching

All sources must be fetched in parallel. Never make sequential calls.
Use `Promise.allSettled()` — never `Promise.all()`.
Every source call must have its own `AbortSignal.timeout()`.

### Per-source timeout budget

| Source | Timeout | Notes |
|---|---|---|
| DexScreener | 4000ms | Usually <500ms |
| RugCheck | 3000ms | Can be slow |
| Helius/RPC | 3000ms | Wraps RPC rotation |
| Birdeye | 4000ms | Fallback only |
| Solscan | 4000ms | Fallback only |

### Pattern

```typescript
async function fetchQuickScanData(address: string) {
  const results = await Promise.allSettled([
    dexscreener.getToken(address, { timeout: 4000 }),
    rugcheck.getSummary(address, { timeout: 3000 }),
    helius.getTokenMintInfo(address, { timeout: 3000 }),  // always runs
    helius.getTopHolders(address, { timeout: 3000 }),     // always runs
  ]);

  const [dexResult, rugResult, mintResult, holdersResult] = results;

  // Log any failures
  if (dexResult.status === "rejected") logError("dexscreener", dexResult.reason, address);
  if (rugResult.status === "rejected") logError("rugcheck", rugResult.reason, address);
  if (mintResult.status === "rejected") logError("helius_rpc", mintResult.reason, address);

  const dexData     = dexResult.status === "fulfilled" ? dexResult.value : null;
  const rugData     = rugResult.status === "fulfilled" ? rugResult.value : null;
  const mintData    = mintResult.status === "fulfilled" ? mintResult.value : null;
  const holdersData = holdersResult.status === "fulfilled" ? holdersResult.value : null;

  // Authority flags — Helius only, conservative default on null
  const mint_authority_revoked  = mintData?.mint_authority_revoked  ?? false;
  const freeze_authority_revoked = mintData?.freeze_authority_revoked ?? false;
}
```

---

## In-Flight Request Deduplication (`src/cache.ts`)

```typescript
const inFlight = new Map<string, Promise<any>>();

export async function deduplicate<T>(key: string, fn: () => Promise<T>): Promise<T> {
  if (inFlight.has(key)) return inFlight.get(key)! as Promise<T>;
  const promise = fn().finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}
```

Usage:
```typescript
const cacheKey = `quick:${address}`;
return deduplicate(cacheKey, () => cache.getOrFetch(cacheKey, () => fetchQuickScanData(address)));
```

---

## Circuit Breaker (`src/circuitBreaker.ts`)

After 5 consecutive failures, fail-fast for 60 seconds before retrying.

```typescript
type SourceName = "dexscreener" | "rugcheck" | "helius_rpc" | "birdeye" | "solscan";

const FAILURE_THRESHOLD = 5;
const COOLDOWN_MS = 60_000;

export function isAvailable(source: SourceName): boolean { ... }
export function recordSuccess(source: SourceName): void { ... }
export function recordFailure(source: SourceName): void { ... }
```

Every source client wraps its fetch:
```typescript
if (!isAvailable("dexscreener")) return null;
try {
  const data = await fetchWithTimeout(url, 4000);
  recordSuccess("dexscreener");
  return data;
} catch (err) {
  recordFailure("dexscreener");
  throw err;
}
```

---

## Error Handling Rules

- Never return an error to the calling agent. Always return a degraded but valid response.
- `recommendation` in `sol_deep_dive` must never be undefined — default to `"DYOR"` on LOW confidence.
- Log all API failures to `errors.log`: timestamp, source, status_code, token_address, error_message.
- Log every job to `jobs.log`: timestamp, service, address, response_time_ms, data_confidence, sources_used.
- Treat null authority flags as not-revoked (worst-case / most conservative).

---

## Caching & Rate Limiting (`src/cache.ts`)

### Per-service TTLs

| Service | TTL | Rationale |
|---|---|---|
| `sol_quick_scan` | 30s | Memecoin focus — tighter staleness budget |
| `sol_market_intel` | 15s | Signals product — tightest staleness |
| `sol_wallet_risk` | 300s | Wallet history is slow-moving |
| `sol_deep_dive` | 60s | Expensive to recompute |

```typescript
export const CACHE_TTL: Record<string, number> = {
  sol_quick_scan:   30_000,
  sol_market_intel: 15_000,
  sol_wallet_risk:  300_000,
  sol_deep_dive:    60_000,
};
```

Cache key: `{service}:{address}`. Never share cache entries across services.

### Outbound token bucket limits (self-implemented)

| Source | Limit |
|---|---|
| DexScreener | 300 req/min |
| RugCheck | 100 req/min |

Fail immediately when bucket is empty — do not queue or wait.

---

## Inbound Rate Limiter (`src/api/rateLimiter.ts`)

Per-IP continuous token bucket. Applied to all scanner routes, not to `/health`.

```typescript
const buckets = new Map<string, { tokens: number; last: number }>();
const RATE_LIMIT = 60;
const WINDOW_MS  = 60_000;

export function checkRateLimit(ip: string): boolean {
  const now    = Date.now();
  const bucket = buckets.get(ip) ?? { tokens: RATE_LIMIT, last: now };
  const elapsed = now - bucket.last;
  bucket.tokens = Math.min(RATE_LIMIT, bucket.tokens + (elapsed / WINDOW_MS) * RATE_LIMIT);
  bucket.last = now;
  if (bucket.tokens < 1) { buckets.set(ip, bucket); return false; }
  bucket.tokens -= 1;
  buckets.set(ip, bucket);
  if (buckets.size > 10_000) buckets.clear();
  return true;
}
```

Middleware order in `server.ts` — strictly in this order:
1. Body size cap (`app.use("*")`) — 1024 byte limit, returns 413
2. Rate limiter (`app.use("/scan/*")`, `/wallet/*`, `/market/*`) — returns 429
3. Route handlers

---

## RPC Rotation & Retry Logic (`src/sources/helius.ts`)

```typescript
const RPC_ENDPOINTS = [
  process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com",
  "https://rpc.ankr.com/solana",
  "https://api.mainnet-beta.solana.com",
] as const;
```

- Max 3 retries, rotating endpoints on each attempt
- Delays: 500ms → 1000ms → 2000ms (exponential)
- Respect `Retry-After` header on 429 (capped at 5s)
- Do not retry on 400/404 — invalid address, not transient

---

## Retry Logic (`src/utils/retry.ts`)

Used by all four ACP handlers. Retry up to 3 times before returning any error.

```typescript
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: { attempts?: number; delayMs?: number; backoff?: "linear" | "exponential"; label?: string } = {}
): Promise<T> {
  const { attempts = 3, delayMs = 400, backoff = "exponential", label = "operation" } = options;
  let lastError: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const wait = backoff === "exponential" ? delayMs * 2 ** (i - 1) : delayMs * i;
      console.warn(`[retry] ${label} attempt ${i}/${attempts} failed — waiting ${wait}ms`);
      if (i < attempts) await new Promise(res => setTimeout(res, wait));
    }
  }
  throw lastError;
}
```

---

## Weighted Source Resolver (`src/sources/resolver.ts`)

Tracks rolling success rates and re-ranks sources every 100 requests.

```typescript
type SourceName = "dexscreener" | "rugcheck" | "helius" | "birdeye" | "solscan";

interface SourceStats {
  priority: number;
  successRate: number;
  avgLatencyMs: number;
  totalCalls: number;
  failures: number;
}

const SOURCE_STATS: Record<SourceName, SourceStats> = {
  dexscreener: { priority: 1, successRate: 0.97, avgLatencyMs: 800,  totalCalls: 0, failures: 0 },
  rugcheck:    { priority: 2, successRate: 0.94, avgLatencyMs: 1200, totalCalls: 0, failures: 0 },
  helius:      { priority: 3, successRate: 0.91, avgLatencyMs: 400,  totalCalls: 0, failures: 0 },
  birdeye:     { priority: 4, successRate: 0.88, avgLatencyMs: 1100, totalCalls: 0, failures: 0 },
  solscan:     { priority: 5, successRate: 0.85, avgLatencyMs: 900,  totalCalls: 0, failures: 0 },
};

export function recordSourceResult(source: SourceName, success: boolean, latencyMs: number): void {
  const s = SOURCE_STATS[source];
  s.totalCalls++;
  if (!success) s.failures++;
  s.avgLatencyMs = s.avgLatencyMs * 0.9 + latencyMs * 0.1;
  if (s.totalCalls % 100 === 0) s.successRate = 1 - s.failures / s.totalCalls;
}

export function rankSources(candidates?: SourceName[]): SourceName[] {
  const pool = candidates ?? (Object.keys(SOURCE_STATS) as SourceName[]);
  return [...pool].sort((a, b) => SOURCE_STATS[b].successRate - SOURCE_STATS[a].successRate);
}

export function getSourceStats(): Record<SourceName, SourceStats> {
  return { ...SOURCE_STATS };
}
```

Call `recordSourceResult()` in every source client after each fetch.

---

## Risk Scorer (`src/scanner/riskScorer.ts`)

Deterministic, no ML. Score starts at 100, penalties subtracted. `has_rug_history`
is an instant F regardless of score.

### Penalty table

Penalties marked **[exempt skip]** are bypassed entirely for authority-exempt tokens
(stablecoins and wrapped assets identified by Jupiter tags). All other
penalties apply regardless of exempt status.

| Condition | Penalty | Exempt skip |
|---|---|---|
| `mint_authority_revoked === false` or null | -25 | ✅ yes |
| `freeze_authority_revoked === false` or null | -15 | ✅ yes |
| `top_10_holder_pct > 95%` or null | -35 | ✅ yes |
| `top_10_holder_pct > 80%` | -20 | ✅ yes |
| `liquidity_usd < $1k` or null | -35 | ❌ no |
| `liquidity_usd < $10k` | -20 | ❌ no |
| `bundled_launch === true` | -20 | ❌ no |
| `buy_sell_ratio < 0.5` | -10 | ❌ no |
| `token_age_days === null` | -10 | ❌ no |
| `token_age_days < 1` | -15 | ❌ no |

**Why concentration is also exempt-skipped:** For stablecoins and wrapped assets,
large holdings by institutional custodians (Circle treasury, Tether reserves, bridge
programs) are by design and carry no rug risk. When `top_10_holder_pct` is null for
USDC (Helius cannot meaningfully rank billions of micro-accounts), the null-defaults-
to-100% worst-case assumption is incorrect and produces a misleading grade.

**Implementation:**

```typescript
export function calculateRiskGrade(factors: RiskFactors, exempt: boolean = false): RiskGrade {
  if (factors.has_rug_history) return "F";

  let score = 100;

  // Authority penalties — skipped for exempt tokens
  if (!exempt) {
    if (!factors.mint_authority_revoked)  score -= 25;
    if (!factors.freeze_authority_revoked) score -= 15;
  }

  // Concentration penalty — skipped for exempt tokens
  // Stablecoin/wrapped asset reserves held by custodians are not rug risk
  if (!exempt) {
    const holderPct = factors.top_10_holder_pct ?? 100;
    if (holderPct > 95) score -= 35;
    else if (holderPct > 80) score -= 20;
  }

  // Liquidity penalties — always apply
  const liq = factors.liquidity_usd ?? 0;
  if (liq < 1_000) score -= 35;
  else if (liq < 10_000) score -= 20;

  // Launch and trading penalties — always apply
  if (factors.bundled_launch) score -= 20;
  if (factors.buy_sell_ratio !== null && factors.buy_sell_ratio < 0.5) score -= 10;

  // Age penalties — always apply
  if (factors.token_age_days === null) score -= 10;
  else if (factors.token_age_days < 1) score -= 15;

  // Grade bands
  if (score >= 80) return "A";
  if (score >= 60) return "B";
  if (score >= 40) return "C";
  if (score >= 20) return "D";
  return "F";
}
```

### Grade bands
80–100 → A | 60–79 → B | 40–59 → C | 20–39 → D | 0–19 → F | rug history → F

### Confidence scoring

```typescript
export function scoreConfidence(
  sources: string[],
  dataAgeMs: number,
  rugCheckAgeSeconds?: number
): "HIGH" | "MEDIUM" | "LOW" {
  const corroborated = sources.length >= 2;
  const fresh = dataAgeMs < 60_000;
  // RugCheck age only caps deep_dive (bundled, insider fields)
  // Authority flags now come from Helius — not affected by RugCheck staleness
  const historicalDataStale = rugCheckAgeSeconds !== undefined && rugCheckAgeSeconds > 86_400;

  if (historicalDataStale) return "MEDIUM";
  if (corroborated && fresh) return "HIGH";
  if (corroborated || fresh) return "MEDIUM";
  return "LOW";
}
```

---

## LLM Narrative Engine (`src/llm/narrativeEngine.ts`)

Only `sol_quick_scan` and `sol_deep_dive` get LLM calls.
`sol_wallet_risk` and `sol_market_intel` produce deterministic structured outputs — no LLM.

The LLM receives the fully assembled, scored result. All data collection and grading
happens first. The LLM only converts the result into analyst-quality prose.

### Provider cascade

Failures fall through in order. The deterministic template is the last resort, not
the first fallback. A $0.50 deep dive returning a two-sentence template is not
acceptable — the cascade exists to prevent that.

```
Anthropic (primary) → Groq (fallback) → deterministic template (last resort)
```

Quality hierarchy by tier:
```
Sonnet 4.6 > Mixtral 8x7B > Haiku > Llama 3.1 8B > template
```

Groq is chosen as the fallback provider because it is free, has an
OpenAI-compatible API, and has the fastest inference of any free provider
(~600 tokens/second). Ollama on the VPS is not viable — the CCX23 has no GPU
and a quantised 7B model on CPU takes 3–8s, which blows both SLAs.

### Full implementation

```typescript
// src/llm/narrativeEngine.ts

interface Provider {
  name: string;
  baseUrl: string;
  apiKey: () => string;
  models: { fast: string; deep: string };
  format: "anthropic" | "openai";
}

const PROVIDERS: Provider[] = [
  {
    name: "anthropic",
    baseUrl: "https://api.anthropic.com/v1/messages",
    apiKey: () => process.env.ANTHROPIC_API_KEY ?? "",
    models: {
      fast: "claude-haiku-4-5-20251001",
      deep: "claude-sonnet-4-6",
    },
    format: "anthropic",
  },
  {
    name: "groq",
    baseUrl: "https://api.groq.com/openai/v1/chat/completions",
    apiKey: () => process.env.GROQ_API_KEY ?? "",
    models: {
      fast: "llama-3.1-8b-instant",  // fast enough for one-sentence summary
      deep: "mixtral-8x7b-32768",    // stronger reasoning for deep dive
    },
    format: "openai",
  },
];

const QUICK_SCAN_SYSTEM = `You are a Solana token security analyst writing
one-sentence risk summaries for AI trading agents. Be specific and reference
actual values. Never hedge excessively. Never use the word "ensure".`;

const DEEP_DIVE_SYSTEM = `You are a Solana token security analyst writing
risk reports for AI trading agents. Connect data points into coherent analysis.
Reference patterns explicitly — do not list fields independently.`;

export async function generateQuickScanSummary(scanResult: QuickScanData): Promise<string> {
  const prompt = `Write a single sentence summarising this token's risk profile.
Include the risk grade and the single most important risk factor.
If grade is F, lead with the primary failure reason.
Output only the sentence, under 30 words, no preamble.

${JSON.stringify(scanResult, null, 2)}`;

  const result = await callWithFallback("fast", QUICK_SCAN_SYSTEM, prompt, 80);
  return result || fallbackQuickSummary(scanResult);
}

export async function generateDeepDiveReport(scanResult: DeepDiveData): Promise<string> {
  const prompt = `Write a 3–5 sentence risk report for this token.
Cross-reference holder concentration with LP lock status.
Reference buy/sell ratio alongside momentum score.
If the dev wallet shows a pattern of short-lived tokens, say so explicitly.
State the recommendation and why in the final sentence.
Output only the report, no preamble or sign-off.

${JSON.stringify(scanResult, null, 2)}`;

  const result = await callWithFallback("deep", DEEP_DIVE_SYSTEM, prompt, 300);
  return result || fallbackDeepReport(scanResult);
}

async function callWithFallback(
  tier: "fast" | "deep",
  system: string,
  userPrompt: string,
  maxTokens: number
): Promise<string> {
  for (const provider of PROVIDERS) {
    const key = provider.apiKey();
    if (!key) {
      console.warn(`[llm] ${provider.name} skipped — API key not set`);
      continue;
    }
    try {
      const result = await callProvider(provider, tier, system, userPrompt, maxTokens);
      if (result) {
        if (provider.name !== "anthropic") {
          console.info(`[llm] served by fallback provider: ${provider.name}`);
        }
        return result;
      }
    } catch (err) {
      console.warn(`[llm] ${provider.name} failed — trying next provider`, err);
    }
  }
  return ""; // caller falls through to deterministic template
}

async function callProvider(
  provider: Provider,
  tier: "fast" | "deep",
  system: string,
  userPrompt: string,
  maxTokens: number
): Promise<string> {
  const model = provider.models[tier];

  const body =
    provider.format === "anthropic"
      ? JSON.stringify({
          model,
          max_tokens: maxTokens,
          system,                                              // top-level — enables prompt caching
          messages: [{ role: "user", content: userPrompt }],
        })
      : JSON.stringify({
          model,
          max_tokens: maxTokens,
          messages: [
            { role: "system", content: system },              // OpenAI format
            { role: "user", content: userPrompt },
          ],
        });

  const headers: Record<string, string> =
    provider.format === "anthropic"
      ? {
          "Content-Type": "application/json",
          "x-api-key": provider.apiKey(),
          "anthropic-version": "2023-06-01",
        }
      : {
          "Content-Type": "application/json",
          Authorization: `Bearer ${provider.apiKey()}`,
        };

  const response = await fetch(provider.baseUrl, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(8_000),
  });

  if (!response.ok) {
    throw new Error(`${provider.name} API ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();

  // Anthropic: data.content[0].text — OpenAI: data.choices[0].message.content
  return provider.format === "anthropic"
    ? (data.content?.[0]?.text?.trim() ?? "")
    : (data.choices?.[0]?.message?.content?.trim() ?? "");
}

// Deterministic last-resort fallbacks
export function fallbackQuickSummary(r: QuickScanData): string {
  const topRisk =
    r.risk_grade === "F" ? "failed critical safety checks"
    : r.risk_grade === "D" ? `top-10 holders control ${r.top_10_holder_pct?.toFixed(0) ?? "?"}% of supply`
    : `liquidity is ${r.liquidity_usd != null ? `$${(r.liquidity_usd / 1000).toFixed(0)}k` : "unknown"}`;
  return `Grade ${r.risk_grade}: ${topRisk}.`;
}

export function fallbackDeepReport(r: DeepDiveData): string {
  return `Risk grade ${r.risk_grade} with ${r.top_10_holder_pct?.toFixed(0) ?? "?"}% top-10 concentration ` +
    `and ${r.liquidity_usd != null ? `$${(r.liquidity_usd / 1000).toFixed(0)}k` : "unknown"} liquidity. ` +
    `Recommendation: ${r.recommendation}.`;
}
```

### SLA rules

- `sol_quick_scan` 5s SLA: LLM runs sequentially after all parallel fetches.
  If elapsed time exceeds 4.2s before the LLM call starts, skip both providers
  and use `fallbackQuickSummary` directly. Log the skip.
- `sol_deep_dive` 30s SLA: Sonnet call has comfortable headroom. If Anthropic
  fails and Groq also fails within budget, use `fallbackDeepReport`. Log both
  failures and the fallback reason.
- Never let any provider failure propagate as a scan error.
- Log which provider served each response (skip logging when Anthropic succeeds
  to avoid log noise).

### Environment variables

```
ANTHROPIC_API_KEY=sk-ant-...   # primary — prompt caching applies
GROQ_API_KEY=gsk_...           # fallback — free tier, get at console.groq.com
```

Both keys are optional at startup but at least one must be set or all LLM
calls will fall through to the deterministic template immediately. Log a
startup warning if both are missing.

### Adding a third provider

The PROVIDERS array is ordered — insert new providers at any position. The
cascade tries them in array order and stops at the first success. To add a
provider, append an entry following the same interface. The `format` field
controls request/response shape: `"openai"` for any OpenAI-compatible API,
`"anthropic"` for Anthropic only.

---

## Constants (`src/constants.ts`)

Contains only Virtuals Protocol addresses and Solana program IDs.
The static token whitelist previously here has been replaced by the
Jupiter strict list in `src/sources/jupiterTokenList.ts`.

```typescript
/**
 * Virtuals Protocol controlled addresses.
 * Never flag these as insider holders, team wallets, or rug participants.
 * Source: Virtuals Protocol graduation requirements.
 */
export const VIRTUALS_PROTOCOL_ADDRESSES = new Set([
  "0xe2890629ef31b32132003c02b29a50a025deee8a", // sell wall wallet
  "0xf8dd39c71a278fe9f4377d009d7627ef140f809e", // sell execution contract
]);

export function isProtocolAddress(address: string): boolean {
  return VIRTUALS_PROTOCOL_ADDRESSES.has(address.toLowerCase());
}

export const PROGRAMS = {
  PUMP_FUN:          "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  TOKEN_PROGRAM:     "TokenkebQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  TOKEN_2022:        "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  METAPLEX_METADATA: "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
  RAYDIUM_AMM_V4:    "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
  ORCA_WHIRLPOOL:    "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
} as const;
```

**Integration — two places, both required:**

```typescript
// quickScan.ts and deepDive.ts — filter before concentration calc
const filteredHolders = holders.filter(h => !isProtocolAddress(h.address));
const top10Pct = calculateConcentration(filteredHolders.slice(0, 10));

// deepDive.ts — dev wallet check
if (isProtocolAddress(devWalletAddress)) {
  return { address: devWalletAddress, is_protocol_address: true,
           sol_balance: null, created_tokens_count: null, previous_rugs: false };
}
```

---

## API Server (`src/api/server.ts`)

Hono on port 8000, host `0.0.0.0`.

```
POST /scan/quick    → quickScan()
POST /scan/deep     → deepDive()
POST /wallet/risk   → walletRisk()
POST /market/intel  → marketIntel()
GET  /health        → status, uptime, circuit_breakers, source_success_rates
GET  /revenue/summary → revenueTracker middleware
```

### Health endpoint

```typescript
import { ensureFresh } from "../sources/jupiterTokenList.js";

app.get("/health", async (c) => {
  await ensureFresh(); // refresh Jupiter token list if stale (24h TTL)
  const breakers = circuitBreaker.getAll();
  const sourceStats = getSourceStats();
  const criticalDown = ["dexscreener", "helius_rpc"].filter(s => breakers[s] === "OPEN");

  return c.json({
    status: criticalDown.length > 0 ? "degraded" : "ok",
    uptime_seconds: Math.floor(process.uptime()),
    cache_hits: cache.getHits(),
    total_requests: cache.getTotal(),
    degraded_sources: criticalDown,
    circuit_breakers: breakers,
    source_success_rates: Object.fromEntries(
      Object.entries(sourceStats).map(([k, v]) => [k, v.successRate])
    ),
  });
});
```

Status is `"degraded"` when DexScreener or Helius circuit breaker is OPEN.

---

## ACP Integration

ACP tooling is already configured at `/root/virtuals-acp`. Do not re-run setup.
The job queue and all 4 handlers live in `/root/virtuals-acp/src/seller/`.

### Job Queue (`virtuals-acp/src/seller/jobQueue.ts`)

```typescript
import type { ExecuteJobResult } from "../runtime/offeringTypes.js";

type Job = {
  requirements: any;
  resolve: (result: ExecuteJobResult) => void;
  reject: (err: unknown) => void;
};

const queue: Job[] = [];
let processing = false;
const MAX_QUEUE_DEPTH = 50;

async function drain(handler: (req: any) => Promise<ExecuteJobResult>): Promise<void> {
  if (processing) return;
  processing = true;
  while (queue.length > 0) {
    const job = queue.shift()!;
    try { job.resolve(await handler(job.requirements)); }
    catch (err) { job.reject(err); }
  }
  processing = false;
}

export function enqueue(
  requirements: any,
  handler: (req: any) => Promise<ExecuteJobResult>
): Promise<ExecuteJobResult> {
  return new Promise((resolve, reject) => {
    if (queue.length >= MAX_QUEUE_DEPTH) {
      reject(new Error("Queue full — try again later"));
      return;
    }
    queue.push({ requirements, resolve, reject });
    console.log(`[jobQueue] depth=${queue.length}`);
    drain(handler);
  });
}
```

### Handler Pattern (all 4 services)

```typescript
// sol_quick_scan/handlers.ts — identical structure for all 4, only URL/timeout/field differ
import type { ExecuteJobResult, ValidationResult } from "../../../runtime/offeringTypes.js";
import { enqueue } from "../../jobQueue.js";

export async function executeJob(requirements: any): Promise<ExecuteJobResult> {
  return enqueue(requirements, async (req) => {
    const response = await fetch("http://localhost:8000/scan/quick", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(10_000),
    });
    const result = await response.json();
    return { deliverable: JSON.stringify(result) }; // must be wrapped
  });
}

export function validateRequirements(requirements: any): ValidationResult {
  const addr = requirements?.token_address;
  return typeof addr === "string" && addr.length >= 32 && addr.length <= 44;
}

export async function requestPayment(requirements: any): Promise<string> {
  return "Payment accepted"; // must be plain string — never return an object
}
```

**Per-service values:**

| Service | URL | Timeout | Validated field |
|---|---|---|---|
| `sol_quick_scan` | `/scan/quick` | `10_000` | `token_address` |
| `sol_wallet_risk` | `/wallet/risk` | `12_000` | `wallet_address` |
| `sol_market_intel` | `/market/intel` | `10_000` | `token_address` |
| `sol_deep_dive` | `/scan/deep` | `35_000` | `token_address` |

### `offering.json` format

```json
{
  "name": "sol_quick_scan",
  "description": "Instant Solana token safety check. Returns risk grade (A–F), mint/freeze authority status, top-10 holder concentration, and liquidity in under 5 seconds. Essential pre-trade check for any Solana trading agent. $0.02 per call.",
  "jobFee": 0.02,
  "jobFeeType": "fixed",
  "priceV2": { "type": "fixed", "value": 0.02 },
  "requiredFunds": false,
  "requirement": {
    "type": "object",
    "properties": {
      "token_address": { "type": "string", "description": "Solana token mint address (base58, 32–44 characters)" }
    },
    "required": ["token_address"]
  }
}
```

---

## Revenue Tracker (`scripts/revenueTracker.ts`)

Middleware that hooks into Hono server. Logs per-service call counts to SQLite.
Uses `better-sqlite3`. DB at `/root/solprobe/data/revenue.db`.

Exposes `GET /revenue/summary`:
```json
{
  "total_usdc": 1.23,
  "by_service": {
    "sol_quick_scan":   { "calls": 100, "revenue_usdc": 2.00 },
    "sol_wallet_risk":  { "calls": 5,   "revenue_usdc": 0.10 },
    "sol_market_intel": { "calls": 2,   "revenue_usdc": 0.10 },
    "sol_deep_dive":    { "calls": 0,   "revenue_usdc": 0.00 }
  },
  "since": "2025-01-01T00:00:00Z"
}
```

Do not modify scanner logic — hook in via middleware only.

---

## Health Watchdog (`scripts/healthWatchdog.ts`)

```typescript
const res = await fetch("http://localhost:8000/health");
const health = await res.json();
if (health.status !== "ok") {
  console.error(`[watchdog] DEGRADED — down sources: ${health.degraded_sources.join(", ")}`);
  process.exit(1);
}
console.log(`[watchdog] ok — uptime ${health.uptime_seconds}s`);
```

---

## Process Management

**`ecosystem.config.cjs`:**

```javascript
module.exports = {
  apps: [
    {
      name: "solprobe",
      script: "./start.sh",
      interpreter: "bash",
      restart_delay: 3000,
      max_restarts: 20,
      watch: false,
      env: { NODE_ENV: "production" },
      log_file: "logs/combined.log",
      error_file: "logs/error.log",
      time: true,
    },
    {
      name: "acp-seller",
      // managed separately in /root/virtuals-acp
    },
    {
      name: "health-watchdog",
      script: "scripts/healthWatchdog.ts",
      interpreter: "npx",
      interpreter_args: "tsx",
      cron_restart: "*/5 * * * *",
      autorestart: false,
    },
  ]
};
```

---

## Tests (Vitest)

1. **`quickScan.test.ts`** — BONK (good), known rug (F grade), verify response shape,
   verify `isValidSolanaAddress` rejects garbage, verify USDC grades A/B with
   `authority_exempt: true`
2. **`sources.test.ts`** — mock all APIs, verify 200/429/500 handling, verify parallel
   fetching runs concurrently, verify Helius always called for authority flags,
   verify Jupiter list returns exempt=true for stablecoin tags
3. **`deepDive.test.ts`** — `recommendation` never undefined, `momentum_score` always 0–100,
   protocol addresses not flagged as suspicious
4. **`circuitBreaker.test.ts`** — CLOSED→OPEN after 5 failures, OPEN rejects immediately,
   OPEN→HALF_OPEN after cooldown, HALF_OPEN→CLOSED on success

---

## Environment Variables

```
# RPC & data sources
HELIUS_API_KEY=
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
PORT=8000
LOG_LEVEL=info

# LLM narrative layer — at least one must be set or all calls fall to template
ANTHROPIC_API_KEY=sk-ant-...   # primary provider
GROQ_API_KEY=gsk_...           # fallback provider — free, get at console.groq.com

# Buyback script — add only after PM2 non-root user migration
AGENT_WALLET_PRIVATE_KEY=
SPROBE_TOKEN_ADDRESS=
BUYBACK_INTERVAL_MINUTES=60
BUYBACK_THRESHOLD_USDC=5.0
DRY_RUN=true
```

---

## Build Order

Work in this sequence. Do not skip ahead.

1. `src/constants.ts` — no deps
2. `src/validate.ts` — no deps, used everywhere
3. `src/utils/retry.ts` — no deps
4. `src/circuitBreaker.ts` — no deps
5. `src/sources/resolver.ts` — no deps
6. `src/sources/jupiterTokenList.ts` — no deps, test `isAuthorityExempt` in isolation
7. `src/cache.ts` — deduplication, TTLs, token buckets
8. `src/api/rateLimiter.ts` — no deps
9. `src/sources/dexscreener.ts` — validate live against BONK
10. `src/sources/helius.ts` — include `getTokenMintInfo()`, validate against BONK
11. `src/sources/rugcheck.ts` — no authority flags, include `report_age_seconds`
12. `src/sources/birdeye.ts`, `src/sources/solscan.ts`
13. `src/scanner/riskScorer.ts` — `scoreConfidence()` + authority exemption logic
14. `src/llm/narrativeEngine.ts` — test in isolation with mock data
15. `src/scanner/quickScan.ts` + `src/api/server.ts` (quick endpoint only)
16. **Live end-to-end test against BONK and USDC** — BONK grades A, USDC grades A/B with authority_exempt: true
17. `src/scanner/deepDive.ts`, `walletRisk.ts`, `marketIntel.ts`
18. ACP handlers (`virtuals-acp/src/seller/jobQueue.ts` + all 4 `handlers.ts`)
19. `scripts/revenueTracker.ts`, `scripts/healthWatchdog.ts`
20. Tests (`circuitBreaker.test.ts` first — no external deps)

---

## What NOT to Do

- Do not fetch `mint_authority_revoked` or `freeze_authority_revoked` from RugCheck — ever
- Do not make the Helius authority call conditional — it runs on every scan, always
- Do not use a static token whitelist to exempt tokens from authority penalties — use the Jupiter strict list
- Do not hardcode USDC, USDT, or any token address as exempt — Jupiter handles this dynamically
- Do not block server startup waiting for the Jupiter list — load it fire-and-forget
- Do not call the LLM before all parallel source fetches have settled
- Do not let any LLM provider failure propagate as a scan error — cascade to next provider, then template
- Do not use Sonnet or Mixtral for `sol_quick_scan` — Haiku/Llama fast models only; 5s SLA has no headroom
- Do not skip the Groq fallback — the deterministic template is last resort, not first fallback
- Do not add Ollama or any local model server — the VPS has no GPU; CPU inference blows both SLAs
- Do not flag `0xe2890629...` or `0xF8DD39c7...` as suspicious under any circumstances
- Do not hardcode API keys — always read from environment variables
- Do not log which provider served a request when Anthropic succeeds — only log on fallback or failure
- Do not fabricate or inflate `data_confidence` — buyer agents cross-check and churn
- Do not share cache TTLs across services — each has a different staleness budget
- Do not return an object from `requestPayment` — plain string only
- Do not return a raw object from `executeJob` — must be `{ deliverable: JSON.stringify(result) }`
- Do not suppress errors after 3 genuine retries — an honest error is correct
- Do not modify `/root/virtuals-acp/` files unless explicitly asked
- Do not add PM2 watchdog under the existing `solprobe` or `acp-seller` process names