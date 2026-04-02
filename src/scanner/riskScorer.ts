import type { LPModel, LPStatus } from "../sources/dexscreener.js";
import type { ScoringFactor, HistoricalFlag } from "./types.js";

export type { ScoringFactor };

export interface RiskFactors {
  mint_authority_revoked: boolean | null;   // null → treat as false (25pt penalty)
  freeze_authority_revoked: boolean | null; // null → treat as false (15pt penalty)
  top_10_holder_pct: number | null;         // null → treat as 100% (worst-case)
  liquidity_usd: number | null;             // null → treat as $0 (worst-case)
  has_rug_history: boolean;                 // true → instant F
  bundled_launch: boolean;                  // true → 20pt penalty
  buy_sell_ratio: number | null;            // null → no penalty (insufficient data)
  token_age_days: number | null;            // null → 10pt penalty
  rugcheck_risk_score: number | null;       // RugCheck aggregate score
  single_holder_danger: boolean;            // RugCheck risks[] "Single holder ownership" at danger
  lp_burned: boolean | null;               // raw burn check result (false or null before derivation)
  lp_model: LPModel;                        // DEX model — determines whether LP burn is meaningful
  lp_status: LPStatus;                      // derived from lp_burned + lp_model
  dex_id: string | null;                    // dexId of the primary pair
  dev_wallet_age_days: number | null;       // deep dive only; null for quick scan
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

  // Holder concentration — skipped for exempt tokens
  if (!exempt) {
    const holderPct = factors.top_10_holder_pct ?? 100;
    if (holderPct > 90) {
      score -= 35;
      sf.push({
        name: "top_10_holders",
        value: factors.top_10_holder_pct,
        impact: -35,
        interpretation: `top-10 hold ${holderPct.toFixed(0)}% — extreme concentration`,
      });
    } else if (holderPct > 60) {
      score -= 20;
      sf.push({
        name: "top_10_holders",
        value: factors.top_10_holder_pct,
        impact: -20,
        interpretation: `top-10 hold ${holderPct.toFixed(0)}% — high concentration`,
      });
    } else {
      sf.push({
        name: "top_10_holders",
        value: factors.top_10_holder_pct,
        impact: 0,
        interpretation: `top-10 hold ${holderPct.toFixed(0)}% — healthy distribution`,
      });
    }
  }

  // RugCheck risk score — never skipped for exempt tokens
  if (factors.rugcheck_risk_score !== null && factors.rugcheck_risk_score !== undefined) {
    if (factors.rugcheck_risk_score > 5_000) {
      score -= 30;
      sf.push({
        name: "rugcheck_score",
        value: factors.rugcheck_risk_score,
        impact: -30,
        interpretation: "extreme rug risk score (>5000)",
      });
    } else if (factors.rugcheck_risk_score > 2_000) {
      score -= 20;
      sf.push({
        name: "rugcheck_score",
        value: factors.rugcheck_risk_score,
        impact: -20,
        interpretation: "high rug risk score (>2000)",
      });
    } else if (factors.rugcheck_risk_score > 1_000) {
      score -= 10;
      sf.push({
        name: "rugcheck_score",
        value: factors.rugcheck_risk_score,
        impact: -10,
        interpretation: "elevated rug risk score (>1000)",
      });
    } else {
      sf.push({
        name: "rugcheck_score",
        value: factors.rugcheck_risk_score,
        impact: 0,
        interpretation: "low risk score",
      });
    }
  } else {
    sf.push({
      name: "rugcheck_score",
      value: null,
      impact: 0,
      interpretation: "RugCheck score unavailable",
    });
  }

  // Single holder danger from RugCheck risks[] — never skipped
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

  // LP burn — penalty depends on DEX model
  if (factors.lp_status !== "BURNED" && factors.lp_status !== "NOT_APPLICABLE") {
    if (factors.lp_model === "TRADITIONAL_AMM") {
      const penalty = factors.lp_status === "UNBURNED" ? 25 : 10;
      score -= penalty;
      sf.push({
        name: "lp_status",
        value: factors.lp_status,
        impact: -penalty,
        interpretation:
          factors.lp_status === "UNBURNED"
            ? "LP not burned on AMM — rug risk"
            : "LP burn status unknown on AMM",
      });
    } else {
      // UNKNOWN model
      const penalty = factors.lp_status === "UNBURNED" ? 25 : 5;
      score -= penalty;
      sf.push({
        name: "lp_status",
        value: factors.lp_status,
        impact: -penalty,
        interpretation:
          factors.lp_status === "UNBURNED"
            ? "LP not burned — rug risk"
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

  // Bundled launch
  if (factors.bundled_launch) {
    score -= 20;
    sf.push({
      name: "bundled_launch",
      value: true,
      impact: -20,
      interpretation: "bundled launch detected — coordinated insiders",
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
  if (factors.buy_sell_ratio !== null && factors.buy_sell_ratio < 0.5) {
    score -= 10;
    sf.push({
      name: "buy_sell_ratio",
      value: factors.buy_sell_ratio,
      impact: -10,
      interpretation: `sell-heavy (${(factors.buy_sell_ratio * 100).toFixed(0)}% buys)`,
    });
  } else {
    sf.push({
      name: "buy_sell_ratio",
      value: factors.buy_sell_ratio,
      impact: 0,
      interpretation:
        factors.buy_sell_ratio === null
          ? "buy/sell ratio unavailable"
          : `balanced pressure (${(factors.buy_sell_ratio * 100).toFixed(0)}% buys)`,
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

  // Dev wallet age — deep dive only (null for quick scan)
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
  rugcheck_age_seconds?: number;
  token_health?: string;
  signals_agree?: boolean;
}): { model: number; data_completeness: number; signal_consensus: number } {
  const data_completeness = data.sources_available / data.sources_total;

  let model = data_completeness;
  if (data.data_age_ms > 60_000)  model -= 0.1;
  if (data.data_age_ms > 300_000) model -= 0.2;
  if (data.rugcheck_age_seconds && data.rugcheck_age_seconds > 86_400) model -= 0.15;
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
}): HistoricalFlag[] {
  const flags: HistoricalFlag[] = [];
  if (data.has_rug_history) flags.push("PAST_RUG");
  if (data.bundled_launch) flags.push("BUNDLED_LAUNCH");
  if (data.single_holder_danger) flags.push("SINGLE_HOLDER_DANGER");
  if (data.dev_wallet_analysis?.previous_rugs) flags.push("DEV_EXITED");
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
