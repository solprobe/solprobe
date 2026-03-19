# SolProbe

Solana token scanner agent for the [Virtuals Protocol ACP marketplace](https://github.com/Virtual-Protocol/openclaw-acp). Sells 4 tiered intelligence services to other AI agents via per-call USDC fees.

## Services

| Service | Price | SLA | Description |
|---|---|---|---|
| `sol_quick_scan` | $0.01 | < 5s | Risk grade, mint/freeze authority, holder concentration, liquidity |
| `sol_deep_dive` | $0.50 | < 30s | Dev wallet, LP lock, wash trading, pump.fun detection, recommendation |
| `sol_wallet_risk` | $0.02 | < 10s | Wallet age, bot detection, rug involvement, trading style |
| `sol_market_intel` | $0.05 | < 10s | Price, volume, buy/sell pressure, BULLISH/BEARISH/NEUTRAL signal |

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and set your values:

```
HELIUS_API_KEY=           # optional — improves RPC rate limits significantly
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
PORT=8000
LOG_LEVEL=info
```

### 3. ACP setup

> **Note:** ACP tooling is already installed at `/root/virtuals-acp` on the server. Skip the clone step if it exists.

```bash
# Clone ACP tooling (first time only)
git clone https://github.com/Virtual-Protocol/openclaw-acp ../virtuals-acp

# Configure your agent wallet and API key
npx tsx ../virtuals-acp/bin/acp.ts setup

# Register each offering on the marketplace (run once per service)
cd acp/offerings/sol_quick_scan  && npx tsx ../../../virtuals-acp/bin/acp.ts sell init
cd acp/offerings/sol_deep_dive   && npx tsx ../../../virtuals-acp/bin/acp.ts sell init
cd acp/offerings/sol_wallet_risk && npx tsx ../../../virtuals-acp/bin/acp.ts sell init
cd acp/offerings/sol_market_intel && npx tsx ../../../virtuals-acp/bin/acp.ts sell init

# Create listings on the marketplace
npx tsx ../virtuals-acp/bin/acp.ts sell create
```

### 4. Install PM2

```bash
npm install -g pm2
```

### 5. Start under PM2

```bash
pm2 start ecosystem.config.js
pm2 save        # persist across reboots
pm2 startup     # generate systemd/init script — follow the printed command
```

## Running locally

```bash
# Start API server directly
npx tsx src/api/server.ts

# Run tests
npm test

# Live end-to-end test against a real token
npx tsx scripts/live_test.ts <token_address>

# Inspect risk scorer step-by-step
npx tsx scripts/risk_scorer_test.ts <token_address>
```

## API endpoints

```
POST /scan/quick    → sol_quick_scan
POST /scan/deep     → sol_deep_dive
POST /wallet/risk   → sol_wallet_risk
POST /market/intel  → sol_market_intel
GET  /health        → server status + circuit breaker state
```

All POST endpoints accept `{ "token_address": "<base58>" }` (or `{ "wallet_address": "..." }` for `/wallet/risk`).

### Example

```bash
curl -s -X POST http://localhost:8000/scan/quick \
  -H 'Content-Type: application/json' \
  -d '{"token_address": "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"}' | jq
```

## Monitoring

```bash
pm2 status          # process health
pm2 logs solprobe   # live log tail
pm2 monit           # interactive dashboard

# Circuit breaker and source health
curl -s http://localhost:8000/health | jq
```

## Data sources

All sources are free with no API key required (Helius key optional):

| Source | Used for |
|---|---|
| DexScreener | Price, liquidity, volume, buy/sell ratio |
| RugCheck | Authority flags, holder concentration, rug history |
| Helius / public RPC | On-chain mint account data, dev wallet balance |
| Birdeye | Fallback liquidity + volume |
| Solscan | Fallback token metadata |

## Architecture notes

- All sources fetched in parallel via `Promise.allSettled()` with per-source timeouts
- Circuit breaker per source — opens after 5 consecutive failures, recovers after 60s
- In-memory TTL cache: 60s quick scan, 30s market intel, 5min deep dive, 2min wallet risk
- In-flight deduplication prevents duplicate API calls for burst requests on the same address
- RPC rotation across 3 endpoints with exponential backoff on 429s
- Risk scorer is deterministic — no ML, penalty table with grade bands A/B/C/D/F
