/**
 * Runs the risk scorer in isolation, showing every penalty applied.
 * Usage: npx tsx scripts/risk_scorer_test.ts [address]
 */
import { getDexScreenerToken } from "../src/sources/dexscreener.js";
import { getRugCheckSummary } from "../src/sources/rugcheck.js";
import { getTokenInfo } from "../src/sources/helius.js";
import { calculateRiskGrade, type RiskFactors } from "../src/scanner/riskScorer.js";

const address = process.argv[2] ?? "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

(async () => {
  console.log(`\nFetching data for: ${address}\n`);

  const [dexResult, rugResult, rpcResult] = await Promise.allSettled([
    getDexScreenerToken(address, { timeout: 4000 }),
    getRugCheckSummary(address, { timeout: 3000 }),
    getTokenInfo(address, { timeout: 3000 }),
  ]);

  const dexData = dexResult.status === "fulfilled" ? dexResult.value : null;
  const rugData = rugResult.status === "fulfilled" ? rugResult.value : null;
  const rpcData = rpcResult.status === "fulfilled" ? rpcResult.value : null;

  console.log("Sources:");
  console.log("  dexscreener:", dexResult.status === "fulfilled" ? "ok" : `FAILED — ${dexResult.reason}`);
  console.log("  rugcheck:   ", rugResult.status === "fulfilled" ? "ok" : `FAILED — ${rugResult.reason}`);
  console.log("  helius_rpc: ", rpcResult.status === "fulfilled" ? "ok" : `FAILED — ${rpcResult.reason}`);

  const failCount = [dexData, rugData, rpcData].filter((d) => d === null).length;
  const data_confidence = failCount === 0 ? "HIGH" : failCount === 1 ? "MEDIUM" : "LOW";
  console.log("  confidence: ", data_confidence, "\n");

  // Assemble risk factors (same priority logic as quickScan/deepDive)
  const mint_authority_revoked   = rugData?.mint_authority_revoked   ?? rpcData?.mint_authority_revoked   ?? null;
  const freeze_authority_revoked = rugData?.freeze_authority_revoked ?? rpcData?.freeze_authority_revoked ?? null;
  const top_10_holder_pct        = rugData?.top_10_holder_pct        ?? rpcData?.top_10_holder_pct        ?? null;
  const has_rug_history          = rugData?.has_rug_history ?? false;
  const liquidity_usd            = dexData?.liquidity_usd ?? null;
  const buy_sell_ratio           = dexData?.buy_sell_ratio_1h ?? null;

  let token_age_days: number | null = null;
  if (dexData?.pair_created_at_ms != null) {
    token_age_days = (Date.now() - dexData.pair_created_at_ms) / 86_400_000;
  }

  const factors: RiskFactors = {
    mint_authority_revoked,
    freeze_authority_revoked,
    top_10_holder_pct,
    liquidity_usd,
    has_rug_history,
    bundled_launch: false,
    buy_sell_ratio,
    token_age_days,
  };

  console.log("Risk Factors:");
  console.log("  mint_authority_revoked:  ", mint_authority_revoked);
  console.log("  freeze_authority_revoked:", freeze_authority_revoked);
  console.log("  top_10_holder_pct:       ", top_10_holder_pct?.toFixed(2) ?? "null");
  console.log("  liquidity_usd:           ", liquidity_usd != null ? `$${liquidity_usd.toLocaleString()}` : "null");
  console.log("  has_rug_history:         ", has_rug_history);
  console.log("  bundled_launch:          ", false);
  console.log("  buy_sell_ratio_1h:       ", buy_sell_ratio?.toFixed(4) ?? "null");
  console.log("  token_age_days:          ", token_age_days?.toFixed(1) ?? "null");

  // Compute penalties manually for transparency
  console.log("\nScoring (start: 100):");
  let score = 100;
  if (has_rug_history) {
    console.log("  has_rug_history = true → instant F");
  } else {
    if (mint_authority_revoked !== true)  { score -= 25; console.log("  mint authority not revoked:   -25 →", score); }
    if (freeze_authority_revoked !== true){ score -= 15; console.log("  freeze authority not revoked: -15 →", score); }

    const hp = top_10_holder_pct ?? 100;
    if (hp > 95)      { score -= 35; console.log(`  top_10_holder_pct ${hp.toFixed(1)}% > 95%: -35 →`, score); }
    else if (hp > 80) { score -= 20; console.log(`  top_10_holder_pct ${hp.toFixed(1)}% > 80%: -20 →`, score); }
    else              { console.log(`  top_10_holder_pct ${hp.toFixed(1)}% ≤ 80%: no penalty`); }

    const liq = liquidity_usd ?? 0;
    if (liq < 1_000)       { score -= 35; console.log(`  liquidity $${liq.toLocaleString()} < $1k:   -35 →`, score); }
    else if (liq < 10_000) { score -= 20; console.log(`  liquidity $${liq.toLocaleString()} < $10k:  -20 →`, score); }
    else                   { console.log(`  liquidity $${liq.toLocaleString()} ≥ $10k: no penalty`); }

    if (buy_sell_ratio !== null && buy_sell_ratio < 0.5) {
      score -= 10; console.log(`  buy_sell_ratio ${buy_sell_ratio.toFixed(4)} < 0.5: -10 →`, score);
    } else {
      console.log(`  buy_sell_ratio ${buy_sell_ratio?.toFixed(4) ?? "null"}: no penalty`);
    }

    if (token_age_days === null)    { score -= 10; console.log("  token_age unknown:            -10 →", score); }
    else if (token_age_days < 1)    { score -= 15; console.log(`  token_age ${token_age_days.toFixed(2)}d < 1d: -15 →`, score); }
    else                            { console.log(`  token_age ${token_age_days.toFixed(1)}d ≥ 1d: no penalty`); }

    score = Math.max(0, Math.min(100, score));
  }

  const grade = calculateRiskGrade(factors);
  console.log(`\nFinal score: ${score}  →  Grade: ${grade}`);
})();
