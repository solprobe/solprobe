import type { LPModel, LPStatus } from "../sources/dexscreener.js";
import type { ScoringFactor, HistoricalFlag, FunderType } from "./types.js";

export type { ScoringFactor };

export interface RiskFactors {
  mint_authority_revoked: boolean | null;   // null → treat as false (25pt penalty)
  freeze_authority_revoked: boolean | null; // null → treat as false (15pt penalty)
  /** Birdeye-live adjusted holder concentration (protocol/DEX/burn addresses excluded). null → treat as 100% (worst-case) */
  adjusted_top_10_holder_pct: number | null;
  liquidity_usd: number | null;             // null → treat as $0 (worst-case)
  has_rug_history: boolean;                 // true → instant F
  bundled_launch: boolean;                  // true → penalty varies by confidence + token age
  /** Confidence from Birdeye bundler detection. null = fallback to RugCheck (treat as HIGH). */
  bundled_launch_confidence?: "HIGH" | "MEDIUM" | "LOW" | null;
  buy_sell_ratio: number | null;            // null → no penalty (insufficient data)
  token_age_days: number | null;            // null → 10pt penalty
  /** Birdeye-live: any single non-excluded holder ≥ 15% of supply */
  single_holder_danger: boolean;
  lp_burned: boolean | null;               // raw burn check result (false or null before derivation)
  lp_model: LPModel;                        // DEX model — determines whether LP burn is meaningful
  lp_status: LPStatus;                      // derived from lp_burned + lp_model
  dex_id: string | null;                    // dexId of the primary pair
  dev_wallet_age_days: number | null;       // deep dive only; null for quick scan
  launch_pattern?: "SAME_BLOCK" | "WITHIN_5_BLOCKS" | "NORMAL" | "UNKNOWN"; // quick scan only
  // Dev wallet funding source type (deep dive only)
  dev_funder_type?: FunderType | null;
  // Deep dive supplemental signals
  is_mutable_metadata?: boolean | null;             // Birdeye token_security.mutableMetadata
  update_authority_is_deployer?: boolean | null;    // metaplexUpdateAuthority === creatorAddress
  authority_ever_regranted?: boolean;               // any SET_AUTHORITY tx post-launch
  wash_trading_circular_pairs?: number;             // A→B→A circular swap pairs detected
  post_launch_mints?: number;                       // MINT_TO events after token creation
  // Birdeye-derived supply signals
  creator_supply_pct?: number | null;               // creator's % of total supply
}

export type RiskGrade = "A" | "B" | "C" | "D" | "F";

export interface RiskGradeResult {
  grade: RiskGrade;
  scoringFactors: ScoringFactor[];
  rawScore: number;
}

export function calculateRiskGrade(
  factors: RiskFactors,
  exempt: boolean = false
): RiskGradeResult {
  if (factors.has_rug_history) {
    return {
      grade: "F",
      rawScore: 0,
      scoringFactors: [
        {
          name: "rug_history",
          value: true,
          impact: -100,
          interpretation: "confirmed rug pull history — automatic F",
        },
      ],
    };
  }

  const sf: ScoringFactor[] = [];
  let score = 100;

  // Authority penalties — skipped for exempt tokens (stablecoins, wrapped assets)
  if (!exempt) {
    if (factors.mint_authority_revoked !== true) {
      score -= 25;
      sf.push({
        name: "mint_authority",
        value: factors.mint_authority_revoked,
        impact: -25,
        interpretation: "mint authority active — inflation risk",
      });
    } else {
      sf.push({
        name: "mint_authority",
        value: true,
        impact: 0,
        interpretation: "mint authority revoked — safe",
      });
    }

    if (factors.freeze_authority_revoked !== true) {
      score -= 15;
      sf.push({
        name: "freeze_authority",
        value: factors.freeze_authority_revoked,
        impact: -15,
        interpretation: "freeze authority active — funds can be frozen",
      });
    } else {
      sf.push({
        name: "freeze_authority",
        value: true,
        impact: 0,
        interpretation: "freeze authority revoked — safe",
      });
    }
  }

  // Holder concentration — Birdeye-adjusted (protocol/DEX/burn addresses excluded), skipped for exempt tokens
  if (!exempt) {
    const adj = factors.adjusted_top_10_holder_pct ?? 100;
    if (adj > 90) {
      score -= 35;
      sf.push({
        name: "top_10_holder_concentration",
        value: adj,
        impact: -35,
        interpretation: `top-10 hold ${adj.toFixed(0)}% — extreme concentration`,
      });
    } else if (adj > 60) {
      score -= 20;
      sf.push({
        name: "top_10_holder_concentration",
        value: adj,
        impact: -20,
        interpretation: `top-10 hold ${adj.toFixed(0)}% — high concentration`,
      });
    } else {
      sf.push({
        name: "top_10_holder_concentration",
        value: adj,
        impact: 0,
        interpretation: `top-10 hold ${adj.toFixed(0)}% — healthy distribution`,
      });
    }
  }

  // Creator supply concentration — Birdeye-derived, replaces RugCheck score penalties
  if (factors.creator_supply_pct !== null && factors.creator_supply_pct !== undefined) {
    if (factors.creator_supply_pct > 20) {
      score -= 30;
      sf.push({
        name: "creator_supply_pct",
        value: factors.creator_supply_pct,
        impact: -30,
        interpretation: `creator holds ${factors.creator_supply_pct.toFixed(1)}% of supply (>20%)`,
      });
    } else if (factors.creator_supply_pct > 10) {
      score -= 15;
      sf.push({
        name: "creator_supply_pct",
        value: factors.creator_supply_pct,
        impact: -15,
        interpretation: `creator holds ${factors.creator_supply_pct.toFixed(1)}% of supply (>10%)`,
      });
    } else if (factors.creator_supply_pct > 5) {
      score -= 5;
      sf.push({
        name: "creator_supply_pct",
        value: factors.creator_supply_pct,
        impact: -5,
        interpretation: `creator holds ${factors.creator_supply_pct.toFixed(1)}% of supply (>5%)`,
      });
    } else {
      sf.push({
        name: "creator_supply_pct",
        value: factors.creator_supply_pct,
        impact: 0,
        interpretation: `creator holds ${factors.creator_supply_pct.toFixed(1)}% of supply — normal`,
      });
    }
  } else {
    sf.push({
      name: "creator_supply_pct",
      value: null,
      impact: 0,
      interpretation: "creator supply % unavailable",
    });
  }

  // Single holder danger — live Birdeye when available, RugCheck fallback
  if (factors.single_holder_danger) {
    score -= 25;
    sf.push({
      name: "single_holder_danger",
      value: true,
      impact: -25,
      interpretation: "single wallet holds dangerous supply pct",
    });
  } else {
    sf.push({
      name: "single_holder_danger",
      value: false,
      impact: 0,
      interpretation: "no single-holder danger detected",
    });
  }

  // LP burn — penalty depends on DEX model and whether the holder is a known protocol
  if (factors.lp_status !== "BURNED" && factors.lp_status !== "NOT_APPLICABLE") {
    if (factors.lp_model === "TRADITIONAL_AMM") {
      // CUSTODIAL: LP held by a verified protocol wallet — reduced penalty vs UNKNOWN
      // (not an anonymous rug vector, but single-point-of-failure platform risk)
      const penalty = factors.lp_status === "UNBURNED"   ? 25
                    : factors.lp_status === "CUSTODIAL"  ?  5
                    : /* UNKNOWN */                         10;
      score -= penalty;
      sf.push({
        name: "lp_status",
        value: factors.lp_status,
        impact: -penalty,
        interpretation:
          factors.lp_status === "UNBURNED"
            ? "LP not burned on AMM — rug risk"
            : factors.lp_status === "CUSTODIAL"
            ? "LP held by verified protocol custodian — platform risk only"
            : "LP burn status unknown on AMM",
      });
    } else {
      // UNKNOWN model
      const penalty = factors.lp_status === "UNBURNED"   ? 25
                    : factors.lp_status === "CUSTODIAL"  ?  3
                    : /* UNKNOWN */                          5;
      score -= penalty;
      sf.push({
        name: "lp_status",
        value: factors.lp_status,
        impact: -penalty,
        interpretation:
          factors.lp_status === "UNBURNED"
            ? "LP not burned — rug risk"
            : factors.lp_status === "CUSTODIAL"
            ? "LP held by verified protocol custodian — platform risk only"
            : "LP burn unknown — DEX model uncertain",
      });
    }
  } else {
    sf.push({
      name: "lp_status",
      value: factors.lp_status,
      impact: 0,
      interpretation:
        factors.lp_status === "BURNED"
          ? "LP burned — liquidity locked"
          : `${factors.dex_id ?? "DEX"} CLMM — LP burn not applicable`,
    });
  }

  // Liquidity — penalty uses raw value; factor exposes rating label only (service boundary)
  const liq = factors.liquidity_usd ?? 0;
  const liquidityRating: "DEEP" | "ADEQUATE" | "THIN" | "CRITICAL" | "UNKNOWN" =
    factors.liquidity_usd === null || factors.liquidity_usd === undefined ? "UNKNOWN"
    : liq >= 500_000  ? "DEEP"
    : liq >= 50_000   ? "ADEQUATE"
    : liq >= 5_000    ? "THIN"
    : "CRITICAL";
  if (liq < 1_000) {
    score -= 35;
    sf.push({
      name: "liquidity_check",
      value: liquidityRating,
      impact: -35,
      interpretation: "critically low liquidity (<$1k)",
    });
  } else if (liq < 10_000) {
    score -= 20;
    sf.push({
      name: "liquidity_check",
      value: liquidityRating,
      impact: -20,
      interpretation: "low liquidity (<$10k)",
    });
  } else {
    sf.push({
      name: "liquidity_check",
      value: liquidityRating,
      impact: 0,
      interpretation:
        liq >= 1_000_000
          ? "deep liquidity"
          : liq >= 100_000
          ? "adequate liquidity"
          : "moderate liquidity",
    });
  }

  // Bundled launch — penalty scaled by detection confidence and token age.
  //
  // Confidence gate: Birdeye fires at ≥3 buyers in a single block (LOW bar). Only HIGH
  // confidence (≥2 coordinated blocks) justifies the full penalty. MEDIUM gets half.
  // RugCheck fallback has no confidence metadata → treated as HIGH (conservative).
  //
  // Age decay: the risk of a bundled launch is that coordinated wallets DUMP. After 90 days
  // of live trading with no coordinated sell-off, the temporal threat has largely passed.
  // Penalty is halved for tokens 30–90 days old, quartered for tokens >90 days old.
  if (factors.bundled_launch) {
    // Step 1: confidence gate
    // null confidence = RugCheck fallback (no granularity) → treat conservatively as HIGH
    const conf = factors.bundled_launch_confidence ?? "HIGH";
    const confidencePenalty = conf === "HIGH" ? 20 : conf === "MEDIUM" ? 10 : 0;

    // Step 2: age decay (applied on top of confidence penalty)
    const ageDays = factors.token_age_days;
    const ageMultiplier =
      ageDays === null   ? 1.0   // unknown age → no decay (conservative)
      : ageDays > 90     ? 0.25  // established token → coordinated dump threat largely past
      : ageDays > 30     ? 0.5   // moderate age → partial decay
      : 1.0;                     // fresh token → full penalty

    const penalty = Math.round(confidencePenalty * ageMultiplier);
    score -= penalty;

    const confLabel = conf === "HIGH" ? "high-confidence" : conf === "MEDIUM" ? "medium-confidence" : "low-confidence";
    const ageLabel  = ageDays === null ? "" : ageDays > 90 ? ", age-decayed" : ageDays > 30 ? ", partially age-decayed" : "";
    sf.push({
      name: "bundled_launch",
      value: true,
      impact: -penalty,
      interpretation: penalty === 0
        ? `bundled launch detected (${confLabel}${ageLabel}) — threat negligible`
        : `bundled launch detected (${confLabel}${ageLabel}) — coordinated insiders`,
    });
  } else {
    sf.push({
      name: "bundled_launch",
      value: false,
      impact: 0,
      interpretation: "no bundled launch detected",
    });
  }

  // Buy/sell pressure
  // buy_sell_ratio = buys / (buys + sells): 0.5 = equal, 1.0 = all buys, 0.0 = all sells
  function bsrInterpretation(r: number): string {
    const buyPct = Math.round(r * 100);
    const sellPct = 100 - buyPct;
    if (r >= 0.45 && r <= 0.55) return `balanced buy/sell pressure (1h)`;
    if (r > 0.55) return `buy-heavy — ${buyPct}% buys vs ${sellPct}% sells (1h)`;
    return `sell-heavy — ${sellPct}% sells vs ${buyPct}% buys (1h)`;
  }
  if (factors.buy_sell_ratio !== null && factors.buy_sell_ratio < 0.5) {
    score -= 10;
    sf.push({
      name: "buy_sell_ratio",
      value: factors.buy_sell_ratio,
      impact: -10,
      interpretation: bsrInterpretation(factors.buy_sell_ratio),
    });
  } else {
    sf.push({
      name: "buy_sell_ratio",
      value: factors.buy_sell_ratio,
      impact: 0,
      interpretation:
        factors.buy_sell_ratio === null
          ? "buy/sell ratio unavailable"
          : bsrInterpretation(factors.buy_sell_ratio),
    });
  }

  // Token age
  if (factors.token_age_days === null) {
    score -= 10;
    sf.push({
      name: "token_age_days",
      value: null,
      impact: -10,
      interpretation: "token age unknown",
    });
  } else if (factors.token_age_days < 1) {
    score -= 15;
    sf.push({
      name: "token_age_days",
      value: factors.token_age_days,
      impact: -15,
      interpretation: "token launched today — extreme caution",
    });
  } else {
    sf.push({
      name: "token_age_days",
      value: Math.round(factors.token_age_days),
      impact: 0,
      interpretation:
        factors.token_age_days > 30
          ? `established token (${Math.round(factors.token_age_days)}d old)`
          : `young token (${Math.round(factors.token_age_days)}d old)`,
    });
  }

  // Dev wallet age — applies to quickScan (via Birdeye first-funded) and deep dive
  if (factors.dev_wallet_age_days !== null) {
    if (factors.dev_wallet_age_days < 1) {
      score -= 30;
      sf.push({
        name: "dev_wallet_age",
        value: factors.dev_wallet_age_days,
        impact: -30,
        interpretation: "dev wallet created today — extreme red flag",
      });
    } else if (factors.dev_wallet_age_days < 7) {
      score -= 20;
      sf.push({
        name: "dev_wallet_age",
        value: factors.dev_wallet_age_days,
        impact: -20,
        interpretation: `fresh dev wallet (${Math.round(factors.dev_wallet_age_days)}d old)`,
      });
    } else {
      sf.push({
        name: "dev_wallet_age",
        value: Math.round(factors.dev_wallet_age_days),
        impact: 0,
        interpretation: `dev wallet aged (${Math.round(factors.dev_wallet_age_days)}d old)`,
      });
    }
  }

  // Metadata immutability (deep dive only — undefined when not supplied)
  if (factors.is_mutable_metadata !== undefined && factors.is_mutable_metadata !== null) {
    if (factors.is_mutable_metadata) {
      const penalty = factors.update_authority_is_deployer ? 20 : 10;
      score -= penalty;
      sf.push({
        name: "metadata_mutability",
        value: true,
        impact: -penalty,
        interpretation: factors.update_authority_is_deployer
          ? "mutable metadata controlled by deployer — rug risk"
          : "mutable metadata — unknown update authority",
      });
    } else {
      sf.push({
        name: "metadata_mutability",
        value: false,
        impact: 0,
        interpretation: "metadata immutable — cannot be changed post-launch",
      });
    }
  }

  // Authority regranted post-launch (deep dive only)
  if (factors.authority_ever_regranted !== undefined) {
    if (factors.authority_ever_regranted) {
      score -= 40;
      sf.push({
        name: "authority_regranted",
        value: true,
        impact: -40,
        interpretation: "mint authority regranted post-launch — extreme risk",
      });
    } else {
      sf.push({
        name: "authority_regranted",
        value: false,
        impact: 0,
        interpretation: "no post-launch authority changes detected",
      });
    }
  }

  // Circular wash trading (deep dive only)
  if (factors.wash_trading_circular_pairs !== undefined) {
    if (factors.wash_trading_circular_pairs > 10) {
      score -= 10;
      sf.push({
        name: "circular_wash_trading",
        value: factors.wash_trading_circular_pairs,
        impact: -10,
        interpretation: `${factors.wash_trading_circular_pairs} circular swap pairs — wash risk`,
      });
    } else {
      sf.push({
        name: "circular_wash_trading",
        value: factors.wash_trading_circular_pairs,
        impact: 0,
        interpretation: factors.wash_trading_circular_pairs > 0
          ? `${factors.wash_trading_circular_pairs} circular pairs — below threshold`
          : "no circular trading detected",
      });
    }
  }

  // Post-launch minting (deep dive only — supply inflation signal)
  if (factors.post_launch_mints !== undefined) {
    if (factors.post_launch_mints > 0) {
      score -= 15;
      sf.push({
        name: "post_launch_mints",
        value: factors.post_launch_mints,
        impact: -15,
        interpretation: `${factors.post_launch_mints} post-launch mint events — dilution risk`,
      });
    } else {
      sf.push({
        name: "post_launch_mints",
        value: 0,
        impact: 0,
        interpretation: "no post-launch minting detected",
      });
    }
  }

  // Dev wallet funding source (deep dive only — undefined when not fetched)
  if (factors.dev_funder_type !== undefined && factors.dev_funder_type !== null) {
    if (factors.dev_funder_type === "MIXER") {
      score -= 25;
      sf.push({ name: "dev_funding_source", value: "MIXER", impact: -25, interpretation: "dev wallet funded via mixer — anonymous funding chain" });
    } else if (factors.dev_funder_type === "DEPLOYER") {
      score -= 15;
      sf.push({ name: "dev_funding_source", value: "DEPLOYER", impact: -15, interpretation: "dev wallet funded by deployer-pattern wallet" });
    } else if (factors.dev_funder_type === "FRESH_WALLET") {
      score -= 10;
      sf.push({ name: "dev_funding_source", value: "FRESH_WALLET", impact: -10, interpretation: "dev wallet funded by fresh wallet — possible proxy" });
    } else {
      sf.push({ name: "dev_funding_source", value: factors.dev_funder_type, impact: 0, interpretation: `dev funding source: ${factors.dev_funder_type}` });
    }
  }

  // Launch anomaly — quick scan only (undefined when not fetched)
  if (factors.launch_pattern === "SAME_BLOCK") {
    score -= 20;
    sf.push({
      name: "launch_anomaly",
      value: "SAME_BLOCK",
      impact: -20,
      interpretation: "mint and pool created same block — coordinated launch",
    });
  } else if (factors.launch_pattern === "WITHIN_5_BLOCKS") {
    score -= 10;
    sf.push({
      name: "launch_anomaly",
      value: "WITHIN_5_BLOCKS",
      impact: -10,
      interpretation: "pool initialised within 5 blocks of mint",
    });
  } else if (factors.launch_pattern !== undefined) {
    sf.push({
      name: "launch_anomaly",
      value: factors.launch_pattern,
      impact: 0,
      interpretation:
        factors.launch_pattern === "NORMAL"
          ? "no same-block launch anomaly detected"
          : "launch timing data unavailable",
    });
  }

  // Clamp to [0, 100]
  score = Math.max(0, Math.min(100, score));

  const grade: RiskGrade =
    score >= 80 ? "A" :
    score >= 60 ? "B" :
    score >= 40 ? "C" :
    score >= 20 ? "D" : "F";

  return { grade, rawScore: score, scoringFactors: sf };
}

export function calculateConfidence(data: {
  sources_available: number;
  sources_total: number;
  data_age_ms: number;
  token_health?: string;
  signals_agree?: boolean;
}): { model: number; data_completeness: number; signal_consensus: number } {
  const data_completeness = data.sources_available / data.sources_total;

  let model = data_completeness;
  if (data.data_age_ms > 60_000)  model -= 0.1;
  if (data.data_age_ms > 300_000) model -= 0.2;
  if (data.token_health === "DEAD" || data.token_health === "ILLIQUID")
    model = Math.min(model, 0.3);
  if (data.token_health === "LOW_ACTIVITY") model = Math.min(model, 0.6);
  model = Math.max(0, Math.min(1, Math.round(model * 100) / 100));

  const signal_consensus = data.signals_agree === false ? 0.5 : data_completeness;

  return {
    model,
    data_completeness: Math.round(data_completeness * 100) / 100,
    signal_consensus:  Math.round(signal_consensus  * 100) / 100,
  };
}

export function confidenceToString(c: number): "HIGH" | "MEDIUM" | "LOW" {
  if (c >= 0.7) return "HIGH";
  if (c >= 0.4) return "MEDIUM";
  return "LOW";
}

export function buildHistoricalFlags(data: {
  has_rug_history: boolean;
  bundled_launch: boolean;
  single_holder_danger: boolean;
  dev_wallet_analysis?: { previous_rugs: boolean };
  launch_pattern?: "SAME_BLOCK" | "WITHIN_5_BLOCKS" | "NORMAL" | "UNKNOWN";
}): HistoricalFlag[] {
  const flags: HistoricalFlag[] = [];
  if (data.has_rug_history) flags.push("PAST_RUG");
  if (data.bundled_launch) flags.push("BUNDLED_LAUNCH");
  if (data.single_holder_danger) flags.push("SINGLE_HOLDER_DANGER");
  if (data.dev_wallet_analysis?.previous_rugs) flags.push("DEV_EXITED");
  if (data.launch_pattern === "SAME_BLOCK") flags.push("SAME_BLOCK_LAUNCH");
  return flags;
}

export function scoreConfidence(
  sources: string[],
  dataAgeMs: number,
  rugCheckAgeSeconds?: number
): "HIGH" | "MEDIUM" | "LOW" {
  const corroborated = sources.length >= 2;
  const fresh = dataAgeMs < 60_000;

  let result: "HIGH" | "MEDIUM" | "LOW";
  if (corroborated && fresh) result = "HIGH";
  else if (corroborated || fresh) result = "MEDIUM";
  else result = "LOW";

  // RugCheck's bundled_launch / insider_flags data is used in deep dive only.
  // A staleness threshold of 24 h is acceptable for those historical pattern fields.
  // Authority flags (mint, freeze) come from Helius live — not affected by this cap.
  if (rugCheckAgeSeconds !== undefined && rugCheckAgeSeconds > 86_400) {
    if (result === "HIGH") result = "MEDIUM";
  }

  return result;
}
