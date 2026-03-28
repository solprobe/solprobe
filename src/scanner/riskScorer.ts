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
  lp_burned: boolean | null;               // null → unknown (no penalty); false → -25
  dev_wallet_age_days: number | null;       // deep dive only; no scoring penalty currently
}

export type RiskGrade = "A" | "B" | "C" | "D" | "F";

export function calculateRiskGrade(factors: RiskFactors, exempt: boolean = false): RiskGrade {
  if (factors.has_rug_history) return "F";

  let score = 100;

  // Authority penalties — skipped for exempt tokens (stablecoins, wrapped assets)
  if (!exempt) {
    if (factors.mint_authority_revoked !== true) score -= 25;
    if (factors.freeze_authority_revoked !== true) score -= 15;
  }

  // Holder concentration — skipped for exempt tokens
  // Stablecoin/wrapped asset reserves held by custodians are not rug risk
  if (!exempt) {
    const holderPct = factors.top_10_holder_pct ?? 100;
    if (holderPct > 95) {
      score -= 35;
    } else if (holderPct > 80) {
      score -= 20;
    }
  }

  // RugCheck risk score — never skipped for exempt tokens
  if (factors.rugcheck_risk_score !== null && factors.rugcheck_risk_score !== undefined) {
    if (factors.rugcheck_risk_score > 5_000) score -= 30;
    else if (factors.rugcheck_risk_score > 2_000) score -= 20;
    else if (factors.rugcheck_risk_score > 1_000) score -= 10;
  }

  // Single holder danger from RugCheck risks[] — never skipped
  if (factors.single_holder_danger) score -= 25;

  // LP burn — only penalise when explicitly detected as not burned (false)
  // null = unknown = no penalty (conservative: don't penalise lack of data)
  if (factors.lp_burned === false) score -= 25;

  // Liquidity
  const liq = factors.liquidity_usd ?? 0;
  if (liq < 1_000) {
    score -= 35;
  } else if (liq < 10_000) {
    score -= 20;
  }

  // Bundled launch
  if (factors.bundled_launch) score -= 20;

  // Buy/sell pressure
  if (factors.buy_sell_ratio !== null && factors.buy_sell_ratio < 0.5) score -= 10;

  // Token age
  if (factors.token_age_days === null) {
    score -= 10;
  } else if (factors.token_age_days < 1) {
    score -= 15;
  }

  // Clamp to [0, 100]
  score = Math.max(0, Math.min(100, score));

  if (score >= 80) return "A";
  if (score >= 60) return "B";
  if (score >= 40) return "C";
  if (score >= 20) return "D";
  return "F";
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
