import { getDexScreenerToken } from "./src/sources/dexscreener.js";
import { getRugCheckSummary } from "./src/sources/rugcheck.js";
import { getTokenInfo } from "./src/sources/helius.js";
import { getBirdeyeToken } from "./src/sources/birdeye.js";
import { getSolscanMeta } from "./src/sources/solscan.js";

const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

function check(label: string, pass: boolean) {
  console.log(pass ? "PASS" : "FAIL", label);
  return pass;
}

let allOk = true;

// ── DexScreener ─────────────────────────────────────────────────────────────
console.log("\n=== DexScreener ===");
const dex = await getDexScreenerToken(BONK, { timeout: 4000 }).catch((e: unknown) => { console.error("ERROR", e); return null; });
console.log(dex);
allOk = check("pair found",              dex?.pair !== null) && allOk;
allOk = check("price_usd > 0",           typeof dex?.price_usd === "number" && dex.price_usd > 0) && allOk;
allOk = check("liquidity_usd > 0",       typeof dex?.liquidity_usd === "number" && dex.liquidity_usd > 0) && allOk;

// ── RugCheck ─────────────────────────────────────────────────────────────────
console.log("\n=== RugCheck ===");
const rug = await getRugCheckSummary(BONK, { timeout: 5000 }).catch((e: unknown) => { console.error("ERROR", e); return null; });
console.log(rug);
allOk = check("returned non-null",                   rug !== null) && allOk;
allOk = check("mint_authority_revoked is boolean",   typeof rug?.mint_authority_revoked === "boolean") && allOk;
allOk = check("freeze_authority_revoked is boolean", typeof rug?.freeze_authority_revoked === "boolean") && allOk;
allOk = check("top_10_holder_pct 0–100",             rug?.top_10_holder_pct == null || (rug.top_10_holder_pct >= 0 && rug.top_10_holder_pct <= 100)) && allOk;
allOk = check("has_rug_history is boolean",          typeof rug?.has_rug_history === "boolean") && allOk;

// ── Helius / RPC ─────────────────────────────────────────────────────────────
console.log("\n=== Helius / RPC ===");
const rpc = await getTokenInfo(BONK, { timeout: 6000 }).catch((e: unknown) => { console.error("ERROR", e); return null; });
console.log(rpc);
allOk = check("returned non-null",                   rpc !== null) && allOk;
allOk = check("mint_authority_revoked is boolean",   typeof rpc?.mint_authority_revoked === "boolean") && allOk;
allOk = check("freeze_authority_revoked is boolean", typeof rpc?.freeze_authority_revoked === "boolean") && allOk;

// ── Birdeye ──────────────────────────────────────────────────────────────────
console.log("\n=== Birdeye ===");
const bird = await getBirdeyeToken(BONK, { timeout: 5000 }).catch((e: unknown) => { console.error("ERROR", e); return null; });
console.log(bird);
// Birdeye may 401 without an API key — acceptable null, just check shape if present
if (bird !== null) {
  allOk = check("price_usd is number or null",     bird.price_usd === null || typeof bird.price_usd === "number") && allOk;
  allOk = check("liquidity_usd is number or null", bird.liquidity_usd === null || typeof bird.liquidity_usd === "number") && allOk;
} else {
  console.log("  (null — likely needs BIRDEYE_API_KEY, acceptable)");
}

// ── Solscan ──────────────────────────────────────────────────────────────────
console.log("\n=== Solscan ===");
const sc = await getSolscanMeta(BONK, { timeout: 5000 }).catch((e: unknown) => { console.error("ERROR", e); return null; });
console.log(sc);
if (sc !== null) {
  allOk = check("symbol or name present", sc.symbol !== null || sc.name !== null) && allOk;
} else {
  console.log("  (null — public endpoint may be rate-limited, acceptable)");
}

console.log(allOk ? "\nAll checks passed." : "\nSome checks FAILED.");
if (!allOk) process.exit(1);
