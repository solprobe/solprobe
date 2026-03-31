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

## Development Verification Rules

These rules apply to every task involving external API data mapping.
Claude Code must follow them without being asked.

### API field verification (mandatory before mapping)
Before mapping any field from an external API response, verify the actual
field name and value against a live API call. Never assume field names from
documentation alone — they drift.

For every new field added to a source client (rugcheck.ts, dexscreener.ts,
helius.ts etc), Claude Code must:

1. Run a live curl against the actual endpoint and pipe through jq to confirm
   the field exists and contains the expected value type
2. Print the field path and value in a comment above the mapping line
3. If the field is null or missing in the live response, note the fallback

Example — before writing:
  rugcheck_risk_score: raw.score ?? null,

Claude Code must first run:
  curl -s "https://api.rugcheck.xyz/v1/tokens/DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263/report/summary" | jq '{score, normalizedScore}'

And confirm which field contains the real aggregate value before mapping.

---

## Services

| Service | Price | SLA | LLM call | Role |
|---|---|---|---|---|
| `sol_quick_scan` | $0.05 | < 5s | Haiku — `summary` field only | Structural safety gate |
| `sol_wallet_risk` | $0.10 | < 20s | Haiku — `risk_summary` field only | Counterparty intelligence + alpha discovery |
| `sol_market_intel` | $0.10 | < 10s | Haiku — `market_summary` field only | Real-time trading signal |
| `sol_deep_dive` | $0.50 | < 30s | Sonnet — `full_risk_report` only | Adversarial risk engine |

---

## Service Boundary Rules

These boundaries are strict. Do not let responsibilities bleed across services.

| Signal Type | Service |
|---|---|
| Mint/freeze authority | Quick Scan |
| Holder distribution | Quick Scan |
| Liquidity + volume | Market Intel |
| Price + momentum | Market Intel |
| Short-term price changes | Market Intel |
| Token age | Deep Dive |
| Wallet clustering / insider control | Deep Dive |
| Dev history / launch pattern | Deep Dive |
| Wallet behavior / trading style | Wallet Risk |
| Counterparty PnL / sniper score | Wallet Risk |
| MEV victim/bot detection | Wallet Risk |
| Copy-trade opportunity signal | Wallet Risk |
| Pump.fun exit pattern | Wallet Risk |

**Quick Scan must NOT imply tradability, liquidity health, or market conditions.**
**Market Intel must NOT repeat structural safety signals from Quick Scan.**
**Deep Dive must introduce new adversarial information — not repeat Quick Scan fields.**
**Wallet Risk must NOT flag wallets HIGH_RISK based solely on thin history — use UNKNOWN.**
**Wallet Risk copy_trading signals must reflect actor behaviour only — not token conditions.**
**copy_trading.worthiness and classification are orthogonal — never merge them.**

---

## Global Output Standards (apply to ALL services)

### 1. Schema Versioning
Every response MUST include:
```typescript
schema_version: "2.0";   // increment minor on non-breaking additions, major on shape changes
```
Buyer agents gate on this field before parsing. Never omit it.

### 2. Data Quality Layer
Every response MUST include:
```typescript
data_quality: "FULL" | "PARTIAL" | "LIMITED";
missing_fields: string[];
```
- `FULL` — all expected sources returned data
- `PARTIAL` — at least one non-critical source failed
- `LIMITED` — a critical source failed; confidence materially degraded
- NEVER silently assume missing data.

### 3. Structured Confidence Object
```typescript
confidence: {
  model: number;             // 0.0–1.0
  data_completeness: number; // 0.0–1.0
  signal_consensus: number;  // 0.0–1.0
};
```
Keep `data_confidence: "HIGH" | "MEDIUM" | "LOW"` for backwards compatibility,
derived from `confidence.model`.

```typescript
function confidenceToString(c: number): "HIGH" | "MEDIUM" | "LOW" {
  if (c >= 0.7) return "HIGH";
  if (c >= 0.4) return "MEDIUM";
  return "LOW";
}
```

### 4. Summary / narrative rules
- Structured fields carry the full decision weight. Summary explains — never introduces new claims.
- Disallow: "strong", "safe", "excellent", "highly reliable"
- Use conditional, scoped phrasing. State what this service does NOT cover.

### 5. Confidence calculation

```typescript
function calculateConfidence(data: {
  sources_available: number;
  sources_total: number;
  data_age_ms: number;
  rugcheck_age_seconds?: number;
  token_health?: string;
  signals_agree?: boolean;
}): { model: number; data_completeness: number; signal_consensus: number } {
  const data_completeness = data.sources_available / data.sources_total;
  let model = data_completeness;
  if (data.data_age_ms > 60_000)  model -= 0.1;
  if (data.data_age_ms > 300_000) model -= 0.2;
  if (data.rugcheck_age_seconds && data.rugcheck_age_seconds > 86_400) model -= 0.15;
  if (data.token_health === "DEAD" || data.token_health === "ILLIQUID") model = Math.min(model, 0.3);
  if (data.token_health === "LOW_ACTIVITY") model = Math.min(model, 0.6);
  model = Math.max(0, Math.min(1, Math.round(model * 100) / 100));
  const signal_consensus = data.signals_agree === false ? 0.5 : data_completeness;
  return { model, data_completeness, signal_consensus };
}
```

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
│   │   ├── helius.ts
│   │   ├── birdeye.ts
│   │   ├── solscan.ts
│   │   ├── resolver.ts
│   │   └── jupiterTokenList.ts
│   ├── api/
│   │   ├── server.ts
│   │   └── rateLimiter.ts
│   ├── llm/
│   │   └── narrativeEngine.ts
│   ├── utils/
│   │   └── retry.ts
│   ├── circuitBreaker.ts
│   ├── validate.ts
│   ├── cache.ts
│   └── constants.ts
├── scripts/
│   ├── revenueTracker.ts
│   ├── buyback.ts
│   └── healthWatchdog.ts
├── tests/
│   ├── quickScan.test.ts
│   ├── deepDive.test.ts
│   ├── walletRisk.test.ts
│   ├── marketIntel.test.ts
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

**Role: Structural safety gate only.**

```typescript
{
  schema_version: "2.0";
  grade_type: "STRUCTURAL_SAFETY";
  scope: {
    includes: ["mint_authority", "freeze_authority", "holder_distribution"];
    excludes: ["liquidity", "volume", "price_action", "market_behavior"];
  };
  is_honeypot: boolean;
  mint_authority_revoked: boolean;
  freeze_authority_revoked: boolean;
  top_10_holder_pct: number | null;
  authority_exempt: boolean;
  authority_exempt_reason: string | null;
  lp_burned: boolean | null;
  lp_status: "BURNED" | "UNBURNED" | "UNKNOWN" | "NOT_APPLICABLE";
  lp_model: "TRADITIONAL_AMM" | "CLMM_DLMM" | "UNKNOWN";
  dex_id: string | null;
  liquidity_check: "PRESENT" | "LOW" | "UNKNOWN";
  risk_grade: "A" | "B" | "C" | "D" | "F";
  rugcheck_report_age_seconds: number | null;
  factors: ScoringFactor[];
  historical_flags: HistoricalFlag[];
  confidence: { model: number; data_completeness: number; signal_consensus: number };
  data_confidence: "HIGH" | "MEDIUM" | "LOW";
  data_quality: "FULL" | "PARTIAL" | "LIMITED";
  missing_fields: string[];
  summary: string;
  // Example: "Grade reflects on-chain token structure only — mint authority revoked,
  //  holder distribution within normal range; liquidity and market conditions are
  //  outside the scope of this check."
}
```

### `sol_market_intel`

**Role: Real-time trading signal.**

```typescript
{
  schema_version: "2.0";
  current_price_usd: number;
  price_change_5m_pct: number | null;
  price_change_15m_pct: number | null;
  price_change_1h_pct: number;
  price_change_24h_pct: number;
  pct_from_ath: number | null;
  ath_price_usd: number | null;
  volume_1h_usd: number;
  volume_24h_usd: number;
  liquidity_usd: number;
  buy_sell_ratio: number;
  buy_pressure: "HIGH" | "MEDIUM" | "LOW";
  sell_pressure: "HIGH" | "MEDIUM" | "LOW";
  large_txs_last_hour: number;
  volatility: "LOW" | "MEDIUM" | "HIGH";
  signal: "BULLISH" | "BEARISH" | "NEUTRAL";
  signal_subtype: SignalSubtype;
  token_health: "ACTIVE" | "LOW_ACTIVITY" | "DECLINING" | "ILLIQUID" | "DEAD";
  factors: ScoringFactor[];
  confidence: { model: number; data_completeness: number; signal_consensus: number };
  data_confidence: "HIGH" | "MEDIUM" | "LOW";
  data_quality: "FULL" | "PARTIAL" | "LIMITED";
  missing_fields: string[];
  market_summary: string;
}
```

### `sol_deep_dive`

**Role: Adversarial risk engine.**

```typescript
{
  schema_version: "2.0";
  // Inherited structural (re-fetched fresh)
  is_honeypot: boolean;
  mint_authority_revoked: boolean;
  freeze_authority_revoked: boolean;
  top_10_holder_pct: number | null;
  authority_exempt: boolean;
  authority_exempt_reason: string | null;
  lp_burned: boolean | null;
  lp_status: "BURNED" | "UNBURNED" | "UNKNOWN" | "NOT_APPLICABLE";
  lp_model: "TRADITIONAL_AMM" | "CLMM_DLMM" | "UNKNOWN";
  dex_id: string | null;
  risk_grade: "A" | "B" | "C" | "D" | "F";
  // Adversarial layers
  risk_breakdown: {
    contract_risk: "LOW" | "MEDIUM" | "HIGH";
    liquidity_risk: "LOW" | "MEDIUM" | "HIGH";
    market_risk: "LOW" | "MEDIUM" | "HIGH";
    behavioral_risk: "LOW" | "MEDIUM" | "HIGH";
  };
  wallet_analysis: {
    clustered_wallets: number;
    insider_control_percent: number | null;
    dev_wallet_linked: boolean;
  };
  dev_wallet_analysis: {
    address: string;
    is_protocol_address?: boolean;
    sol_balance: number | null;
    created_tokens_count: number | null;
    previous_rugs: boolean;
  };
  launch_pattern: "STEALTH_LAUNCH" | "FAIR_LAUNCH" | "UNKNOWN";
  sniper_activity: "LOW" | "MEDIUM" | "HIGH";
  liquidity_lock_status: { locked: boolean; lock_duration_days: number; locked_pct: number };
  trading_pattern: { buy_sell_ratio_1h: number; unique_buyers_24h: number; wash_trading_score: number };
  pump_fun_launched: boolean;
  bundled_launch_detected: boolean;
  volume_24h: number;
  price_change_24h_pct: number;
  momentum_score: number;
  factors: ScoringFactor[];
  historical_flags: HistoricalFlag[];
  key_drivers: KeyDriver[];
  recommendation: {
    action: "AVOID" | "WATCH" | "CONSIDER" | "DYOR";
    reason: string;
    confidence: number;
    time_horizon: "SHORT_TERM" | "MEDIUM_TERM" | "LONG_TERM";
  };
  rugcheck_report_age_seconds: number | null;
  confidence: { model: number; data_completeness: number; signal_consensus: number };
  data_confidence: "HIGH" | "MEDIUM" | "LOW";
  data_quality: "FULL" | "PARTIAL" | "LIMITED";
  missing_fields: string[];
  full_risk_report: string;
}
```

### `sol_wallet_risk`

**Role: Counterparty intelligence AND alpha discovery primitive.**

Two orthogonal dimensions in one call:
- `classification` — is this wallet dangerous to trade against?
- `copy_trading` — is this wallet worth following?

These are independent. A wallet can be LOW_RISK and a poor copy. A wallet can be
HIGH_RISK and highly profitable to follow. Never merge or conflate them.

```typescript
{
  schema_version: "2.0";

  // ── Risk dimension ────────────────────────────────────────────────
  classification: "LOW_RISK" | "HIGH_RISK" | "UNKNOWN";
  // UNKNOWN when total_trades < 10 OR wallet_age_days < 7
  // HIGH_RISK requires >= 2 strong positive risk signals
  // LOW_RISK — sufficient history, no strong risk signals

  activity: {
    wallet_age_days: number;
    total_trades: number;
    active_days: number;
    last_active_hours_ago: number | null;
  };

  // Legacy flat fields (backwards compat)
  wallet_age_days: number;
  total_transactions: number;
  tokens_traded_30d: number;

  win_rate_pct: number | null;
  avg_hold_time_hours: number | null;
  sniper_score: number;
  rug_exit_rate_pct: number | null;
  pnl_estimate_30d_usdc: number | null;
  largest_single_loss_usdc: number | null;
  is_bot: boolean;
  whale_status: boolean;
  funding_wallet_risk: "HIGH" | "MEDIUM" | "LOW";

  behavior: {
    style: "SNIPER" | "MOMENTUM" | "FLIPPER" | "HODLER" | "BOT" | "DEGEN" | "LOW_ACTIVITY" | "INCONCLUSIVE";
    consistency: "LOW" | "MEDIUM" | "HIGH";
  };

  // Legacy flat field (backwards compat)
  trading_style: "sniper" | "hodler" | "flipper" | "bot" | "degen" | "unknown";

  score: {
    overall: number;
    components: {
      history_depth: number;
      behavioral_risk: number;
      counterparty_exposure: number;
    };
  };

  // Legacy flat field (backwards compat)
  risk_score: number;

  risk_signals: Array<{
    name: string;
    impact: "LOW" | "MEDIUM" | "HIGH";
    reason: string;
  }>;

  // No cap — scan all tokens traded in last 30 days.
  // Reflect partial Helius data in data_quality and missing_fields.
  historical_exposure: {
    rug_interactions: number;
    high_risk_tokens_traded: number;
  };

  // ── MEV intelligence (NEW) ─────────────────────────────────────
  mev_victim_score: number;          // 0–100
  is_mev_bot: boolean;
  mev_bot_confidence: number;        // 0.0–1.0

  // ── Pump.fun intelligence (NEW) ────────────────────────────────
  pumpfun_graduation_exit_rate_pct: number | null;
  early_entry_rate_pct: number | null;

  // ── Copy-trade opportunity layer (NEW) ─────────────────────────
  // Orthogonal to classification. Answers: "is this wallet worth following?"
  // MUST be "UNKNOWN" when total_trades < 20. No exceptions.
  copy_trading: {
    worthiness: "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";
    confidence: number;        // 0.0–1.0; capped at 0.5 when sample_size < 50
    sample_size: number;
    key_signals: string[];     // e.g. ["high_win_rate", "consistent_sizing"]
    reason: string | null;     // always populated when worthiness === "UNKNOWN"
  };

  factors: ScoringFactor[];
  confidence: { model: number; data_completeness: number; signal_consensus: number };
  data_confidence: "HIGH" | "MEDIUM" | "LOW";
  data_quality: "FULL" | "PARTIAL" | "LIMITED";
  missing_fields: string[];
  risk_summary: string;
}
```

---

## Agent-Native Intelligence Types

Define all shared types in `src/scanner/types.ts` and import everywhere.

### ScoringFactor

```typescript
interface ScoringFactor {
  name: string;
  value: number | string | boolean | null;
  impact: number;
  interpretation: string; // max 60 chars
}
```

Push a factor for EVERY condition checked — include `impact: 0` for passing checks.

### KeyDriver (Deep Dive only)

```typescript
interface KeyDriver {
  factor: string;
  impact: "LOW" | "MEDIUM" | "HIGH";
  direction: "POSITIVE" | "NEGATIVE" | "NEUTRAL";
}

function buildKeyDrivers(factors: ScoringFactor[]): KeyDriver[] {
  return [...factors]
    .sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact))
    .slice(0, 5)
    .map(f => ({
      factor: f.name,
      impact: Math.abs(f.impact) >= 20 ? "HIGH" : Math.abs(f.impact) >= 10 ? "MEDIUM" : "LOW",
      direction: f.impact < 0 ? "NEGATIVE" : f.impact > 0 ? "POSITIVE" : "NEUTRAL",
    }));
}
```

### SignalSubtype

```typescript
type SignalSubtype =
  | "NO_VOLUME_ACTIVITY"
  | "EARLY_PUMP"
  | "DISTRIBUTION_PHASE"
  | "POST_RUG_STAGNATION"
  | "HIGH_SPECULATION"
  | "ORGANIC_GROWTH"
  | "NORMAL_CORRECTION"
  | "LOW_LIQUIDITY_TRAP"
  | "SELL_PRESSURE_DOMINANCE"
  | "MOMENTUM_BREAKDOWN"
  | "NONE";
```

Derive deterministically — never via LLM.

```typescript
function deriveSignalSubtype(data: {
  signal: string; token_health: string; volume_24h_usd: number;
  price_change_1h_pct: number | null; price_change_24h_pct: number | null;
  pct_from_ath: number | null; buy_pressure: string; sell_pressure: string;
  liquidity_usd: number | null; buy_sell_ratio: number;
}): SignalSubtype {
  const ch1h = data.price_change_1h_pct ?? 0;
  const ch24h = data.price_change_24h_pct ?? 0;
  const ath = data.pct_from_ath;
  const liq = data.liquidity_usd ?? 0;

  if (data.token_health === "DEAD" || data.token_health === "ILLIQUID")
    return (ath !== null && ath < -80) ? "POST_RUG_STAGNATION" : "NO_VOLUME_ACTIVITY";
  if (data.token_health === "LOW_ACTIVITY") return "NO_VOLUME_ACTIVITY";
  if (liq < 25_000 && data.signal !== "NEUTRAL") return "LOW_LIQUIDITY_TRAP";
  if (data.buy_sell_ratio < 0.3 && data.sell_pressure === "HIGH") return "SELL_PRESSURE_DOMINANCE";
  if (ch1h < -10 && ch24h > 10 && data.volume_24h_usd > 50_000) return "MOMENTUM_BREAKDOWN";
  if (ch1h > 20 && data.buy_pressure === "HIGH" && data.sell_pressure === "LOW") return "EARLY_PUMP";
  if (data.sell_pressure === "HIGH" && ch24h < -10 && data.volume_24h_usd > 10_000) return "DISTRIBUTION_PHASE";
  if (ath !== null && ath < -80 && data.volume_24h_usd < 50_000) return "POST_RUG_STAGNATION";
  if (Math.abs(ch1h) > 30) return "HIGH_SPECULATION";
  if (data.signal === "BEARISH" && data.token_health === "ACTIVE") return "NORMAL_CORRECTION";
  if (data.signal === "BULLISH" && data.buy_pressure !== "LOW") return "ORGANIC_GROWTH";
  return "NONE";
}
```

### HistoricalFlag

```typescript
type HistoricalFlag =
  | "PAST_RUG" | "DEV_EXITED" | "LIQUIDITY_REMOVAL_EVENT" | "BUNDLED_LAUNCH"
  | "INSIDER_ACTIVITY" | "SINGLE_HOLDER_DANGER"
  | "DEV_ASSOCIATED_WITH_PREVIOUS_RUG" | "SUSPICIOUS_LAUNCH_PATTERN";

function buildHistoricalFlags(data: {
  has_rug_history: boolean; bundled_launch: boolean; single_holder_danger: boolean;
  dev_wallet_analysis?: { previous_rugs: boolean };
  sniper_activity?: string; launch_pattern?: string;
}): HistoricalFlag[] {
  const flags: HistoricalFlag[] = [];
  if (data.has_rug_history)                    flags.push("PAST_RUG");
  if (data.bundled_launch)                     flags.push("BUNDLED_LAUNCH");
  if (data.single_holder_danger)               flags.push("SINGLE_HOLDER_DANGER");
  if (data.dev_wallet_analysis?.previous_rugs) flags.push("DEV_ASSOCIATED_WITH_PREVIOUS_RUG");
  if (data.launch_pattern === "STEALTH_LAUNCH" && data.sniper_activity === "HIGH")
    flags.push("SUSPICIOUS_LAUNCH_PATTERN");
  return flags;
}
```

---

## Wallet Risk: Classification Logic

```typescript
function classifyWallet(data: {
  total_trades: number; wallet_age_days: number;
  risk_score_overall: number; strong_signals: number;
}): "LOW_RISK" | "HIGH_RISK" | "UNKNOWN" {
  if (data.total_trades < 10 || data.wallet_age_days < 7) return "UNKNOWN";
  if (data.risk_score_overall >= 70 && data.strong_signals >= 2) return "HIGH_RISK";
  if (data.risk_score_overall < 40) return "LOW_RISK";
  return "UNKNOWN";
}
```

## Wallet Risk: Copy-Trade Classification Logic

This function is the sole source of truth for `copy_trading`. Never derive it elsewhere.
The confidence cap below 0.5 for small samples is intentional — it signals to buyer
agents that the worthiness rating should not be acted upon with high conviction.

```typescript
interface CopyTradingResult {
  worthiness: "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";
  confidence: number;
  sample_size: number;
  key_signals: string[];
  reason: string | null;
}

function classifyCopyTrading(data: {
  total_trades: number;
  win_rate_pct: number | null;
  avg_hold_time_hours: number | null;
  consistency: "HIGH" | "MEDIUM" | "LOW";
  sniper_score: number;
  rug_exit_rate_pct: number | null;
  is_bot: boolean;
}): CopyTradingResult {
  // Bots: their edge does not transfer to a human copying their trades
  if (data.is_bot) {
    return {
      worthiness: "UNKNOWN", confidence: 0, sample_size: data.total_trades,
      key_signals: [],
      reason: "wallet classified as bot — copy-trade signal not applicable",
    };
  }

  // Hard gate: 20 trades minimum. Below this, any rating is statistically meaningless.
  // 3 good trades looks amazing but tells us nothing about skill vs luck.
  if (data.total_trades < 20 || data.win_rate_pct === null) {
    return {
      worthiness: "UNKNOWN", confidence: 0, sample_size: data.total_trades,
      key_signals: [],
      reason: "insufficient trading history — minimum 20 closed trades required",
    };
  }

  const signals: string[] = [];
  let score = 0;

  if (data.win_rate_pct >= 60)      { score += 30; signals.push("high_win_rate"); }
  else if (data.win_rate_pct >= 45) { score += 15; }

  if (data.consistency === "HIGH")        { score += 25; signals.push("consistent_sizing"); }
  else if (data.consistency === "MEDIUM") { score += 10; }

  // 1h–72h sweet spot: deliberate entry/exit discipline
  if (data.avg_hold_time_hours !== null &&
      data.avg_hold_time_hours >= 1 && data.avg_hold_time_hours <= 72) {
    score += 15; signals.push("disciplined_hold_time");
  }

  // Low sniper score = entries don't depend on front-running — more copyable
  if (data.sniper_score < 30) { score += 10; signals.push("non_sniper_entries"); }

  if (data.rug_exit_rate_pct !== null && data.rug_exit_rate_pct > 60) {
    score += 20; signals.push("strong_rug_exit_discipline");
  }

  // Confidence scales with sample size.
  // Intentionally capped at 0.5 below 50 trades — signal is real but fragile.
  const raw_confidence = Math.min(1, data.total_trades / 100);
  const confidence = data.total_trades < 50
    ? Math.min(0.5, raw_confidence)
    : raw_confidence;

  const worthiness: "HIGH" | "MEDIUM" | "LOW" =
    score >= 60 ? "HIGH" : score >= 35 ? "MEDIUM" : "LOW";

  return {
    worthiness,
    confidence: Math.round(confidence * 100) / 100,
    sample_size: data.total_trades,
    key_signals: signals,
    reason: null,
  };
}
```

## Wallet Risk: MEV Detection Logic

Derived from Helius parsed transactions. No external API required.

```typescript
// Victim: sandwich triplets where this wallet sits between two txs from
// the same sender in the same slot with worse-than-oracle execution price.
function calculateMevVictimScore(data: {
  total_swaps: number; sandwich_victim_count: number;
}): number {
  if (data.total_swaps === 0) return 0;
  return Math.min(100, Math.round((data.sandwich_victim_count / data.total_swaps) * 100));
}

// Bot: wallet is itself a sandwich attacker.
// Signals: consistent Jito tip payments, swap triplet authorship, consistent tip ratio.
function detectMevBot(data: {
  jito_tip_tx_count: number; total_tx_count: number;
  swap_triplet_author_count: number; consistent_tip_ratio: boolean;
}): { is_mev_bot: boolean; mev_bot_confidence: number } {
  let score = 0;
  if (data.jito_tip_tx_count / Math.max(data.total_tx_count, 1) > 0.3) score += 40;
  if (data.swap_triplet_author_count > 5) score += 35;
  if (data.consistent_tip_ratio) score += 25;
  return {
    is_mev_bot: score >= 50,
    mev_bot_confidence: Math.min(1, Math.round(score) / 100),
  };
}
```

## Wallet Risk: Pump.fun Intelligence Logic

```typescript
// % of pump.fun tokens exited within 10 minutes of Raydium migration.
// null when no pump.fun activity found in history.
function calculatePumpfunGraduationExitRate(data: {
  pumpfun_tokens_bought: number; pumpfun_tokens_exited_at_graduation: number;
}): number | null {
  if (data.pumpfun_tokens_bought === 0) return null;
  return Math.round((data.pumpfun_tokens_exited_at_graduation / data.pumpfun_tokens_bought) * 100);
}

// % of ALL tokens bought within 60 seconds of the token's first on-chain tx.
// null when fewer than 5 tokens have timing data.
function calculateEarlyEntryRate(data: {
  tokens_with_timing_data: number; tokens_entered_within_60s: number;
}): number | null {
  if (data.tokens_with_timing_data < 5) return null;
  return Math.round((data.tokens_entered_within_60s / data.tokens_with_timing_data) * 100);
}
```

## Wallet Risk: Score Calculation

```typescript
function calculateWalletScore(data: WalletRiskData): {
  overall: number;
  components: { history_depth: number; behavioral_risk: number; counterparty_exposure: number };
} {
  let behavioral_risk = 0;
  if (data.sniper_score > 70) behavioral_risk += 25;
  else if (data.sniper_score > 40) behavioral_risk += 15;
  if (data.win_rate_pct !== null && data.win_rate_pct > 80) behavioral_risk += 10;
  if (data.rug_exit_rate_pct !== null && data.rug_exit_rate_pct > 80) behavioral_risk += 20;
  if (data.is_bot) behavioral_risk += 15;
  behavioral_risk = Math.min(100, behavioral_risk);

  let history_depth = 0;
  if (data.wallet_age_days < 7) history_depth += 20;
  else if (data.wallet_age_days < 30) history_depth += 10;
  history_depth = Math.min(100, history_depth);

  let counterparty_exposure = 0;
  if (data.funding_wallet_risk === "HIGH") counterparty_exposure += 20;
  if (data.whale_status && data.sniper_score > 40) counterparty_exposure += 15;
  counterparty_exposure = Math.min(100, counterparty_exposure);

  const overall = Math.min(100, Math.max(0, behavioral_risk + history_depth + counterparty_exposure));
  return { overall, components: { history_depth, behavioral_risk, counterparty_exposure } };
}
```

---

## Wallet Risk Scanner (`src/scanner/walletRisk.ts`)

### Data sources

| Source | Call | Data extracted |
|---|---|---|
| Helius RPC | `getSignaturesForAddress` (last 200 txs) | Total tx count, wallet age, MEV signals |
| Helius Enhanced API | `getAssetsByOwner` | Token holdings, portfolio value |
| Helius Enhanced API | parsed transactions | Buy/sell events, Jito tips, pump.fun events |
| DexScreener | price lookups on traded tokens | PnL per position |
| Public RPC | `getAccountInfo` | SOL balance, funding wallet trace |

All calls run in parallel via `Promise.allSettled()`. Timeout per call: 8000ms.

`historical_exposure.high_risk_tokens_traded` scans ALL tokens traded in the last 30
days — no cap. If Helius returns partial data, set `data_quality: "PARTIAL"` and add
`"historical_exposure_partial"` to `missing_fields`. Never silently truncate.

### Behaviour classification

```
"BOT"          → >500 txs/day avg OR uniform trade amounts within 1% variance
"SNIPER"       → sniper_score > 60 AND avg_hold_time_hours < 2
"FLIPPER"      → avg_hold_time_hours < 24 AND tokens_traded_30d > 20
"HODLER"       → avg_hold_time_hours > 168 AND tokens_traded_30d < 5
"DEGEN"        → high tx count, diverse tokens, low win rate (<40%)
"LOW_ACTIVITY" → total_trades < 10
"INCONCLUSIVE" → insufficient data (<10 closed positions)
```

### SLA budget (20s total)

```
0–8s:   Parallel Helius + DexScreener calls
8–13s:  Signal calculation (MEV, pump.fun, copy-trade, classification)
13–15s: historical_exposure scan (all tokens, no cap)
15–18s: Haiku LLM call (or Groq fallback)
18–20s: Response assembly
```

If Helius enhanced tx parsing takes >12s, fall back to basic metadata
and set `data_quality: "LIMITED"`.

---

## Volatility Calculation (`src/scanner/marketIntel.ts`)

```typescript
function deriveVolatility(data: {
  price_change_5m_pct: number | null;
  price_change_15m_pct: number | null;
  price_change_1h_pct: number | null;
}): "LOW" | "MEDIUM" | "HIGH" {
  const ref = data.price_change_5m_pct ?? data.price_change_15m_pct ?? data.price_change_1h_pct ?? 0;
  const abs = Math.abs(ref);
  if (data.price_change_5m_pct !== null) {
    return abs > 5 ? "HIGH" : abs > 2 ? "MEDIUM" : "LOW";
  }
  if (data.price_change_15m_pct !== null) {
    return abs > 10 ? "HIGH" : abs > 4 ? "MEDIUM" : "LOW";
  }
  return abs > 20 ? "HIGH" : abs > 8 ? "MEDIUM" : "LOW";
}
```

---

## Deep Dive: Recommendation Engine

```typescript
function buildRecommendation(data: {
  risk_grade: string;
  risk_breakdown: { contract_risk: string; liquidity_risk: string; market_risk: string; behavioral_risk: string };
  historical_flags: HistoricalFlag[];
  confidence_model: number;
}): { action: "AVOID" | "WATCH" | "CONSIDER" | "DYOR"; reason: string; confidence: number; time_horizon: "SHORT_TERM" | "MEDIUM_TERM" | "LONG_TERM" } {
  const highRisks = Object.entries(data.risk_breakdown)
    .filter(([, v]) => v === "HIGH")
    .map(([k]) => k.replace("_risk", "").toUpperCase());

  if (data.risk_grade === "F" || highRisks.length >= 3)
    return { action: "AVOID", reason: highRisks.join(" + ") || "CRITICAL_GRADE", confidence: 0.9, time_horizon: "SHORT_TERM" };
  if (data.historical_flags.includes("PAST_RUG") || data.historical_flags.includes("DEV_ASSOCIATED_WITH_PREVIOUS_RUG"))
    return { action: "AVOID", reason: "CONFIRMED_RUG_HISTORY", confidence: 0.95, time_horizon: "SHORT_TERM" };
  if (data.risk_grade === "D" || highRisks.length >= 1)
    return { action: "WATCH", reason: highRisks.join(" + ") || "ELEVATED_RISK", confidence: data.confidence_model, time_horizon: "SHORT_TERM" };
  if (data.risk_grade === "A" || data.risk_grade === "B")
    return { action: "CONSIDER", reason: "ACCEPTABLE_STRUCTURAL_RISK", confidence: data.confidence_model, time_horizon: "MEDIUM_TERM" };
  return { action: "DYOR", reason: "INCONCLUSIVE_SIGNALS", confidence: Math.min(data.confidence_model, 0.5), time_horizon: "SHORT_TERM" };
}
```

---

## Token Health Classification

```typescript
function classifyTokenHealth(data: {
  volume_24h_usd: number | null; liquidity_usd: number | null;
  price_change_1h_pct: number | null; price_change_24h_pct: number | null;
}): "ACTIVE" | "LOW_ACTIVITY" | "DECLINING" | "ILLIQUID" | "DEAD" {
  const vol = data.volume_24h_usd ?? 0;
  const liq = data.liquidity_usd ?? 0;
  const ch1h = data.price_change_1h_pct ?? 0;
  const ch24h = data.price_change_24h_pct ?? 0;
  if (vol < 1_000 || liq < 1_000) return "DEAD";
  if (liq < 5_000)                return "ILLIQUID";
  if (vol < 10_000)               return "LOW_ACTIVITY";
  if (ch1h < -5 && ch24h < -20)  return "DECLINING";
  return "ACTIVE";
}

function deriveSignal(
  rawSignal: "BULLISH" | "BEARISH" | "NEUTRAL",
  health: string, pct_from_ath: number | null
): "BULLISH" | "BEARISH" | "NEUTRAL" {
  if (health === "DEAD" || health === "ILLIQUID") return "BEARISH";
  if (health === "LOW_ACTIVITY" && pct_from_ath !== null && pct_from_ath < -80) return "BEARISH";
  if (health === "DECLINING" && rawSignal === "NEUTRAL") return "BEARISH";
  return rawSignal;
}
```

`data_quality` caps: DEAD/ILLIQUID → `LIMITED`, LOW_ACTIVITY → `PARTIAL` at best.

---

## Input Validation (`src/validate.ts`)

```typescript
import { PublicKey } from "@solana/web3.js";

export function isValidSolanaAddress(address: string): boolean {
  if (typeof address !== "string") return false;
  if (address.length < 32 || address.length > 44) return false;
  try { new PublicKey(address); return true; } catch { return false; }
}
```

All four ACP handlers and all four Hono endpoints must call this before any downstream work.
Return HTTP 400 immediately on failure. Never return 500 for a bad address.

---

## Source Responsibility Split

```
HELIUS — live on-chain
  mint_authority_revoked, freeze_authority_revoked, top_10_holder_pct, lp_burned,
  dev_wallet_address, dev_wallet_age_days, dev_wallet_sol_balance, dev_token_count,
  pump_fun_launched, token_age_days,
  mev_victim_score (parsed txs), is_mev_bot (parsed txs),
  pumpfun_graduation_exit_rate_pct, early_entry_rate_pct

RUGCHECK — historical pattern data (staleness acceptable)
  has_rug_history, bundled_launch_detected, rugcheck_risk_score,
  single_holder_danger, insider_flags, report_age_seconds
  NOTE: .rugged boolean is null on free tier — use .score

DEXSCREENER — market data (Birdeye fallback)
  liquidity_usd, price_usd, volume_24h, price_change_24h_pct,
  buy_sell_ratio, large_txs, dexId

BIRDEYE OHLCV — ATH detection (sol_market_intel only)
  ath_price_usd, pct_from_ath, price_change_5m_pct, price_change_15m_pct
  Requires BIRDEYE_API_KEY — graceful null if missing
```

---

## Helius: Authority Flags

```typescript
export async function getTokenMintInfo(
  mintAddress: string, connection: Connection
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
  } catch { return null; }
}
```

On null return, default both to `false` (conservative). RugCheckResult must NEVER
contain authority flags.

---

## DEX LP Model Classification

```typescript
const TRADITIONAL_AMM_DEXES = new Set(["raydium","pumpfun","pump","fluxbeam","saber","aldrin","crema"]);
const CLMM_DLMM_DEXES = new Set(["meteora","meteoradlmm","orca","whirlpool","orcawhirlpool","raydiumclmm"]);

export function classifyLPModel(dexId: string | null | undefined): LPModel {
  if (!dexId) return "UNKNOWN";
  const id = dexId.toLowerCase();
  if (TRADITIONAL_AMM_DEXES.has(id) || id.includes("pump")) return "TRADITIONAL_AMM";
  if (CLMM_DLMM_DEXES.has(id) || id.startsWith("meteora") || id.startsWith("orca")) return "CLMM_DLMM";
  return "UNKNOWN";
}

// Always highest-liquidity pair — never pairs[0]
const primaryPair = dexData?.pairs?.slice()
  .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
```

---

## Jupiter Token List

```typescript
const EXEMPT_TAGS = new Set(["stable","stablecoin","wormhole","wrapped"]);
// "verified" and "strict" excluded — apply to memecoins like BONK
```

Only bypassed for exempt: mint authority (-25), freeze authority (-15), concentration (-20/-35).
All other penalties apply regardless. Load fire-and-forget at startup.

---

## Risk Scorer

Deterministic, no ML. Score 100, penalties subtracted. `has_rug_history` → instant F.

### Penalty table

| Condition | Penalty | Exempt |
|---|---|---|
| `mint_authority_revoked === false` or null | -25 | ✅ |
| `freeze_authority_revoked === false` or null | -15 | ✅ |
| `top_10_holder_pct > 90%` or null | -35 | ✅ |
| `top_10_holder_pct > 60%` | -20 | ✅ |
| `lp_burned === false` (TRADITIONAL_AMM) | -25 | ❌ |
| `lp_burned === null` (TRADITIONAL_AMM) | -10 | ❌ |
| `lp_burned === false` (UNKNOWN DEX) | -25 | ❌ |
| `lp_burned === null` (UNKNOWN DEX) | -5 | ❌ |
| CLMM_DLMM | 0 | n/a |
| `rugcheck_risk_score > 5000` | -30 | ❌ |
| `rugcheck_risk_score > 2000` | -20 | ❌ |
| `rugcheck_risk_score > 1000` | -10 | ❌ |
| `single_holder_danger` | -25 | ❌ |
| `liquidity_usd < $1k` or null | -35 | ❌ |
| `liquidity_usd < $10k` | -20 | ❌ |
| `bundled_launch` | -20 | ❌ |
| `buy_sell_ratio < 0.5` | -10 | ❌ |
| `token_age_days === null` | -10 | ❌ |
| `token_age_days < 1` | -15 | ❌ |
| `dev_wallet_age_days < 7` | -20 | ❌ deep only |
| `dev_wallet_age_days < 1` | -30 | ❌ deep only |

Grades: 80–100 A | 60–79 B | 40–59 C | 20–39 D | 0–19 F | rug → F

---

## Parallel Data Fetching

`Promise.allSettled()` always. Every call needs its own `AbortSignal.timeout()`.

| Source | Timeout |
|---|---|
| DexScreener | 4000ms |
| RugCheck | 3000ms |
| Helius/RPC | 3000ms |
| Birdeye | 4000ms |
| Solscan | 4000ms |

---

## Circuit Breaker

5 consecutive failures → fail-fast for 60s before retrying.

```typescript
type SourceName = "dexscreener" | "rugcheck" | "helius_rpc" | "birdeye" | "solscan";
const FAILURE_THRESHOLD = 5;
const COOLDOWN_MS = 60_000;
```

---

## Error Handling Rules

- Never return a hard error to calling agent — always a degraded valid response.
- `recommendation.action` must never be undefined — default `"DYOR"`.
- `classification` must never be undefined — default `"UNKNOWN"`.
- `copy_trading.worthiness` must never be undefined — default `"UNKNOWN"`.
- `copy_trading.reason` must never be null when `worthiness === "UNKNOWN"`.
- `data_quality` must reflect reality — never upgrade to FULL when sources failed.
- Log failures to `errors.log`, every job to `jobs.log`.

---

## Caching

| Service | TTL |
|---|---|
| `sol_quick_scan` | 30s |
| `sol_market_intel` | 15s |
| `sol_wallet_risk` | 300s |
| `sol_deep_dive` | 60s |

Cache key: `{service}:{address}`. Never share entries across services.

---

## LLM Narrative Engine

| Service | Field | Model |
|---|---|---|
| `sol_quick_scan` | `summary` | Haiku |
| `sol_wallet_risk` | `risk_summary` | Haiku |
| `sol_market_intel` | `market_summary` | Haiku |
| `sol_deep_dive` | `full_risk_report` | Sonnet |

Provider cascade: Anthropic → Groq → deterministic template.

```typescript
const PROVIDERS = [
  { name: "anthropic", models: { fast: "claude-haiku-4-5-20251001", deep: "claude-sonnet-4-6" } },
  { name: "groq", models: { fast: "llama-3.1-8b-instant", deep: "mixtral-8x7b-32768" } },
];
```

### Quick scan prompt (Haiku)
```typescript
const QUICK_SCAN_SYSTEM = `You are a Solana token security analyst writing
one-sentence structural safety summaries for AI trading agents. You will
receive a structured factors[] array. Explain the most important factor.
Always state explicitly what this check does NOT cover (liquidity, market
conditions, price action). Never use "strong", "safe", or "excellent".
Output only the sentence.`;
```

### Wallet risk prompt (Haiku)
```typescript
const WALLET_RISK_SYSTEM = `You are a Solana counterparty intelligence analyst.
Write one paragraph covering both dimensions: (1) risk classification and its
primary driver, (2) copy_trading worthiness and confidence. If worthiness is
UNKNOWN, state the reason exactly as provided. Never claim certainty about
future performance. Past performance does not predict future returns. Never
use "strong", "safe", or "excellent". Output only the paragraph.`;
```

### Deep dive prompt (Sonnet)
```typescript
const DEEP_DIVE_SYSTEM = `You are a Solana token adversarial risk analyst.
Write 3–5 sentences grounded in key_drivers[] and factors[]. Connect related
factors — do not list them independently. State recommendation and reason in
the final sentence. Never use "strong", "safe", or "excellent". Never
introduce claims not in the structured data.`;
```

### SLA rules
- Quick scan 5s: skip LLM if elapsed > 4.2s
- Wallet risk 20s: LLM budget is 18s from start
- Market intel 10s: skip LLM if elapsed > 9s
- Deep dive 30s: comfortable for Sonnet

### Deterministic fallbacks

```typescript
export function fallbackQuickSummary(r: QuickScanData): string {
  return `Grade ${r.risk_grade}: Structural safety check only — liquidity and market conditions not evaluated.`;
}

export function fallbackDeepReport(r: DeepDiveData): string {
  return `Risk grade ${r.risk_grade}. Recommendation: ${r.recommendation?.action ?? "DYOR"}. Full report unavailable — review structured fields.`;
}

export function fallbackMarketIntelSummary(data: MarketIntelData): string {
  const dir = data.signal === "BULLISH" ? "Bullish" : data.signal === "BEARISH" ? "Bearish" : "Neutral";
  const vol = data.volume_1h_usd != null ? `$${(data.volume_1h_usd / 1000).toFixed(0)}k 1h volume` : "volume unknown";
  return `${dir} signal — ${vol}, ${data.buy_pressure.toLowerCase()} buy pressure; further analysis required.`;
}

export function fallbackWalletRiskSummary(data: WalletRiskData): string {
  const cls = data.classification;
  const age = `${data.activity.wallet_age_days}d old`;
  const ct = data.copy_trading.worthiness === "UNKNOWN"
    ? `Copy-trade assessment unavailable: ${data.copy_trading.reason ?? "insufficient data"}.`
    : `Copy-trade worthiness: ${data.copy_trading.worthiness} (confidence ${data.copy_trading.confidence}, n=${data.copy_trading.sample_size}).`;
  if (cls === "UNKNOWN")
    return `Classified UNKNOWN — insufficient history (${data.activity.total_trades} trades, ${age}); no strong malicious signals detected. ${ct}`;
  return `${cls === "HIGH_RISK" ? "High" : "Low"} counterparty risk (${age}, ${data.activity.total_trades} trades). ${ct}`;
}
```

---

## Constants (`src/constants.ts`)

```typescript
export const VIRTUALS_PROTOCOL_ADDRESSES = new Set([
  "0xe2890629ef31b32132003c02b29a50a025deee8a",
  "0xf8dd39c71a278fe9f4377d009d7627ef140f809e",
]);

export const PROGRAMS = {
  PUMP_FUN:          "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  TOKEN_PROGRAM:     "TokenkebQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  TOKEN_2022:        "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  METAPLEX_METADATA: "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
  RAYDIUM_AMM_V4:    "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
  ORCA_WHIRLPOOL:    "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
} as const;
```

Filter protocol addresses before concentration calc and dev wallet checks.

---

## ACP Integration

### Handler Pattern

```typescript
export async function executeJob(requirements: any): Promise<ExecuteJobResult> {
  return enqueue(requirements, async (req) => {
    const response = await fetch("http://localhost:8000/scan/quick", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(10_000),
    });
    return { deliverable: JSON.stringify(await response.json()) };
  });
}

export function validateRequirements(requirements: any): ValidationResult {
  const addr = requirements?.token_address;
  return typeof addr === "string" && addr.length >= 32 && addr.length <= 44;
}

export async function requestPayment(requirements: any): Promise<string> {
  return "Payment accepted";
}
```

| Service | URL | Timeout | Field |
|---|---|---|---|
| `sol_quick_scan` | `/scan/quick` | `10_000` | `token_address` |
| `sol_wallet_risk` | `/wallet/risk` | `25_000` | `wallet_address` |
| `sol_market_intel` | `/market/intel` | `10_000` | `token_address` |
| `sol_deep_dive` | `/scan/deep` | `35_000` | `token_address` |

### `offering.json` — all 4 services

Descriptions are written for Butler and AI buyer agents.
They answer: what does this return, when to call it, what it does NOT cover.

**sol_quick_scan:**
```json
{
  "name": "sol_quick_scan",
  "description": "Structural safety gate for Solana tokens. Call this BEFORE executing any token swap or purchase to screen for mint authority risk, freeze authority risk, holder concentration, and LP burn status. Returns a deterministic risk grade (A–F) and machine-readable scoring factors. Does NOT evaluate liquidity, price, or market conditions — call sol_market_intel for those signals. Safe to call on every token before any buy decision. $0.05 per call, under 5 seconds.",
  "jobFee": 0.05, "jobFeeType": "fixed",
  "priceV2": { "type": "fixed", "value": 0.05 },
  "requiredFunds": false,
  "requirement": {
    "type": "object",
    "properties": { "token_address": { "type": "string", "description": "Solana token mint address (base58, 32–44 characters)" } },
    "required": ["token_address"]
  }
}
```

**sol_market_intel:**
```json
{
  "name": "sol_market_intel",
  "description": "Real-time trading signal for Solana tokens. Call this when making a buy, sell, or hold decision and you need current price action, volume, buy/sell pressure ratio, volatility, and market momentum. Returns a deterministic BULLISH/BEARISH/NEUTRAL signal with numeric buy_sell_ratio and token health classification. Does NOT evaluate token structure or wallet safety — call sol_quick_scan for structural signals. $0.10 per call, under 10 seconds.",
  "jobFee": 0.10, "jobFeeType": "fixed",
  "priceV2": { "type": "fixed", "value": 0.10 },
  "requiredFunds": false,
  "requirement": {
    "type": "object",
    "properties": { "token_address": { "type": "string", "description": "Solana token mint address (base58, 32–44 characters)" } },
    "required": ["token_address"]
  }
}
```

**sol_wallet_risk:**
```json
{
  "name": "sol_wallet_risk",
  "description": "Counterparty intelligence and alpha discovery for Solana wallets. Call this when assessing a wallet you are trading against, receiving funds from, or considering copying. Returns two orthogonal signals: (1) risk classification — LOW_RISK, HIGH_RISK, or UNKNOWN — with supporting risk_signals; (2) copy_trading worthiness — HIGH, MEDIUM, LOW, or UNKNOWN — indicating whether this wallet is worth following. Classifies UNKNOWN rather than HIGH_RISK when history is insufficient. Also returns MEV victim score, MEV bot detection, sniper score, pump.fun graduation exit rate, and early entry rate. $0.10 per call, under 20 seconds.",
  "jobFee": 0.10, "jobFeeType": "fixed",
  "priceV2": { "type": "fixed", "value": 0.10 },
  "requiredFunds": false,
  "requirement": {
    "type": "object",
    "properties": { "wallet_address": { "type": "string", "description": "Solana wallet address (base58, 32–44 characters)" } },
    "required": ["wallet_address"]
  }
}
```

**sol_deep_dive:**
```json
{
  "name": "sol_deep_dive",
  "description": "Adversarial risk engine for Solana tokens. Call this when sol_quick_scan returns grade B or above and you need deeper due diligence before a significant position. Introduces adversarial intelligence not in quick scan: insider wallet clustering, launch pattern detection (STEALTH_LAUNCH/FAIR_LAUNCH), wash trading score, dev wallet history, sniper activity at launch, and a structured recommendation (AVOID/WATCH/CONSIDER/DYOR) with reasoning and time horizon. All signals are additive — does not repeat quick scan. $0.50 per call, under 30 seconds.",
  "jobFee": 0.50, "jobFeeType": "fixed",
  "priceV2": { "type": "fixed", "value": 0.50 },
  "requiredFunds": false,
  "requirement": {
    "type": "object",
    "properties": { "token_address": { "type": "string", "description": "Solana token mint address (base58, 32–44 characters)" } },
    "required": ["token_address"]
  }
}
```

---

## Revenue Tracker

Middleware hooks into Hono. Logs per-service call counts to SQLite (`better-sqlite3`).
DB at `/root/solprobe/data/revenue.db`. Do not modify scanner logic — middleware only.

---

## Health Watchdog

```typescript
const res = await fetch("http://localhost:8000/health");
const health = await res.json();
if (health.status !== "ok") {
  console.error(`[watchdog] DEGRADED — down sources: ${health.degraded_sources.join(", ")}`);
  process.exit(1);
}
```

---

## Process Management

```javascript
module.exports = {
  apps: [
    {
      name: "solprobe", script: "./start.sh", interpreter: "bash",
      restart_delay: 3000, max_restarts: 20, watch: false,
      env: { NODE_ENV: "production" },
      log_file: "logs/combined.log", error_file: "logs/error.log", time: true,
    },
    { name: "acp-seller" },
    {
      name: "health-watchdog", script: "scripts/healthWatchdog.ts",
      interpreter: "npx", interpreter_args: "tsx",
      cron_restart: "*/5 * * * *", autorestart: false,
    },
  ]
};
```

---

## Tests (Vitest)

1. **`quickScan.test.ts`** — BONK (grade A, `grade_type: "STRUCTURAL_SAFETY"`,
   `schema_version: "2.0"`), known rug (F), `scope.excludes` present,
   `liquidity_check` populated, `isValidSolanaAddress` rejects garbage,
   USDC grades A/B with `authority_exempt: true`.
   Mock rule: `lp_burned: true` for healthy TRADITIONAL_AMM mocks.

2. **`walletRisk.test.ts`**
   - `total_trades < 10` → `classification: "UNKNOWN"`
   - `total_trades < 20` → `copy_trading.worthiness: "UNKNOWN"` with non-null `reason`
   - `total_trades >= 20` → `copy_trading.worthiness` is LOW/MEDIUM/HIGH
   - `sample_size < 50` → `copy_trading.confidence <= 0.5`
   - HIGH_RISK wallet can have HIGH copy_trading worthiness (orthogonality test)
   - LOW_RISK wallet can have UNKNOWN copy_trading worthiness (orthogonality test)
   - Bot wallet → `copy_trading.worthiness: "UNKNOWN"` with bot-specific reason
   - `score` is structured object with `components`
   - `risk_signals[]` always populated
   - `activity` object shape present
   - `mev_victim_score` is number 0–100, never undefined
   - `is_mev_bot` is boolean, never undefined
   - `pumpfun_graduation_exit_rate_pct` is null when no pump.fun history
   - `early_entry_rate_pct` is null when fewer than 5 tokens have timing data
   - `historical_exposure.high_risk_tokens_traded` uncapped (test with 30-token wallet)
   - `schema_version === "2.0"` on every response

3. **`deepDive.test.ts`** — `recommendation` always structured object, `risk_breakdown`
   all 4 sub-fields, `wallet_analysis` present, `key_drivers[]` populated, protocol
   addresses not flagged, `momentum_score` 0–100, `schema_version === "2.0"`.

4. **`marketIntel.test.ts`** — `buy_sell_ratio` numeric, `volatility` populated,
   `price_change_5m_pct` null without Birdeye key, all three new subtypes,
   DEAD → BEARISH override, HAWK-like token → BEARISH + `data_quality: "LIMITED"`,
   `schema_version === "2.0"`.

5. **`sources.test.ts`** — real API response shapes from live curl. Parallel fetching,
   Helius always called for authority flags, Jupiter returns `authority_exempt: true`
   for stablecoin tags. RugCheck mock: `score: 5909`,
   `risks: [{name: "Single holder ownership", level: "danger"}]`.
   Birdeye OHLCV mock: `data.items` array with `h` field per candle.

6. **`circuitBreaker.test.ts`** — CLOSED→OPEN (5 failures), OPEN rejects immediately,
   OPEN→HALF_OPEN (cooldown), HALF_OPEN→CLOSED (success).

---

## Environment Variables

```
HELIUS_API_KEY=
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
PORT=8000
LOG_LEVEL=info
BIRDEYE_API_KEY=          # pct_from_ath and price_change_5m_pct return null without key
ANTHROPIC_API_KEY=sk-ant-...
GROQ_API_KEY=gsk_...
AGENT_WALLET_PRIVATE_KEY=
SPROBE_TOKEN_ADDRESS=
BUYBACK_INTERVAL_MINUTES=60
BUYBACK_THRESHOLD_USDC=5.0
DRY_RUN=true
```

---

## Build Order (v2)

Priority: Wallet Risk → Deep Dive → Market Intel → Quick Scan.

1. `src/constants.ts`
2. `src/validate.ts`
3. `src/utils/retry.ts`
4. `src/circuitBreaker.ts`
5. `src/sources/resolver.ts`
6. `src/sources/jupiterTokenList.ts` — test `isAuthorityExempt` in isolation
7. `src/cache.ts`
8. `src/api/rateLimiter.ts`
9. `src/sources/dexscreener.ts` — verify `buy_sell_ratio` numeric against BONK
10. `src/sources/helius.ts` — `getTokenMintInfo()` + MEV parsing helpers
11. `src/sources/rugcheck.ts` — no authority flags, include `report_age_seconds`
12. `src/sources/birdeye.ts` — OHLCV daily + 5m/15m, `src/sources/solscan.ts`
13. `src/scanner/riskScorer.ts` — `calculateConfidence()` + authority exemption
14. `src/scanner/walletRisk.ts` — structured score, classification, copy_trading object,
    MEV signals, pump.fun signals, uncapped historical_exposure
15. **Test walletRisk in isolation** — copy_trading gating, orthogonality, MEV fields
16. `src/scanner/deepDive.ts` — risk_breakdown, wallet_analysis, launch_pattern,
    key_drivers, structured recommendation
17. **Live end-to-end test deep dive**
18. `src/scanner/marketIntel.ts` — numeric buy_sell_ratio, volatility, 5m/15m, subtypes
19. `src/llm/narrativeEngine.ts` — test wallet risk prompt covers both dimensions
20. `src/scanner/quickScan.ts` + `src/api/server.ts` — grade_type, scope, liquidity_check
21. **Live end-to-end test BONK and USDC**
22. ACP handlers — all 4 `handlers.ts` + updated `offering.json` descriptions
23. `scripts/revenueTracker.ts`, `scripts/healthWatchdog.ts`
24. Tests (circuitBreaker.test.ts first)

---

## What NOT to Do

### Schema versioning
- Do not omit `schema_version` from any response
- Do not bump version without updating all four services simultaneously
- Do not remove fields without bumping major version

### Source integrity
- Do not fetch authority flags from RugCheck — ever
- Do not make Helius authority call conditional — runs on every scan
- Do not use a static token whitelist — use Jupiter strict list
- Do not block startup waiting for Jupiter list — fire-and-forget
- Do not use `pairs[0]?.dexId` — always highest-liquidity pair
- Do not use `id.includes("orca")` — use `id.startsWith("orca")`
- Do not classify `raydiumclmm` as TRADITIONAL_AMM
- Do not use DexScreener dexId to detect pump.fun — use Helius creator program ID
- Do not error when Birdeye key missing — gracefully return null

### Output integrity
- Do not let LLM generate `factors[]`, `historical_flags[]`, `signal_subtype`,
  `key_drivers[]`, `risk_breakdown`, `classification`, or `copy_trading`
- Do not generate summary before `factors[]` is assembled
- Do not use "strong", "safe", "excellent" anywhere
- Do not fabricate confidence values
- Do not remove `data_confidence` string — backwards compat
- Do not omit `data_quality`, `missing_fields`, or `schema_version`

### Copy-trading rules (critical)
- Do not return `copy_trading.worthiness` as non-UNKNOWN when `total_trades < 20`
- Do not assign `copy_trading.confidence` above 0.5 when `sample_size < 50`
- Do not output a scalar copy_trade_worthiness score — always the structured object
- Do not merge `copy_trading.worthiness` with `classification`
- Do not let copy_trading signals reference token conditions (price, liquidity, volume)
- Do not use copy_trading to duplicate market intel logic
- Do not return `copy_trading.reason` as null when `worthiness === "UNKNOWN"`
- Do not apply copy_trading signals to bot wallets — gate to UNKNOWN with bot reason

### Service boundaries
- Do not include liquidity/volume/price in `sol_quick_scan` beyond `liquidity_check`
- Do not repeat structural safety in `sol_market_intel`
- Do not let `sol_deep_dive` repeat `sol_quick_scan`
- Do not classify wallet HIGH_RISK from thin history alone
- Do not return recommendation as bare string in deep dive

### LLM provider rules
- Do not call LLM before all parallel source fetches settle
- Do not let LLM provider failure propagate as scan error
- Do not use Sonnet/Mixtral for quick scan, wallet risk, or market intel
- Do not skip Groq fallback — template is last resort
- Do not add local model servers — VPS has no GPU

### Infrastructure rules
- Do not flag `0xe2890629...` or `0xF8DD39c7...` as suspicious
- Do not hardcode API keys
- Do not share cache TTLs across services
- Do not return object from `requestPayment` — plain string only
- Do not return raw object from `executeJob` — must be `{ deliverable: JSON.stringify(result) }`
- Do not expose `lp_burned` without `lp_status`
- Do not apply LP burn penalty on CLMM_DLMM
- Do not suppress errors after 3 genuine retries
- Do not modify `/root/virtuals-acp/` unless explicitly asked
- Do not call internal `quickScan()` for historical_exposure in parallel with primary
  sources — call sequentially after primary sources settle to avoid cascading timeouts

### Test rules
- Do not write mocks with invented field values — copy from live curl
- Do not set `lp_burned: null` in TRADITIONAL_AMM healthy mocks — use `true`
- Do not set `lp_burned: null` in CLMM/DLMM mocks without `lp_model: "CLMM_DLMM"`
- Do not assert `classification: "HIGH_RISK"` for thin-history mocks
- Do not assert `copy_trading.worthiness` as non-UNKNOWN for mocks with < 20 trades
- Do not assert `recommendation` as string in deep dive tests
- Do not assert `schema_version` is absent — must be on every response