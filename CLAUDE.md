# SolProbe — Claude Code Instructions

## Project Vision

**SolProbe** is a Solana token scanner agent that sells 4 tiered intelligence services to other AI agents on the [Virtuals Protocol ACP marketplace](https://github.com/Virtual-Protocol/openclaw-acp). This is a first-mover opportunity on Solana within ACP. Revenue comes from per-call service fees (USDC) and a token flywheel as adoption grows. The agent runs 24/7 on a $5 VPS.

---

## Language & Stack

**TypeScript throughout.** All scanner logic, data sources, API server, and ACP handlers are written in TypeScript (Node.js 20+).

- **Hono** for the internal HTTP service layer (lightweight, fast, edge-compatible)
- **Node.js native `fetch`** for async HTTP calls (no extra deps)
- **`Promise.allSettled()`** for parallel data fetching with per-source fault isolation
- **ACP integration** via the OpenClaw ACP skill pack: `npx tsx`

---

## Available Skills
- cost-aware-llm-pipeline: Use for routing scan requests to correct model tier
- autonomous-loops: Use when building service pipeline chains
- api-design: Use when defining ACP-facing service endpoints
- search-first: Use before any on-chain data analysis

---

## Services

| Service | Price | SLA | Description |
|---|---|---|---|
| `sol_quick_scan` | $0.01 | < 5s | Fast safety check — risk grade, mint/freeze authority, holder concentration, liquidity |
| `sol_deep_dive` | $0.50 | < 30s | Comprehensive analysis — dev wallet, LP lock, wash trading, pump.fun detection, recommendation |
| `sol_wallet_risk` | $0.02 | < 10s | Wallet risk profile — age, bot detection, rug involvement, trading style |
| `sol_market_intel` | $0.05 | < 10s | Real-time signals — price, volume, buy/sell pressure, BULLISH/BEARISH/NEUTRAL signal |

---

## Project Structure

```
solprobe/
├── src/
│   ├── scanner/
│   │   ├── quickScan.ts          # sol_quick_scan logic
│   │   ├── deepDive.ts           # sol_deep_dive logic
│   │   ├── walletRisk.ts         # sol_wallet_risk logic
│   │   ├── marketIntel.ts        # sol_market_intel logic
│   │   └── riskScorer.ts         # Shared risk grading logic
│   ├── sources/
│   │   ├── dexscreener.ts        # DexScreener API client (primary source)
│   │   ├── rugcheck.ts           # RugCheck API client
│   │   ├── helius.ts             # Helius/RPC client with RPC rotation
│   │   ├── birdeye.ts            # Birdeye public API client
│   │   └── solscan.ts            # Solscan public API client
│   ├── api/
│   │   └── server.ts             # Hono server — all 4 endpoints
│   ├── circuitBreaker.ts         # Per-source circuit breaker
│   ├── validate.ts               # Input validation (Solana address etc.)
│   └── cache.ts                  # In-memory cache + token bucket rate limiting
├── acp/
│   └── offerings/
│       ├── sol_quick_scan/
│       │   ├── offering.json
│       │   └── handlers.ts
│       ├── sol_deep_dive/
│       │   ├── offering.json
│       │   └── handlers.ts
│       ├── sol_wallet_risk/
│       │   ├── offering.json
│       │   └── handlers.ts
│       └── sol_market_intel/
│           ├── offering.json
│           └── handlers.ts
├── tests/
│   ├── quickScan.test.ts
│   ├── deepDive.test.ts
│   ├── sources.test.ts
│   └── circuitBreaker.test.ts
├── package.json
├── tsconfig.json
├── .env.example
├── ecosystem.config.js           # PM2 process config
├── start.sh
└── README.md
```

---

## Service 1: `sol_quick_scan` — $0.01

Fast safety check. Must complete in **under 5 seconds**.

**Response shape:**
```typescript
{
  is_honeypot: boolean;
  mint_authority_revoked: boolean;
  freeze_authority_revoked: boolean;
  top_10_holder_pct: number;
  liquidity_usd: number | null;
  risk_grade: "A" | "B" | "C" | "D" | "F";
  summary: string;                           // one sentence
  data_confidence: "HIGH" | "MEDIUM" | "LOW";
}
```

**Data sources (all free, no API key):**
- DexScreener: `https://api.dexscreener.com/latest/dex/tokens/{address}` — primary liquidity + price
- RugCheck: `https://api.rugcheck.xyz/v1/tokens/{address}/report/summary` — authority flags, rug signals
- Helius/RPC: `https://api.mainnet-beta.solana.com` — on-chain account info (with RPC rotation)

---

## Service 2: `sol_deep_dive` — $0.50

Full analysis. Up to **30 seconds** allowed.

**Response shape** (everything in quick_scan, plus):
```typescript
{
  dev_wallet_analysis: {
    address: string;
    sol_balance: number;
    created_tokens_count: number;
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
    wash_trading_score: number;   // 0–100, derived from on-chain tx patterns
  };
  pump_fun_launched: boolean;
  bundled_launch_detected: boolean;
  volume_24h: number;
  price_change_24h_pct: number;
  momentum_score: number;        // 0–100, derived from volume + price acceleration (NO external social API)
  full_risk_report: string;      // 3–5 sentences
  recommendation: "BUY" | "AVOID" | "WATCH" | "DYOR";
  data_confidence: "HIGH" | "MEDIUM" | "LOW";
}
```

> **Note on `momentum_score`:** This replaces `social_score`. It is derived entirely from on-chain signals —
> specifically volume acceleration (volume_1h vs volume_24h average), unique wallet growth rate, and
> buy/sell ratio trend. No Twitter/X or off-chain social API is used. This keeps the service free and
> deterministic. The field name reflects what it actually measures.

**Additional sources:**
- Birdeye public API: `https://public-api.birdeye.so/defi/token_overview?address={address}` — fallback liquidity + volume
- Solscan public API: `https://public-api.solscan.io/token/meta?tokenAddress={address}` — fallback metadata
- Pump.fun on-chain detection via RPC (check against program ID below)

---

## Service 3: `sol_wallet_risk` — $0.02

Wallet counterparty risk assessment.

**Response shape:**
```typescript
{
  wallet_age_days: number;
  total_transactions: number;
  is_bot: boolean;
  rug_involvement_count: number;
  whale_status: boolean;
  risk_score: number;               // 0–100
  trading_style: "sniper" | "hodler" | "flipper" | "bot" | "unknown";
  data_confidence: "HIGH" | "MEDIUM" | "LOW";
}
```

**Sources:** Solana mainnet RPC (with rotation), Helius free tier for parsed tx data.

---

## Service 4: `sol_market_intel` — $0.05

Real-time signals for trading agents pre-trade.

**Response shape:**
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
  large_txs_last_hour: number;      // txs > $10k
  signal: "BULLISH" | "BEARISH" | "NEUTRAL";
  data_confidence: "HIGH" | "MEDIUM" | "LOW";
}
```

**Source:** DexScreener API (primary, free, no key). Birdeye as fallback for price/volume if DexScreener is down.

---

## Input Validation (`src/validate.ts`)

**Always validate before hitting any external API.** Invalid addresses passed to on-chain RPCs waste quota and return confusing errors.

```typescript
import { PublicKey } from "@solana/web3.js";

export function isValidSolanaAddress(address: string): boolean {
  if (typeof address !== "string") return false;
  if (address.length < 32 || address.length > 44) return false;
  try {
    new PublicKey(address);  // deserialises to 32-byte pubkey — throws if invalid
    return true;
  } catch {
    return false;
  }
}

export function isValidSolanaWallet(address: string): boolean {
  return isValidSolanaAddress(address);
}
```

All four ACP `handlers.ts` files and all four Hono endpoints must call `isValidSolanaAddress()` before
any downstream work. Return HTTP 400 with `{ error: "INVALID_ADDRESS", data_confidence: "LOW" }` immediately.

---

## Source Priority Fallback Table

For each data field, attempt sources in order. Move to the next only if the previous returns `null`
or throws. Never wait for a failed source to retry before moving to the fallback — use circuit breaker
state to skip failed sources immediately (see Circuit Breaker section).

| Field | Primary | Fallback 1 | Fallback 2 | On total failure |
|---|---|---|---|---|
| `liquidity_usd` | DexScreener | Birdeye | — | `null` |
| `price_usd` | DexScreener | Birdeye | — | `null` |
| `volume_24h` | DexScreener | Birdeye | — | `null` |
| `mint_authority_revoked` | RugCheck | Helius RPC | — | `null` (grade penalty) |
| `freeze_authority_revoked` | RugCheck | Helius RPC | — | `null` (grade penalty) |
| `top_10_holder_pct` | RugCheck | Helius RPC | — | `null` (grade penalty) |
| `token_metadata` | Helius RPC | Solscan | — | `{}` empty object |
| `dev_wallet_balance` | Helius RPC | Public RPC | — | `null` |
| `trading_patterns` | Birdeye | DexScreener trades | — | defaults + LOW confidence |
| `rug_history` | RugCheck | — | — | `false` (conservative) |

**When applying grade penalties for null fields:** treat a null authority flag as *not revoked* (worst-case assumption). This is conservative and correct — never assume safety when data is missing.

---

## Parallel Data Fetching — Critical

All sources must be fetched in parallel. **Never make sequential calls.** Use `Promise.allSettled()`
(not `Promise.all().catch()`) — it gives you per-source fault isolation with explicit fulfilled/rejected
status, and prevents accidentally swallowing errors you need to log.

Every source call **must have its own `AbortSignal.timeout()`**. Without per-call timeouts, a single
hanging upstream response will blow the SLA regardless of `Promise.allSettled()`.

### Per-source timeout budget (leave headroom for processing)

| Source | Timeout | Rationale |
|---|---|---|
| DexScreener | 4000ms | Usually <500ms; 4s leaves 1s processing budget in 5s SLA |
| RugCheck | 3000ms | Can be slow; 3s is safe |
| Helius/RPC | 3000ms | Public RPC is unreliable; circuit breaker handles sustained failures |
| Birdeye | 4000ms | Fallback only — full budget available when primary failed fast |
| Solscan | 4000ms | Fallback only |

### Pattern to use everywhere

```typescript
async function fetchQuickScanData(address: string) {
  const results = await Promise.allSettled([
    dexscreener.getToken(address, { timeout: 4000 }),
    rugcheck.getSummary(address, { timeout: 3000 }),
    helius.getTokenInfo(address, { timeout: 3000 }),
  ]);

  const [dexResult, rugResult, rpcResult] = results;

  const dexData  = dexResult.status  === "fulfilled" ? dexResult.value  : null;
  const rugData  = rugResult.status  === "fulfilled" ? rugResult.value  : null;
  const rpcData  = rpcResult.status  === "fulfilled" ? rpcResult.value  : null;

  // Log any failures
  if (dexResult.status  === "rejected") logError("dexscreener", dexResult.reason, address);
  if (rugResult.status  === "rejected") logError("rugcheck",    rugResult.reason, address);
  if (rpcResult.status  === "rejected") logError("helius_rpc",  rpcResult.reason, address);

  // Count failures to set data_confidence
  const failCount = [dexData, rugData, rpcData].filter(d => d === null).length;
  const data_confidence = failCount === 0 ? "HIGH" : failCount === 1 ? "MEDIUM" : "LOW";

  // Apply fallback priority for null fields (see Source Priority Fallback Table)
  // ...
}
```

---

## In-Flight Request Deduplication

Without this, 10 agents calling `sol_quick_scan` for the same address in a 200ms burst will fire 10
full sets of API calls before any result hits the cache. Coalesce them into one.

Implement in `src/cache.ts` alongside the TTL cache:

```typescript
const inFlight = new Map<string, Promise<any>>();

export async function deduplicate<T>(key: string, fn: () => Promise<T>): Promise<T> {
  if (inFlight.has(key)) return inFlight.get(key)! as Promise<T>;

  const promise = fn().finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}
```

Usage in each scanner module:
```typescript
const cacheKey = `quick:${address}`;
return deduplicate(cacheKey, () => cache.getOrFetch(cacheKey, () => fetchQuickScanData(address)));
```

---

## Circuit Breaker (`src/circuitBreaker.ts`)

Prevents burning timeout budgets against sources that are already known-down. After a source fails
5 consecutive times, fail-fast for 60 seconds before trying again.

```typescript
type SourceName = "dexscreener" | "rugcheck" | "helius_rpc" | "birdeye" | "solscan";

interface BreakerState {
  failures: number;
  openedAt: number | null;   // timestamp when breaker tripped
  state: "CLOSED" | "OPEN" | "HALF_OPEN";
}

const FAILURE_THRESHOLD = 5;
const COOLDOWN_MS = 60_000;

const breakers = new Map<SourceName, BreakerState>();

export function isAvailable(source: SourceName): boolean {
  const b = getBreaker(source);
  if (b.state === "CLOSED") return true;
  if (b.state === "OPEN") {
    if (Date.now() - (b.openedAt ?? 0) > COOLDOWN_MS) {
      b.state = "HALF_OPEN";  // allow one probe request
      return true;
    }
    return false;
  }
  return true; // HALF_OPEN: allow the probe
}

export function recordSuccess(source: SourceName): void {
  const b = getBreaker(source);
  b.failures = 0;
  b.state = "CLOSED";
  b.openedAt = null;
}

export function recordFailure(source: SourceName): void {
  const b = getBreaker(source);
  b.failures++;
  if (b.failures >= FAILURE_THRESHOLD) {
    b.state = "OPEN";
    b.openedAt = Date.now();
  }
}
```

**Every source client** must wrap its fetch call:
```typescript
if (!isAvailable("dexscreener")) return null;   // fail-fast, ~0ms cost
try {
  const data = await fetchWithTimeout(url, 4000);
  recordSuccess("dexscreener");
  return data;
} catch (err) {
  recordFailure("dexscreener");
  throw err;
}
```

Expose breaker state in the `/health` endpoint so you can monitor which sources are degraded.

---

## Error Handling Rules

- **Never return an error to the calling agent.** Always return a degraded but valid response.
- If DexScreener fails → consult fallback table, set `liquidity_usd: null` if no fallback succeeds, note it in `summary`.
- Set `data_confidence: "LOW"` when 2+ sources fail, `"MEDIUM"` when 1 fails, `"HIGH"` when all succeed.
- Log all API failures to `errors.log` (timestamp, source, status_code, token_address, error_message).
- Log every job to `jobs.log` (timestamp, service, address, response_time_ms, data_confidence, sources_used).
- **Treat null authority flags as not-revoked** (worst-case / most conservative) when data is missing.
- `recommendation` in `sol_deep_dive` must **never be undefined** — default to `"DYOR"` when confidence is LOW.

---

## Caching & Rate Limiting (`src/cache.ts`)

### TTL — tiered by service (not flat 60s)

| Service | TTL | Rationale |
|---|---|---|
| `sol_quick_scan` | 60s | Highest frequency; safety data changes slowly |
| `sol_market_intel` | 30s | Price/volume data goes stale fast |
| `sol_deep_dive` | 300s | Expensive; structural data changes slowly |
| `sol_wallet_risk` | 120s | Wallet history is slow-moving |

Cache key format: `{service}:{address}` e.g. `quick:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`

### Token bucket rate limits (per source, self-implemented — no library)

| Source | Limit |
|---|---|
| DexScreener | 300 req/min |
| RugCheck | 100 req/min |

Token bucket behaviour: if bucket is empty, fail immediately (do not queue/wait). The circuit breaker
handles sustained unavailability; the token bucket prevents thundering-herd bursts.

---

## RPC Rotation & Retry Logic

The public Solana RPC (`https://api.mainnet-beta.solana.com`) rate-limits aggressively (~10 req/s in
practice) and returns 429s often. Implement rotation across free endpoints **before** falling back to
exponential backoff:

```typescript
const RPC_ENDPOINTS = [
  process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com",   // primary (Helius if key set)
  "https://rpc.ankr.com/solana",                                          // Ankr free tier
  "https://api.mainnet-beta.solana.com",                                  // official fallback
] as const;
```

**Retry logic:**
- Max 3 retries total, rotating endpoints on each retry
- Delays: 500ms → 1000ms → 2000ms (exponential)
- Respect `Retry-After` header on 429 responses — if header is present, use that value instead of
  the backoff delay (capped at 5s to protect SLA)
- On final failure, return `null` and set `data_confidence` accordingly
- Do **not** retry on 400/404 — these are invalid addresses, not transient failures

```typescript
async function rpcWithRetry<T>(fn: (endpoint: string) => Promise<T>): Promise<T | null> {
  const delays = [500, 1000, 2000];
  for (let i = 0; i < RPC_ENDPOINTS.length; i++) {
    try {
      return await fn(RPC_ENDPOINTS[i]);
    } catch (err: any) {
      const isRateLimit = err?.status === 429;
      const retryAfter  = isRateLimit ? Math.min(parseInt(err?.headers?.["retry-after"] ?? "0") * 1000, 5000) : 0;
      const delay       = retryAfter || delays[i] || 2000;
      if (i < RPC_ENDPOINTS.length - 1) await sleep(delay);
    }
  }
  return null;
}
```

---

## Risk Scorer (`src/scanner/riskScorer.ts`)

Deterministic, no ML. Score starts at 100 and penalties are subtracted. Grade is assigned from final
score. `has_rug_history` is an instant-fail regardless of score.

```typescript
interface RiskFactors {
  mint_authority_revoked: boolean | null;    // null = unknown → treat as false (25pt penalty)
  freeze_authority_revoked: boolean | null;  // null = unknown → treat as false (15pt penalty)
  top_10_holder_pct: number | null;          // null = unknown → treat as 100% (worst-case)
  liquidity_usd: number | null;              // null = unknown → treat as $0 (worst-case)
  has_rug_history: boolean;                  // true = instant F, no score computed
  bundled_launch: boolean;                   // true = 20pt penalty
  buy_sell_ratio: number | null;             // null = unknown → no penalty (insufficient data)
  token_age_days: number | null;             // null = unknown → 10pt penalty
}

// Penalty table
// mint_authority_revoked === false (or null):  -25
// freeze_authority_revoked === false (or null): -15
// top_10_holder_pct > 80%:                     -20
// top_10_holder_pct > 95%:                     -35 (overrides >80% penalty)
// liquidity_usd < $10k:                        -20
// liquidity_usd < $1k:                         -35 (overrides <$10k penalty)
// bundled_launch === true:                     -20
// buy_sell_ratio < 0.5:                        -10
// token_age_days < 1:                          -15
// token_age_days null:                         -10

// Grade bands
// 80–100 → A
// 60–79  → B
// 40–59  → C
// 20–39  → D
// 0–19   → F
// has_rug_history → F (bypass scoring)

function calculateRiskGrade(factors: RiskFactors): "A" | "B" | "C" | "D" | "F"
```

---

## Solana Program IDs (hardcode these)

```typescript
export const PROGRAMS = {
  PUMP_FUN:          "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  TOKEN_PROGRAM:     "TokenkebQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  TOKEN_2022:        "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  METAPLEX_METADATA: "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
  RAYDIUM_AMM_V4:    "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
  ORCA_WHIRLPOOL:    "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
} as const;
```

---

## API Server (`src/api/server.ts`)

Use **Hono**, running on port `8000`, host `0.0.0.0`.

```
POST /scan/quick    → quickScan()
POST /scan/deep     → deepDive()
POST /wallet/risk   → walletRisk()
POST /market/intel  → marketIntel()
GET  /health        → { status, uptime_seconds, cache_hits, total_requests, circuit_breakers }
```

The `/health` response must include circuit breaker state for each source so you can monitor degradation:

```typescript
GET /health → {
  status: "ok" | "degraded",
  uptime_seconds: number,
  cache_hits: number,
  total_requests: number,
  circuit_breakers: {
    dexscreener: "CLOSED" | "OPEN" | "HALF_OPEN",
    rugcheck:    "CLOSED" | "OPEN" | "HALF_OPEN",
    helius_rpc:  "CLOSED" | "OPEN" | "HALF_OPEN",
    birdeye:     "CLOSED" | "OPEN" | "HALF_OPEN",
    solscan:     "CLOSED" | "OPEN" | "HALF_OPEN",
  }
}
```

`status: "degraded"` when any breaker is OPEN.

---

## ACP Integration

 **Note:** ACP tooling is already configured on the server at `/root/virtuals-acp`.
 `config.json` contains the agent wallet and API key. Do not re-run setup.
 The `acp/offerings/` directory in this project is where handlers live —
 the runtime itself lives in `/root/virtuals-acp`.

### `offering.json` format

```json
{
  "name": "sol_quick_scan",
  "description": "Instant Solana token safety check. Returns risk grade, mint/freeze authority status, holder concentration, and liquidity in under 5 seconds. Essential pre-trade check for any Solana trading agent. $0.01 per call.",
  "price": "0.01",
  "currency": "USDC",
  "requirements": {
    "type": "object",
    "properties": {
      "token_address": {
        "type": "string",
        "description": "Solana token mint address (base58, 32–44 characters)"
      }
    },
    "required": ["token_address"]
  }
}
```

### `handlers.ts` pattern (thin wrapper only)

```typescript
import { isValidSolanaAddress } from "../../src/validate.js";

export async function executeJob(requirements: any): Promise<any> {
  try {
    const response = await fetch("http://localhost:8000/scan/quick", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requirements),
      signal: AbortSignal.timeout(10_000),
    });
    return response.json();
  } catch (err) {
    return { error: true, message: String(err), data_confidence: "LOW" };
  }
}

export function validateRequirements(requirements: any): boolean {
  return isValidSolanaAddress(requirements?.token_address);
}

// ⚠️ TODO BEFORE PRODUCTION: Implement actual Virtuals Protocol payment verification.
// This stub always approves. Replace with real ACP payment verification flow
// using the Virtuals Protocol SDK before going live on the marketplace.
export async function requestPayment(requirements: any): Promise<any> {
  return { approved: true };
}
```

**Timeouts:** 35s for `sol_deep_dive`, 12s for `sol_wallet_risk`, 10s for `sol_quick_scan` and `sol_market_intel`.

---

## `start.sh`

```bash
#!/bin/bash
set -e

# Start the Hono API server in background
npx tsx src/api/server.ts &
SERVER_PID=$!

# Wait for server to be ready — poll /health instead of blind sleep
echo "Waiting for API server..."
until curl -sf http://localhost:8000/health > /dev/null 2>&1; do
  sleep 0.5
done
echo "API server ready."

# Start ACP seller runtime
cd acp && npx tsx ../../node_modules/.bin/acp serve start

# Cleanup on exit
trap "kill $SERVER_PID 2>/dev/null" EXIT
```

---

## Process Management (PM2)

The server runs 24/7 — the process **will** crash. Do not rely on `start.sh` alone.

**`ecosystem.config.js`:**
```javascript
module.exports = {
  apps: [{
    name: "solprobe",
    script: "./start.sh",
    interpreter: "bash",
    restart_delay: 3000,
    max_restarts: 20,
    watch: false,
    env: {
      NODE_ENV: "production",
    },
    log_file: "logs/combined.log",
    error_file: "logs/error.log",
    time: true,
  }]
};
```

```bash
# Deploy
pm2 start ecosystem.config.js
pm2 save        # persist across reboots
pm2 startup     # generate systemd/init script
```

---

## Tests

Write tests using **Vitest**:

1. **`quickScan.test.ts`**
   - Known good token: USDC (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`)
   - Known rug: use a retired token with revoked LP
   - Verify response shape and `risk_grade` is deterministic
   - Verify `isValidSolanaAddress` rejects short strings, garbage, and accepts valid base58

2. **`sources.test.ts`**
   - Mock all external APIs
   - Verify each client handles 200, 429 (with Retry-After), and 500 correctly
   - Verify parallel fetching actually runs concurrently (mock with artificial delays — total time
     should be ~max(individual delays), not sum)
   - Verify circuit breaker opens after 5 consecutive failures and recovers after cooldown

3. **`deepDive.test.ts`**
   - Verify `recommendation` is never `undefined` — defaults to `"DYOR"` on LOW confidence
   - Verify degraded response when RugCheck is down (fallback chain engages)
   - Verify `momentum_score` is always 0–100 and never throws on missing data

4. **`circuitBreaker.test.ts`**
   - CLOSED → OPEN after 5 failures
   - OPEN rejects immediately (0 ms cost — mock Date.now)
   - OPEN → HALF_OPEN after cooldown
   - HALF_OPEN → CLOSED on success
   - HALF_OPEN → OPEN on failure

---

## Environment Variables

Never hardcode keys. Use a `.env` file:

```
HELIUS_API_KEY=           # optional — improves RPC rate limits significantly
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
PORT=8000
LOG_LEVEL=info            # debug | info | warn | error
```

---

## Build Order

Work in this sequence — do not skip ahead:

1. `src/validate.ts` — `isValidSolanaAddress()` used everywhere; build first
2. `src/sources/dexscreener.ts` — covers ~80% of needed data, validate with a live call against
   BONK (`DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263`)
3. `src/scanner/riskScorer.ts`
4. `src/scanner/quickScan.ts` + `src/api/server.ts` (quick endpoint only, no cache yet)
5. **Live end-to-end test** against BONK before continuing — verify SLA, response shape, and
   that a 400 is returned for a garbage address
6. `src/circuitBreaker.ts` + `src/cache.ts` — caching, deduplication, rate limiting, circuit breakers
7. Remaining source clients: `rugcheck.ts`, `helius.ts`, `birdeye.ts`, `solscan.ts`
   (each with circuit breaker wrapping and per-source timeouts)
8. Remaining scanner modules: `deepDive.ts`, `walletRisk.ts`, `marketIntel.ts`
   (use fallback priority table for every field)
9. ACP `handlers.ts` files for all 4 services
10. Tests (`circuitBreaker.test.ts` first — it has no external deps)
11. `README.md`, `start.sh`, `ecosystem.config.js`

---

## Setup (for README)

```bash
# 1. Install deps
npm install

# 2. Clone ACP tooling
git clone https://github.com/Virtual-Protocol/openclaw-acp

# 3. Configure env
cp .env.example .env

# 4. Setup ACP agent
npx tsx bin/acp.ts setup

# 5. Init each offering (run 4 times, once per service)
npx tsx bin/acp.ts sell init

# 6. Register on marketplace
npx tsx bin/acp.ts sell create

# 7. Install PM2 globally
npm install -g pm2

# 8. Start everything under PM2
pm2 start ecosystem.config.js
pm2 save && pm2 startup
```

# Tokenization Step

# CLAUDE.md — SolProbe Tokenization Step

> This file is the working brief for Claude Code.
> Scope: **Token launch preparation only** — no changes to the scanner API or ACP handlers.

---

## Who You Are Working With

**SolProbe** is a live Solana token scanner agent on the Virtuals Protocol ACP marketplace.
- Agent ID: #24456
- Chain: Base (Ethereum L2)
- Agent wallet: `0xbCcc9...e7193E`
- All 4 services are registered and operational
- 10 sandbox jobs completed — graduation is gated on tokenization

The scanner backend (`/root/solprobe`) and ACP seller runtime (`/root/virtuals-acp`) are **already running in production**. Do not touch them unless explicitly asked.

---

## What We Are Building Now

**Goal:** Prepare everything needed to tokenize SolProbe on Virtuals Protocol and graduate to the public A2A marketplace.

This is a **preparation and tooling task**, not a smart contract task. The actual token launch happens via the Virtuals Protocol UI at `app.virtuals.io/acp`. Our job is to get all the surrounding infrastructure ready so the launch goes smoothly and the token flywheel starts working immediately after graduation.

### Deliverables for This Step

1. **Token metadata package** — name, ticker, description, image assets, socials, in the format Virtuals Protocol expects for the tokenization form
2. **Buyback script** (`/root/solprobe/scripts/buyback.ts`) — monitors the agent wallet for incoming USDC revenue and auto-buys + burns agent token on a configurable schedule
3. **Revenue tracker** (`/root/solprobe/scripts/revenueTracker.ts`) — logs per-service revenue to a local SQLite DB so we can measure flywheel health
4. **Graduation checklist** (`/root/solprobe/GRADUATION.md`) — step-by-step human-readable launch checklist

---

## Token Details

| Field | Value |
|---|---|
| Name | SolProbe |
| Ticker | SPROBE |
| Tagline | The first Solana scanner agent on ACP — scan tokens, not vibes |
| Description (short) | SolProbe scans Solana tokens and wallets for other AI agents. Risk grading, market signals, deep dives — all via A2A calls on Virtuals Protocol. |
| Website | https://solprobe.xyz |
| Twitter | @solprobe |
| Chain | Base |

The description should emphasise: utility-first, not speculative; A2A revenue-generating; first-mover on Solana within ACP.

---

## Token Economics (Do Not Change These)

These are fixed by Virtuals Protocol:
- 100 VIRTUAL to mint (non-refundable)
- 42,425 VIRTUAL bonding curve target
- 30% of trading fees → buyback & burn of SPROBE
- 60% of trading fees → agent wallet (`0xbCcc9...e7193E`)
- 10% → protocol treasury

The buyback script should handle the 30% buyback/burn portion that flows to the agent wallet.

---

## Buyback Script Requirements

File: `/root/solprobe/scripts/buyback.ts`

Behaviour:
- Polls agent wallet balance on Base every `BUYBACK_INTERVAL_MINUTES` (default: 60)
- When balance exceeds `BUYBACK_THRESHOLD_USDC` (default: 5.0), triggers a buy
- Buys SPROBE token using the agent wallet private key (loaded from `.env`)
- Burns purchased tokens by sending to the dead address (`0x000...dEaD`)
- Logs every buyback event to stdout and to `/root/solprobe/logs/buyback.log`
- Dry-run mode via `DRY_RUN=true` env var — logs what it would do without transacting

Environment variables to add to `.env`:
```
AGENT_WALLET_PRIVATE_KEY=    # DO NOT COMMIT — Base wallet key
SPROBE_TOKEN_ADDRESS=        # Fill in after token launch
BUYBACK_INTERVAL_MINUTES=60
BUYBACK_THRESHOLD_USDC=5.0
DRY_RUN=true                 # Set to false after token is live
```

Use `viem` for Base chain interactions (already in the ecosystem, preferred over ethers).

---

## Revenue Tracker Requirements

File: `/root/solprobe/scripts/revenueTracker.ts`

Behaviour:
- Hooks into the existing Hono server via a lightweight middleware (do not modify scanner logic)
- Increments per-service counters in a SQLite DB (`/root/solprobe/data/revenue.db`) on every successful job delivery
- Exposes a `GET /revenue/summary` endpoint returning:

```json
{
  "total_usdc": 1.23,
  "by_service": {
    "sol_quick_scan": { "calls": 100, "revenue_usdc": 1.00 },
    "sol_wallet_risk": { "calls": 5,   "revenue_usdc": 0.10 },
    "sol_market_intel": { "calls": 2,  "revenue_usdc": 0.10 },
    "sol_deep_dive":    { "calls": 0,  "revenue_usdc": 0.00 }
  },
  "since": "2025-01-01T00:00:00Z"
}
```

Use `better-sqlite3` for the DB (synchronous, no async complexity).

---

## Stack Constraints

- **Language:** TypeScript (ESM, Node 22+)
- **No new frameworks** — Hono is already the HTTP layer, use it
- **Viem** for any Base chain interactions
- **Better-sqlite3** for local DB
- **PM2** for process management — add any new long-running scripts to `ecosystem.config.cjs`
- All scripts go in `/root/solprobe/scripts/`
- All logs go in `/root/solprobe/logs/` (create if not exists)
- All data files go in `/root/solprobe/data/` (create if not exists)

---

## What NOT to Do

- Do not modify `src/scanner/`, `src/sources/`, or `src/api/server.ts` directly (revenue tracker hooks in via middleware)
- Do not modify any files in `/root/virtuals-acp/`
- Do not generate or commit private keys or wallet secrets
- Do not write Solidity or deploy smart contracts — the token launch is done through the Virtuals UI
- Do not change existing PM2 process names (`solprobe`, `acp-seller`)

---

## Key Files for Context

| File | Purpose |
|---|---|
| `/root/solprobe/src/api/server.ts` | Hono server — middleware goes here |
| `/root/solprobe/ecosystem.config.cjs` | PM2 config — add new processes here |
| `/root/solprobe/.env` | Add new env vars here |

---

## Definition of Done

- [ ] Token metadata document ready to copy-paste into Virtuals Protocol tokenization form
- [ ] `buyback.ts` script written, typed, dry-run tested locally
- [ ] `revenueTracker.ts` middleware written, `GET /revenue/summary` returns valid JSON
- [ ] Both scripts registered in `ecosystem.config.cjs` (buyback as a cron-style process)
- [ ] `GRADUATION.md` checklist complete
- [ ] No existing tests broken, health endpoint still returns `"status": "ok"`

---

# Reliability & Success Rate Improvements

> Scope: Improve ACP job completion rate, SLA compliance, and data quality.
> Do not modify tokenization scripts, buyback.ts, or revenueTracker.ts.
> All changes are confined to `src/` unless explicitly stated.

---

## Overview of Changes

| # | Change | Files Affected | Priority |
|---|---|---|---|
| 1 | Retry logic — 3 attempts before failing | `acp/offerings/*/handlers.ts` | 🔴 First |
| 2 | SLA-aware timeout budgets per service | `src/api/server.ts`, handlers | 🔴 First |
| 3 | Weighted source resolver with rolling stats | `src/sources/resolver.ts` (new) | 🟡 Second |
| 4 | Honest `data_confidence` scoring | `src/scanner/riskScorer.ts` | 🟡 Second |
| 5 | Per-service cache TTLs | `src/cache.ts` | 🟡 Second |
| 6 | Degraded health status on critical source failure | `src/api/server.ts` | 🟢 Third |

---

## 1. Retry Logic in ACP Handlers

**File to create:** `src/utils/retry.ts`

All four ACP `handlers.ts` files must use this utility. The rule is:
**retry up to 3 times with exponential backoff before returning any error.**
Never return a degraded or error response without having genuinely attempted the call at least 3 times.

```typescript
// src/utils/retry.ts
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    attempts?: number;
    delayMs?: number;
    backoff?: "linear" | "exponential";
    label?: string;
  } = {}
): Promise<T> {
  const {
    attempts = 3,
    delayMs = 400,
    backoff = "exponential",
    label = "operation",
  } = options;

  let lastError: unknown;

  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const wait =
        backoff === "exponential" ? delayMs * 2 ** (i - 1) : delayMs * i;
      console.warn(
        `[retry] ${label} attempt ${i}/${attempts} failed — waiting ${wait}ms`
      );
      if (i < attempts) await sleep(wait);
    }
  }

  throw lastError;
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
```

**All four `handlers.ts` files must adopt this pattern:**

```typescript
// acp/offerings/sol_quick_scan/handlers.ts (and equivalents for other 3 services)
import { withRetry } from "../../../src/utils/retry.js";
import type {
  ExecuteJobResult,
  ValidationResult,
} from "../../../runtime/offeringTypes.js";

export async function executeJob(
  requirements: any
): Promise<ExecuteJobResult> {
  try {
    const result = await withRetry(
      () =>
        fetch("http://localhost:8000/scan/quick", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requirements),
          signal: AbortSignal.timeout(RETRY_CONFIG.sol_quick_scan.timeoutMs),
        }).then((r) => r.json()),
      {
        attempts: RETRY_CONFIG.sol_quick_scan.attempts,
        delayMs: RETRY_CONFIG.sol_quick_scan.delayMs,
        backoff: "exponential",
        label: "sol_quick_scan",
      }
    );

    return { deliverable: JSON.stringify(result) };
  } catch (err) {
    // Only reached after all retry attempts genuinely exhausted
    return {
      deliverable: JSON.stringify({
        error: true,
        message: "Service temporarily unavailable after 3 attempts",
        retry_suggested: true,
        data_confidence: "NONE",
      }),
    };
  }
}
```

---

## 2. Per-Service Retry & Timeout Config

**Add to `src/utils/retry.ts`** (or a shared constants file if one already exists):

```typescript
// Per-attempt timeout — not total budget. Resets each retry.
// Total worst-case time = (timeoutMs × attempts) + sum of backoff delays.
// All values leave headroom within the advertised SLA.
export const RETRY_CONFIG = {
  sol_quick_scan: {
    attempts: 3,
    delayMs: 300,
    timeoutMs: 4_000, // SLA 5s — 3 × 4s + 300+600ms ≈ 13s worst case, capped by ACP timeout
  },
  sol_wallet_risk: {
    attempts: 3,
    delayMs: 500,
    timeoutMs: 6_000, // SLA 10s
  },
  sol_market_intel: {
    attempts: 3,
    delayMs: 400,
    timeoutMs: 5_000, // SLA 10s
  },
  sol_deep_dive: {
    attempts: 3,
    delayMs: 800,
    timeoutMs: 8_000, // SLA 30s
  },
} as const;
```

**SLA timeout enforcement in `src/api/server.ts`:**

Each Hono endpoint must enforce a hard SLA deadline using `AbortSignal.timeout()` at the
**endpoint level** (not just per-source fetch). If the deadline is blown, return a structured
error immediately — a timeout is worse than a low-confidence response in ACP's eyes.

```typescript
// src/api/server.ts — example for /scan/quick
app.post("/scan/quick", async (c) => {
  const SLA_DEADLINE_MS = 4_500; // 500ms below the 5s advertised SLA
  const body = await c.req.json();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SLA_DEADLINE_MS);

  try {
    const result = await quickScan(body.token_address, controller.signal);
    clearTimeout(timer);
    return c.json(result);
  } catch (err) {
    clearTimeout(timer);
    if (controller.signal.aborted) {
      return c.json(
        {
          error: true,
          message: "SLA deadline exceeded",
          retry_suggested: true,
          data_confidence: "NONE",
        },
        503
      );
    }
    throw err;
  }
});
```

---

## 3. Weighted Source Resolver

**File to create:** `src/sources/resolver.ts`

The existing fallback chain is static. This module tracks rolling success rates and
re-ranks sources automatically every 100 requests so degraded sources are deprioritised
**before** they cause failures, not after.

```typescript
// src/sources/resolver.ts
type SourceName = "dexscreener" | "rugcheck" | "helius" | "birdeye" | "solscan";

interface SourceStats {
  priority: number;
  successRate: number;   // rolling — updated every call
  avgLatencyMs: number;  // rolling average
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

/** Call after every source fetch — pass success=false on any thrown error or non-200. */
export function recordSourceResult(
  source: SourceName,
  success: boolean,
  latencyMs: number
): void {
  const s = SOURCE_STATS[source];
  s.totalCalls++;
  if (!success) s.failures++;

  // Recalculate rolling average latency (exponential moving average, α=0.1)
  s.avgLatencyMs = s.avgLatencyMs * 0.9 + latencyMs * 0.1;

  // Recalculate rolling success rate every 100 calls
  if (s.totalCalls % 100 === 0) {
    s.successRate = 1 - s.failures / s.totalCalls;
  }
}

/** Returns sources ranked by current success rate (best first). */
export function rankSources(candidates?: SourceName[]): SourceName[] {
  const pool = candidates ?? (Object.keys(SOURCE_STATS) as SourceName[]);
  return [...pool].sort(
    (a, b) => SOURCE_STATS[b].successRate - SOURCE_STATS[a].successRate
  );
}

/** Snapshot of current stats — exposed via /health for observability. */
export function getSourceStats(): Record<SourceName, SourceStats> {
  return { ...SOURCE_STATS };
}
```

**Usage in source clients** (e.g. `dexscreener.ts`):

```typescript
import { recordSourceResult } from "./resolver.js";

export async function fetchDexScreener(address: string) {
  const start = Date.now();
  try {
    const data = await fetch(`https://api.dexscreener.com/...`).then(r => r.json());
    recordSourceResult("dexscreener", true, Date.now() - start);
    return data;
  } catch (err) {
    recordSourceResult("dexscreener", false, Date.now() - start);
    throw err;
  }
}
```

---

## 4. Honest `data_confidence` Scoring

**File:** `src/scanner/riskScorer.ts`

The `data_confidence` field must reflect real data quality. Buyer agents will notice
if confidence scores are inflated — this drives churn. Rules:

- `HIGH` requires **at least 2 sources corroborating** AND data **under 60 seconds old**
- `MEDIUM` if only one condition is met
- `LOW` if neither condition is met or only one source returned data
- Never return `HIGH` from a single source, regardless of how clean the data looks

```typescript
// Add to src/scanner/riskScorer.ts
export function scoreConfidence(
  sources: string[],      // names of sources that returned valid data
  dataAgeMs: number       // milliseconds since data was fetched
): "HIGH" | "MEDIUM" | "LOW" {
  const corroborated = sources.length >= 2;
  const fresh = dataAgeMs < 60_000; // under 60 seconds

  if (corroborated && fresh) return "HIGH";
  if (corroborated || fresh) return "MEDIUM";
  return "LOW";
}
```

All four scanner modules (`quickScan.ts`, `deepDive.ts`, `walletRisk.ts`, `marketIntel.ts`)
must call `scoreConfidence()` with the actual list of sources that contributed data to the
response. Do not hardcode confidence values.

---

## 5. Per-Service Cache TTLs

**File:** `src/cache.ts`

Replace any single global TTL with service-specific values. Wallet history changes slowly;
market signals go stale in seconds. Correct TTLs protect free API rate limits as volume
scales and dramatically improve p95 latency.

```typescript
// src/cache.ts — TTL constants
export const CACHE_TTL: Record<string, number> = {
  sol_quick_scan:   30_000,   // 30s — authority flags + liquidity don't change quickly
  sol_market_intel: 15_000,   // 15s — this is a signals product, tighter staleness budget
  sol_wallet_risk:  300_000,  // 5 min — wallet history is slow-moving
  sol_deep_dive:    60_000,   // 1 min — expensive to recompute, acceptable staleness
};
```

Cache key format: `{service}:{address}` — e.g. `sol_quick_scan:DezXAZ8z...`

Do not share cache entries across services. A `sol_quick_scan` result and a
`sol_deep_dive` result for the same address have different TTLs and different shapes.

---

## 6. Degraded Health Status

**File:** `src/api/server.ts`

The `/health` endpoint must distinguish between `ok` and `degraded`. PM2 or an
external monitor can poll this to alert before ACP sees failures.

DexScreener and RugCheck are **critical** — if both circuit breakers are OPEN
simultaneously, no meaningful scan can be completed. Surface this explicitly.

```typescript
app.get("/health", async (c) => {
  const breakers = circuitBreaker.getAll(); // existing call
  const sourceStats = getSourceStats();     // from resolver.ts (new)

  const criticalDown = ["dexscreener", "rugcheck"].filter(
    (s) => breakers[s] === "OPEN"
  );

  return c.json({
    status: criticalDown.length > 0 ? "degraded" : "ok",
    uptime_seconds: Math.floor(process.uptime()),
    cache_hits: cache.getHits(),           // existing
    total_requests: cache.getTotal(),      // existing
    degraded_sources: criticalDown,
    circuit_breakers: breakers,
    source_success_rates: Object.fromEntries(
      Object.entries(sourceStats).map(([k, v]) => [k, v.successRate])
    ),
  });
});
```

**PM2 health watchdog — add to `ecosystem.config.cjs`:**

```javascript
// ecosystem.config.cjs — add alongside existing solprobe and acp-seller entries
{
  name: "health-watchdog",
  script: "scripts/healthWatchdog.ts",
  interpreter: "npx",
  interpreter_args: "tsx",
  cron_restart: "*/5 * * * *",   // every 5 minutes
  autorestart: false,
}
```

**File to create:** `scripts/healthWatchdog.ts`

```typescript
// scripts/healthWatchdog.ts
const res = await fetch("http://localhost:8000/health");
const health = await res.json();

if (health.status !== "ok") {
  console.error(
    `[watchdog] DEGRADED — down sources: ${health.degraded_sources.join(", ")}`
  );
  // Extend here: send a webhook, write to a log file, or trigger PM2 restart
  process.exit(1); // non-zero exit triggers PM2 alert
}

console.log(`[watchdog] ok — uptime ${health.uptime_seconds}s`);
```

---

## Build Order for These Changes

Work in this sequence to avoid breaking existing functionality:

1. `src/utils/retry.ts` — no dependencies, safe to build first
2. Update all four `acp/offerings/*/handlers.ts` to use `withRetry` + `RETRY_CONFIG`
3. `src/sources/resolver.ts` — add `recordSourceResult()` calls to each source client
4. Update `src/scanner/riskScorer.ts` — add `scoreConfidence()`, wire into all 4 scanners
5. Update `src/cache.ts` — swap global TTL for `CACHE_TTL` map
6. Update `src/api/server.ts` — SLA deadline enforcement + degraded health status
7. `scripts/healthWatchdog.ts` + `ecosystem.config.cjs` entry

**Do not skip straight to step 6** — the health endpoint's `source_success_rates` field
depends on `resolver.ts` being in place first.

---

## What NOT to Do

- Do not fabricate or inflate `data_confidence` to improve perceived quality — buyer agents cross-check and will churn
- Do not suppress `error: true` in the final catch block — after 3 genuine retries, an honest error is correct
- Do not share cache TTLs across services — each service has a different staleness budget
- Do not add these PM2 watchdog entries under the existing `solprobe` or `acp-seller` process names