// ---------------------------------------------------------------------------
// Agent-Native Intelligence Types
// Shared across all four SolProbe services.
// ---------------------------------------------------------------------------

/**
 * A single factor that contributed to (or was checked against) the risk score.
 * Every scoring condition — pass AND fail — must emit an entry.
 * impact: 0 means "checked and passed". Agents need to see the full picture.
 */
export interface ScoringFactor {
  name: string;           // machine-readable key, e.g. "mint_authority"
  value: number | string | boolean | null; // raw value from source
  impact: number;         // score change: negative = penalty, 0 = neutral, positive = bonus
  interpretation: string; // short human-readable explanation, max 60 chars
}

/**
 * Deterministic market signal subtype — derived from rules in marketIntel.ts,
 * never from the LLM.
 */
export type SignalSubtype =
  | "NO_VOLUME_ACTIVITY"       // near-zero volume — token dead or illiquid
  | "EARLY_PUMP"               // sharp price rise + high buy pressure + young token
  | "DISTRIBUTION_PHASE"       // high sell pressure + declining price + active volume
  | "POST_RUG_STAGNATION"      // dead volume + >80% below ATH (likely rugged)
  | "HIGH_SPECULATION"         // extreme price volatility + thin liquidity
  | "ORGANIC_GROWTH"           // steady volume + balanced pressure + rising price
  | "NORMAL_CORRECTION"        // healthy token in pullback from ATH
  | "LOW_LIQUIDITY_TRAP"        // signal exists but liquidity too thin to act on safely
  | "SELL_PRESSURE_DOMINANCE"  // sustained sell pressure overwhelming buys numerically
  | "MOMENTUM_BREAKDOWN"       // recent bullish trend reversing with volume confirmation
  | "NONE";                    // no specific subtype detected

/**
 * Historical event flags derived from source data — never from the LLM.
 */
export type HistoricalFlag =
  | "PAST_RUG"                            // has_rug_history from RugCheck
  | "DEV_EXITED"                          // dev wallet sold all holdings (deep dive only)
  | "LIQUIDITY_REMOVAL_EVENT"             // large LP withdrawal on-chain
  | "BUNDLED_LAUNCH"                      // bundled_launch_detected from RugCheck
  | "INSIDER_ACTIVITY"                    // insider_flags from RugCheck
  | "SINGLE_HOLDER_DANGER"               // single_holder_danger from RugCheck risks[]
  | "DEV_ASSOCIATED_WITH_PREVIOUS_RUG"   // dev wallet linked to prior confirmed rug
  | "SUSPICIOUS_LAUNCH_PATTERN"          // stealth launch + sniper concentration
  | "SAME_BLOCK_LAUNCH"                  // mint and pool created in same block
  | "MUTABLE_METADATA"                   // token metadata is mutable post-launch (deep dive only)
  | "AUTHORITY_REGRANTED"               // mint authority was regranted after revocation (deep dive only)
  | "DEV_MIXER_FUNDED";                  // dev wallet funded via known mixer pattern (deep dive only)

/**
 * Top contributing factor in agent-friendly shape (deep dive only).
 * Built from ScoringFactor sort — never from the LLM.
 */
export interface KeyDriver {
  factor: string;                              // matches a ScoringFactor.name
  impact: "LOW" | "MEDIUM" | "HIGH";
  direction: "POSITIVE" | "NEGATIVE" | "NEUTRAL";
}

// ---------------------------------------------------------------------------
// Market Intel Feature Types (marketIntel.ts only — not shared across services)
// ---------------------------------------------------------------------------

/** Aggregated summary across multiple OHLCV candles. */
export interface OHLCVSummary {
  candles: number;
  volume_usd: number;
  high_usd: number;
  low_usd: number;
  /** Volume-weighted average price; null if total volume is zero. */
  vwap_usd: number | null;
}

/** Liquidity distribution across DEX pools (derived from DexScreener pairs). */
export interface LiquidityConcentration {
  total_pools: number;
  /** % of total liquidity held in the single largest pool. */
  top_pool_share_pct: number | null;
  /** dexId of the largest pool. */
  dominant_dex: string | null;
  /** LOW: top pool <60%, MEDIUM: 60–90%, HIGH: >90%, UNKNOWN: no liquidity data. */
  risk: "LOW" | "MEDIUM" | "HIGH" | "UNKNOWN";
}

export type TokenMaturityBracket = "NEW" | "YOUNG" | "ESTABLISHED" | "MATURE" | "UNKNOWN";

/** How long the token has been trading. */
export interface TokenMaturity {
  first_trade_unix_time: number | null;
  age_hours: number | null;
  bracket: TokenMaturityBracket;
  /** Which data source supplied the first-trade timestamp. */
  source: "birdeye" | "dexscreener" | null;
}

/** Short-term trading velocity and bot-activity detection. */
export interface TradingVelocity {
  /** Total trades in the last 1h (from Birdeye). */
  txns_per_hour: number | null;
  /** Average USD value per transaction (volume_1h_usd / txns_per_hour). */
  usd_per_tx: number | null;
  /** Std dev of 15m candle USD volumes; null when fewer than 4 candles available. */
  candle_vol_std_dev: number | null;
  /** True when usd_per_tx < $1 AND txns_per_hour > 500 — probable bot wash activity. */
  bot_activity_flag: boolean;
}

// ---------------------------------------------------------------------------
// Wallet Funding Source Types (walletRisk.ts + deepDive.ts)
// ---------------------------------------------------------------------------

export type FunderType =
  | "CEX"
  | "MIXER"
  | "FRESH_WALLET"
  | "DEPLOYER"
  | "KNOWN_PROTOCOL"
  | "PEER_WALLET"
  | "UNKNOWN";

export interface FundingSource {
  funder_address: string | null;
  funder_type: FunderType;
  funder_age_days: number | null;
  funder_tx_count: number | null;
  shared_funder_wallets: string[];
  cluster_size: number;
  risk: "HIGH" | "MEDIUM" | "LOW";
  risk_reason: string;
  action_guidance: string;
}

// ---------------------------------------------------------------------------
// Holder Concentration Types (deepDive.ts only)
// ---------------------------------------------------------------------------

export type ExclusionCategory = "BURN" | "DEX_POOL" | "CEX" | "KNOWN_PROTOCOL" | "INSIDER";

// ---------------------------------------------------------------------------
// Deep Dive Supplemental Types (deepDive.ts only)
// ---------------------------------------------------------------------------

export type LockType =
  | "PERMANENT_BURN"     // LP tokens sent to burn address
  | "PROGRAM_CONTROLLED" // DLMM/CLMM pool — no fungible LP token, program owns liquidity
  | "TIMED_LOCK"         // LP locked in time-lock contract
  | "NOT_APPLICABLE"     // CLMM/DLMM with no traditional LP token
  | "UNLOCKED"           // LP exists and is not burned or locked
  | "MIXED"              // multiple pools, some locked some not
  | "UNKNOWN"            // could not determine lock status
  | "TIMELOCK"           // legacy alias — kept for backwards compat
  | "NONE";              // no lock detected (legacy alias)

export interface PoolSafetyBreakdown {
  pool_address: string;
  dex: string | null;
  pool_type: "TRADITIONAL_AMM" | "DLMM_CLMM" | "UNKNOWN";
  safety: "BURNED" | "PROGRAM_CONTROLLED" | "LOCKED" | "UNLOCKED" | "UNKNOWN";
  safety_note: string;
}

export interface LiquidityLockStatus {
  locked: boolean;
  lock_type: LockType;
  /** null when permanently locked or lock duration is unknown */
  lock_duration_days: number | null;
  locked_pct: number;
  note: string | null;
  /** Number of pools assessed for LP lock status */
  pools_assessed: number;
  /** Number of pools where liquidity is safe (burned or program-controlled) */
  pools_safe: number;
  /** Per-pool safety breakdown */
  pool_safety_breakdown: PoolSafetyBreakdown[];
}

export type WashTradingRisk = "NONE" | "LOW" | "ELEVATED" | "HIGH" | "EXTREME";

export interface TradingPattern {
  buy_sell_ratio_1h: number;
  unique_buyers_24h: number;
  wash_trading_score: number;
  wash_trading_risk: WashTradingRisk;
  wash_trading_meaning: string;
  wash_trading_action_guidance: string;
  circular_pairs: number;
  wash_method: "GRAPH_ANALYSIS" | "HEURISTIC" | "UNKNOWN";
}

export interface AuthorityChange {
  tx_signature: string | null;
  slot: number | null;
  type: "SET_AUTHORITY" | "MINT_TO";
}

export interface AuthorityHistory {
  mint_authority_changes: AuthorityChange[];
  authority_ever_regranted: boolean;
}

export interface MetadataImmutability {
  is_mutable: boolean | null;
  update_authority: string | null;
  risk: "MUTABLE" | "IMMUTABLE" | "UNKNOWN";
  meaning: string;
  action_guidance: string;
}

export interface AdjustedHolderConcentration {
  adjusted_top_10_pct: number | null;
  excluded_count: number;
  excluded_pct: number;
  exclusions: Array<{ address: string; category: ExclusionCategory; pct: number }>;
  method: "BIRDEYE_SUPPLY" | "RUGCHECK_FALLBACK" | "UNAVAILABLE";
}

// ---------------------------------------------------------------------------

/** Multi-timeframe momentum alignment composite. */
export interface MomentumAlignment {
  /** Sum of per-timeframe votes: each timeframe contributes -1 (down), 0 (flat), +1 (up). Range -3 to +3. */
  score: number;
  /** True when all available timeframes agree on a non-zero direction. */
  aligned: boolean;
  direction: "BULL" | "BEAR" | "MIXED" | "UNKNOWN";
  timeframes_used: string[];
}

// ---------------------------------------------------------------------------
// Taint Analysis Types (walletRisk.ts — analysis/taintTracker.ts output)
// ---------------------------------------------------------------------------

/**
 * BFS taint propagation result for a wallet address.
 * Seeded from known rug deployers and exploit wallets.
 * Score decays by 0.6 per hop; capped at MAX_HOPS=3.
 */
export interface TaintAnalysis {
  /** 0.0–1.0 composite taint score. 1.0 = direct seed connection. */
  taint_score: number;
  taint_level: "NONE" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  /** Shortest path in hops to any seed address; null if no path found. */
  hops_from_seed: number | null;
  /** Address of the nearest known bad actor; null if no connection found. */
  closest_seed: string | null;
  /** Number of distinct seed addresses that can reach this wallet. */
  seeds_reachable: number;
  /** True when the BFS hit MAX_NODES_VISITED before completing — result may be incomplete. */
  graph_limit_hit: boolean;
  /** Human-readable explanation of what the taint level means. */
  meaning: string;
  /** Recommended action given the taint level. */
  action_guidance: string;
}

// ---------------------------------------------------------------------------
// Cluster Group Types (deepDive.ts — analysis/clusterDetection.ts output)
// ---------------------------------------------------------------------------

/**
 * A single signal that contributed to forming a wallet cluster.
 */
export interface ClusterSignal {
  type: "FEE_PAYER" | "FAN_OUT" | "TEMPORAL";
  strength: "STRONG" | "MEDIUM" | "WEAK";
  description: string;
}

/**
 * A detected cluster of wallets with enriched metadata.
 * Used in wallet_analysis.cluster_groups in WalletRiskResult.
 */
export interface ClusterGroup {
  cluster_id: string;
  wallets: string[];
  /** 0.0–1.0 average connection strength across all pairs in the cluster. */
  confidence: number;
  /** Which detection signals contributed to forming this cluster. */
  signals: ClusterSignal[];
  common_fee_payer: string | null;
  /** Combined supply % held by this cluster; null until deep dive populates it. */
  supply_pct_combined: number | null;
}

// ---------------------------------------------------------------------------
// Last Trade Types (deepDive.ts only)
// ---------------------------------------------------------------------------

/**
 * Adversarial freshness signal — when did the token last trade?
 * Sourced from Birdeye lastTradeUnixTime. Dead/dormant recency downgrades
 * the recommendation action in buildRecommendation().
 */
export interface LastTrade {
  /** Unix timestamp of the most recent trade; null when unavailable. */
  timestamp: number | null;
  /** Hours since the last trade; null when timestamp unavailable. */
  hours_ago: number | null;
  /** Freshness classification. */
  recency: "ACTIVE" | "RECENT" | "STALE" | "DORMANT" | "DEAD" | "UNKNOWN";
  /** Human-readable explanation of the recency band. */
  recency_note: string;
}
