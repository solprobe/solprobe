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
  | "SAME_BLOCK_LAUNCH";                 // mint and pool created in same block

/**
 * Top contributing factor in agent-friendly shape (deep dive only).
 * Built from ScoringFactor sort — never from the LLM.
 */
export interface KeyDriver {
  factor: string;                              // matches a ScoringFactor.name
  impact: "LOW" | "MEDIUM" | "HIGH";
  direction: "POSITIVE" | "NEGATIVE" | "NEUTRAL";
}
