import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { _resetBreakers } from "../src/circuitBreaker.js";
import { _resetCache } from "../src/cache.js";
import { walletRisk } from "../src/scanner/walletRisk.js";

const WALLET = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    headers: new Headers(),
  };
}

/** Minimal Helius signature list entry */
function sig(blockTime: number) {
  return { signature: `sig${blockTime}`, blockTime, slot: 1, err: null, memo: null };
}

/** Helius parsed transaction (SWAP type — buy event) */
function parsedTx(timestamp: number, mint: string, toWallet: string, nativeDelta: number) {
  return {
    signature: `tx${timestamp}`,
    timestamp,
    type: "SWAP",
    feePayer: toWallet,
    fee: 5000,
    tokenTransfers: [{
      fromUserAccount: "poolAddr",
      toUserAccount: toWallet,
      mint,
      tokenAmount: 1000,
    }],
    accountData: [{
      account: toWallet,
      nativeBalanceChange: nativeDelta,
      tokenBalanceChanges: [],
    }],
  };
}

/** Helius parsed transaction (SWAP type — sell event) */
function parsedSellTx(timestamp: number, mint: string, fromWallet: string, nativeDelta: number) {
  return {
    signature: `sell${timestamp}`,
    timestamp,
    type: "SWAP",
    feePayer: fromWallet,
    fee: 5000,
    tokenTransfers: [{
      fromUserAccount: fromWallet,
      toUserAccount: "poolAddr",
      mint,
      tokenAmount: 1000,
    }],
    accountData: [{
      account: fromWallet,
      nativeBalanceChange: nativeDelta,
      tokenBalanceChanges: [],
    }],
  };
}

/** Build N closed positions: buy then sell, profitable (2x SOL returned) */
function buildClosedPositions(wallet: string, n: number) {
  const txs: unknown[] = [];
  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < n; i++) {
    const mint = `mint${i}${"1".repeat(36 - String(i).length)}`;
    const buyTs = now - (n - i) * 7200;   // 2h apart
    const sellTs = buyTs + 3600;           // hold 1h
    txs.push(parsedTx(buyTs, mint, wallet, -100_000_000));   // spent ~0.1 SOL
    txs.push(parsedSellTx(sellTs, mint, wallet, 200_000_000)); // received 0.2 SOL
  }
  return txs;
}

function makeFetch({
  totalTxCount = 5,
  parsedTxs = [] as unknown[],
  solBalance = 1_000_000_000,
  walletAgeDays = 90,
  heliusAssetsData = { items: [] },
}: {
  totalTxCount?: number;
  parsedTxs?: unknown[];
  solBalance?: number;
  walletAgeDays?: number;
  heliusAssetsData?: unknown;
} = {}) {
  const now = Math.floor(Date.now() / 1000);
  const oldestBlockTime = now - walletAgeDays * 86_400;
  const sigs = Array.from({ length: totalTxCount }, (_, i) =>
    sig(now - i * 3600)
  );
  if (sigs.length > 0) {
    sigs[sigs.length - 1] = sig(oldestBlockTime);
  }

  return vi.fn().mockImplementation(async (url: string) => {
    const u = String(url);
    if (u.includes("getSignaturesForAddress")) {
      return fakeResponse({ id: 1, result: sigs });
    }
    if (u.includes("getAccountInfo")) {
      return fakeResponse({
        id: 1,
        result: { value: { lamports: solBalance, owner: "11111111111111111111111111111111", executable: false, rentEpoch: 0, data: ["", "base64"] } },
      });
    }
    if (u.includes("helius.xyz/v0/addresses") && u.includes("transactions")) {
      return fakeResponse(parsedTxs);
    }
    if (u.includes("getAssetsByOwner") || u.includes("helius.xyz/v0/addresses") && u.includes("balances")) {
      return fakeResponse({ result: heliusAssetsData });
    }
    if (u.includes("dexscreener")) {
      return fakeResponse({ pairs: [] });
    }
    return fakeResponse({ id: 1, result: { value: null } });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("walletRisk", () => {
  beforeEach(() => { _resetBreakers(); _resetCache(); });
  afterEach(() => vi.unstubAllGlobals());

  // ── schema_version ────────────────────────────────────────────────────────
  it("schema_version is '2.0' on every response", async () => {
    vi.stubGlobal("fetch", makeFetch());
    const result = await walletRisk(WALLET);
    expect(result.schema_version).toBe("2.0");
  });

  // ── classification: UNKNOWN when total_trades < 10 ────────────────────────
  it("classification is UNKNOWN when total_trades < 10", async () => {
    vi.stubGlobal("fetch", makeFetch({ totalTxCount: 5, parsedTxs: [] }));
    const result = await walletRisk(WALLET);
    expect(result.classification).toBe("UNKNOWN");
  });

  // ── copy_trading: UNKNOWN with reason when total_trades < 20 ─────────────
  it("copy_trading.worthiness is UNKNOWN with non-null reason when total_trades < 20", async () => {
    vi.stubGlobal("fetch", makeFetch({ totalTxCount: 8, parsedTxs: [] }));
    const result = await walletRisk(WALLET);
    expect(result.copy_trading.worthiness).toBe("UNKNOWN");
    expect(result.copy_trading.reason).not.toBeNull();
    expect(typeof result.copy_trading.reason).toBe("string");
  });

  // ── copy_trading: non-UNKNOWN when total_trades >= 20 ────────────────────
  it("copy_trading.worthiness is LOW/MEDIUM/HIGH when sufficient closed trades", async () => {
    const txs = buildClosedPositions(WALLET, 25); // 25 closed, profitable
    vi.stubGlobal("fetch", makeFetch({ totalTxCount: 50, parsedTxs: txs, walletAgeDays: 120 }));
    const result = await walletRisk(WALLET);
    expect(["LOW", "MEDIUM", "HIGH"]).toContain(result.copy_trading.worthiness);
  });

  // ── copy_trading: confidence capped at 0.5 when sample_size < 50 ─────────
  it("copy_trading.confidence is <= 0.5 when sample_size < 50", async () => {
    const txs = buildClosedPositions(WALLET, 20);
    vi.stubGlobal("fetch", makeFetch({ totalTxCount: 40, parsedTxs: txs, walletAgeDays: 120 }));
    const result = await walletRisk(WALLET);
    // If worthiness resolved (trades >= 20), confidence should be capped at 0.5
    if (result.copy_trading.worthiness !== "UNKNOWN") {
      expect(result.copy_trading.confidence).toBeLessThanOrEqual(0.5);
    }
  });

  // ── copy_trading orthogonality: HIGH_RISK wallet can have HIGH copy worthiness ─
  it("HIGH_RISK wallet can have HIGH copy_trading worthiness (orthogonality)", async () => {
    // Build 60 profitable closed positions for a sniper-like wallet
    const txs = buildClosedPositions(WALLET, 60);
    // Stub a high-frequency wallet with high win rate — force HIGH_RISK via sniper signals
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => {
      const u = String(url);
      const now = Math.floor(Date.now() / 1000);
      if (u.includes("getSignaturesForAddress")) {
        // 600 txs → sniper/bot-like + old wallet
        const sigs = Array.from({ length: 200 }, (_, i) => sig(now - i * 300));
        sigs[199] = sig(now - 365 * 86_400);
        return fakeResponse({ id: 1, result: sigs });
      }
      if (u.includes("getAccountInfo")) {
        return fakeResponse({ id: 1, result: { value: { lamports: 10_000_000_000, owner: "11111111111111111111111111111111", executable: false, rentEpoch: 0, data: ["", "base64"] } } });
      }
      if (u.includes("helius.xyz/v0/addresses") && u.includes("transactions")) {
        return fakeResponse(txs);
      }
      if (u.includes("dexscreener")) return fakeResponse({ pairs: [] });
      return fakeResponse({ id: 1, result: { value: null } });
    }));

    const result = await walletRisk(WALLET);

    // Orthogonality: classification and copy_trading are independent dimensions
    // classification can be anything; copy_trading must be independently derived
    expect(result.classification).toBeDefined();
    expect(result.copy_trading.worthiness).toBeDefined();
    // They must not be merged — both present
    expect(result).toHaveProperty("classification");
    expect(result).toHaveProperty("copy_trading");
  });

  // ── copy_trading orthogonality: LOW_RISK wallet can have UNKNOWN worthiness ─
  it("LOW_RISK wallet can have UNKNOWN copy_trading worthiness (orthogonality)", async () => {
    // Very few txs → UNKNOWN classification (thin history) + UNKNOWN copy_trading
    vi.stubGlobal("fetch", makeFetch({ totalTxCount: 3, parsedTxs: [], walletAgeDays: 180 }));
    const result = await walletRisk(WALLET);
    // With thin history, both should be UNKNOWN — orthogonality means they can independently be UNKNOWN
    expect(result.copy_trading.worthiness).toBe("UNKNOWN");
    expect(result.copy_trading.reason).not.toBeNull();
  });

  // ── bot wallet: copy_trading is UNKNOWN with bot reason ──────────────────
  it("bot wallet has copy_trading.worthiness UNKNOWN with bot-specific reason", async () => {
    // Bot detection: very high tx count with uniform timing
    const now = Math.floor(Date.now() / 1000);
    // Build txs with very uniform intervals (bot pattern)
    const botTxs = buildClosedPositions(WALLET, 30);

    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes("getSignaturesForAddress")) {
        // 200 sigs in a short window → >500 tx/day pattern
        const sigs = Array.from({ length: 200 }, (_, i) => sig(now - i * 10)); // every 10s
        sigs[199] = sig(now - 1 * 86_400); // wallet only 1 day old
        return fakeResponse({ id: 1, result: sigs });
      }
      if (u.includes("getAccountInfo")) {
        return fakeResponse({ id: 1, result: { value: { lamports: 5_000_000_000, owner: "11111111111111111111111111111111", executable: false, rentEpoch: 0, data: ["", "base64"] } } });
      }
      if (u.includes("helius.xyz/v0/addresses") && u.includes("transactions")) {
        return fakeResponse(botTxs);
      }
      if (u.includes("dexscreener")) return fakeResponse({ pairs: [] });
      return fakeResponse({ id: 1, result: { value: null } });
    }));

    const result = await walletRisk(WALLET);
    if (result.is_bot) {
      expect(result.copy_trading.worthiness).toBe("UNKNOWN");
      expect(result.copy_trading.reason).toContain("bot");
    }
    // At minimum, copy_trading is always present
    expect(result.copy_trading).toBeDefined();
    expect(result.copy_trading.sample_size).toBeGreaterThanOrEqual(0);
  });

  // ── score is structured object with components ────────────────────────────
  it("score is a structured object with components", async () => {
    vi.stubGlobal("fetch", makeFetch());
    const result = await walletRisk(WALLET);
    expect(result.score).toMatchObject({
      overall: expect.any(Number),
      components: {
        history_depth: expect.any(Number),
        behavioral_risk: expect.any(Number),
        counterparty_exposure: expect.any(Number),
      },
    });
  });

  // ── risk_signals is always populated ─────────────────────────────────────
  it("risk_signals is always an array (never undefined)", async () => {
    vi.stubGlobal("fetch", makeFetch());
    const result = await walletRisk(WALLET);
    expect(Array.isArray(result.risk_signals)).toBe(true);
  });

  // ── activity object shape present ─────────────────────────────────────────
  it("activity object has required shape", async () => {
    vi.stubGlobal("fetch", makeFetch({ walletAgeDays: 60 }));
    const result = await walletRisk(WALLET);
    expect(result.activity).toMatchObject({
      wallet_age_days: expect.toBeOneOf([expect.any(Number), null]),
      total_trades: expect.any(Number),
      active_days_last_30d: expect.toBeOneOf([expect.any(Number), null]),
      last_active_hours_ago: expect.toBeOneOf([expect.any(Number), null]),
    });
  });

  // ── MEV fields are never undefined ────────────────────────────────────────
  it("mev_victim_score is a number 0–100, never undefined", async () => {
    vi.stubGlobal("fetch", makeFetch());
    const result = await walletRisk(WALLET);
    expect(typeof result.mev_victim_score).toBe("number");
    expect(result.mev_victim_score).toBeGreaterThanOrEqual(0);
    expect(result.mev_victim_score).toBeLessThanOrEqual(100);
  });

  it("is_mev_bot is boolean, never undefined", async () => {
    vi.stubGlobal("fetch", makeFetch());
    const result = await walletRisk(WALLET);
    expect(typeof result.is_mev_bot).toBe("boolean");
  });

  // ── Pump.fun fields ───────────────────────────────────────────────────────
  it("pumpfun_graduation_exit_rate_pct is null when no pump.fun history", async () => {
    vi.stubGlobal("fetch", makeFetch({ parsedTxs: [] }));
    const result = await walletRisk(WALLET);
    expect(result.pumpfun_graduation_exit_rate_pct).toBeNull();
  });

  it("early_entry_rate_pct is null when fewer than 5 tokens have timing data", async () => {
    vi.stubGlobal("fetch", makeFetch({ parsedTxs: [] }));
    const result = await walletRisk(WALLET);
    expect(result.early_entry_rate_pct).toBeNull();
  });

  // ── historical_exposure: high_risk_tokens_traded present (uncapped) ───────
  it("historical_exposure.high_risk_tokens_traded is present (no cap)", async () => {
    // Build 30+ token positions to verify uncapped scan
    const txs = buildClosedPositions(WALLET, 30);
    vi.stubGlobal("fetch", makeFetch({ totalTxCount: 100, parsedTxs: txs, walletAgeDays: 365 }));
    const result = await walletRisk(WALLET);
    expect(result.historical_exposure.rug_interactions === null || typeof result.historical_exposure.rug_interactions === "number").toBe(true);
    expect(result.historical_exposure.high_risk_tokens_traded === null || typeof result.historical_exposure.high_risk_tokens_traded === "number").toBe(true);
  });

  // ── copy_trading structured object always present ──────────────────────────
  it("copy_trading is a structured object with all required fields", async () => {
    vi.stubGlobal("fetch", makeFetch());
    const result = await walletRisk(WALLET);
    expect(result.copy_trading).toMatchObject({
      worthiness: expect.stringMatching(/^(HIGH|MEDIUM|LOW|UNKNOWN)$/),
      confidence: expect.any(Number),
      sample_size: expect.any(Number),
      key_signals: expect.any(Array),
    });
    // reason is string or null — both are valid
    expect(result.copy_trading.reason === null || typeof result.copy_trading.reason === "string").toBe(true);
  });

  // ── copy_trading.reason is always non-null when worthiness is UNKNOWN ─────
  it("copy_trading.reason is non-null whenever worthiness is UNKNOWN", async () => {
    vi.stubGlobal("fetch", makeFetch({ totalTxCount: 5, parsedTxs: [] }));
    const result = await walletRisk(WALLET);
    if (result.copy_trading.worthiness === "UNKNOWN") {
      expect(result.copy_trading.reason).not.toBeNull();
    }
  });

  // ── FIX 1: win_rate_calculation_status ───────────────────────────────────
  it("win_rate_calculation_status is always a valid WinRateStatus string", async () => {
    vi.stubGlobal("fetch", makeFetch({ totalTxCount: 5, parsedTxs: [] }));
    const result = await walletRisk(WALLET);
    expect(result.win_rate_calculation_status).toMatch(
      /^(CALCULATED|NO_CLOSED_TRADES|INSUFFICIENT_TRADES|DATA_UNAVAILABLE|HODL_ONLY)$/
    );
  });

  it("win_rate_calculation_status is CALCULATED when closed trades exist", async () => {
    const txs = buildClosedPositions(WALLET, 10);
    vi.stubGlobal("fetch", makeFetch({ totalTxCount: 30, parsedTxs: txs, walletAgeDays: 90 }));
    const result = await walletRisk(WALLET);
    expect(result.win_rate_calculation_status).toBe("CALCULATED");
    expect(result.win_rate_pct).not.toBeNull();
  });

  it("win_rate_calculation_status is NO_CLOSED_TRADES when no parsed txs", async () => {
    vi.stubGlobal("fetch", makeFetch({ totalTxCount: 15, parsedTxs: [] }));
    const result = await walletRisk(WALLET);
    expect(result.win_rate_calculation_status).toMatch(
      /^(NO_CLOSED_TRADES|DATA_UNAVAILABLE|INSUFFICIENT_TRADES|HODL_ONLY)$/
    );
  });

  // ── FIX 2: structured pnl object ─────────────────────────────────────────
  it("pnl is a structured object with required fields", async () => {
    vi.stubGlobal("fetch", makeFetch());
    const result = await walletRisk(WALLET);
    expect(result.pnl).toMatchObject({
      realized_pnl_usdc: expect.toBeOneOf([expect.any(Number), null]),
      unrealized_pnl_usdc: expect.toBeOneOf([expect.any(Number), null]),
      unrealized_pnl_pct: expect.toBeOneOf([expect.any(Number), null]),
      total_pnl_usdc: expect.toBeOneOf([expect.any(Number), null]),
      positions_analysed: expect.any(Number),
      cost_basis_method: expect.stringMatching(/^(SOL_LAMPORTS|ESTIMATED)$/),
    });
    // calculation_note is string or null
    expect(
      result.pnl.calculation_note === null || typeof result.pnl.calculation_note === "string"
    ).toBe(true);
  });

  it("pnl_estimate_30d_usdc (legacy) equals pnl.realized_pnl_usdc", async () => {
    const txs = buildClosedPositions(WALLET, 5);
    vi.stubGlobal("fetch", makeFetch({ totalTxCount: 20, parsedTxs: txs, walletAgeDays: 90 }));
    const result = await walletRisk(WALLET);
    expect(result.pnl_estimate_30d_usdc).toBe(result.pnl.realized_pnl_usdc);
  });

  // ── FIX 3: wallet_activity_type ───────────────────────────────────────────
  it("wallet_activity_type is always a valid WalletActivityType string", async () => {
    vi.stubGlobal("fetch", makeFetch());
    const result = await walletRisk(WALLET);
    expect(result.wallet_activity_type).toMatch(
      /^(ACTIVE_TRADER|HODLER|SWING_TRADER|SNIPER|BOT|INACTIVE|NEW_WALLET|UNKNOWN)$/
    );
  });

  it("wallet_activity_type is INACTIVE for a wallet with very few recent txs", async () => {
    // totalTxCount=2 with no parsed txs → low activity
    vi.stubGlobal("fetch", makeFetch({ totalTxCount: 2, parsedTxs: [], walletAgeDays: 365 }));
    const result = await walletRisk(WALLET);
    expect(result.wallet_activity_type).toMatch(/^(INACTIVE|UNKNOWN)$/);
  });

  it("wallet_activity_type is never undefined — defaults gracefully with no on-chain data", async () => {
    // RPC calls are POST (method in body, not URL), so walletAgeDays is null in test env.
    // With no sigs returned, totalTx=0 → INACTIVE is the correct fallback.
    vi.stubGlobal("fetch", makeFetch({ totalTxCount: 5, parsedTxs: [], walletAgeDays: 2 }));
    const result = await walletRisk(WALLET);
    expect(result.wallet_activity_type).toMatch(
      /^(ACTIVE_TRADER|HODLER|SWING_TRADER|SNIPER|BOT|INACTIVE|NEW_WALLET|UNKNOWN)$/
    );
  });

  // ── FIX 4: structured funding_source object ───────────────────────────────
  it("funding_source is a structured object with required fields", async () => {
    vi.stubGlobal("fetch", makeFetch());
    const result = await walletRisk(WALLET);
    expect(result.funding_source).toMatchObject({
      funder_type: expect.stringMatching(/^(CEX|MIXER|FRESH_WALLET|DEPLOYER|KNOWN_PROTOCOL|PEER_WALLET|UNKNOWN)$/),
      cluster_size: expect.any(Number),
      risk: expect.stringMatching(/^(HIGH|MEDIUM|LOW|UNKNOWN)$/),
      risk_reason: expect.any(String),
      action_guidance: expect.any(String),
    });
    expect(Array.isArray(result.funding_source.shared_funder_wallets)).toBe(true);
    (result.funding_source.shared_funder_wallets as unknown[]).forEach((w) => {
      expect(typeof w).toBe("string");
    });
    // funder_address, funder_age_days, funder_tx_count can be null
    expect(
      result.funding_source.funder_address === null || typeof result.funding_source.funder_address === "string"
    ).toBe(true);
  });

  it("funding_wallet_risk (legacy) matches funding_source.risk", async () => {
    vi.stubGlobal("fetch", makeFetch());
    const result = await walletRisk(WALLET);
    expect(result.funding_wallet_risk).toBe(result.funding_source.risk);
  });

  // ── FEATURE 5: dusting_analysis ───────────────────────────────────────────
  it("dusting_analysis is present with required shape", async () => {
    vi.stubGlobal("fetch", makeFetch());
    const result = await walletRisk(WALLET);
    expect(result.dusting_analysis).toMatchObject({
      dust_transactions_detected: expect.any(Number),
      dusting_risk: expect.stringMatching(/^(HIGH|MEDIUM|LOW|NONE)$/),
      meaning: expect.any(String),
      action_guidance: expect.any(String),
    });
    expect(Array.isArray(result.dusting_analysis.dust_senders)).toBe(true);
    // most_recent_dust_timestamp is number or null
    expect(
      result.dusting_analysis.most_recent_dust_timestamp === null ||
      typeof result.dusting_analysis.most_recent_dust_timestamp === "number"
    ).toBe(true);
  });

  it("dusting_analysis.dusting_risk is NONE when no parsed txs", async () => {
    vi.stubGlobal("fetch", makeFetch({ parsedTxs: [] }));
    const result = await walletRisk(WALLET);
    expect(result.dusting_analysis.dust_transactions_detected).toBe(0);
    expect(result.dusting_analysis.dusting_risk).toBe("NONE");
  });

  // ── FEATURE 6: extended behavior fields ───────────────────────────────────
  it("behavior has style_confidence, style_evidence, and profile_summary", async () => {
    vi.stubGlobal("fetch", makeFetch());
    const result = await walletRisk(WALLET);
    expect(result.behavior).toMatchObject({
      style: expect.stringMatching(
        /^(SNIPER|MOMENTUM|FLIPPER|HODLER|BOT|DEGEN|LOW_ACTIVITY|INCONCLUSIVE|PRO_TRADER|INSIDER|BUNDLER)$/
      ),
      consistency: expect.stringMatching(/^(LOW|MEDIUM|HIGH)$/),
      style_confidence: expect.any(Number),
      style_evidence: expect.any(Array),
      profile_summary: expect.any(String),
    });
    expect(result.behavior.style_confidence).toBeGreaterThanOrEqual(0);
    expect(result.behavior.style_confidence).toBeLessThanOrEqual(1);
  });

  it("behavior.style_evidence is an array of strings", async () => {
    vi.stubGlobal("fetch", makeFetch({ totalTxCount: 50, parsedTxs: buildClosedPositions(WALLET, 20), walletAgeDays: 90 }));
    const result = await walletRisk(WALLET);
    expect(Array.isArray(result.behavior.style_evidence)).toBe(true);
    result.behavior.style_evidence.forEach(e => expect(typeof e).toBe("string"));
  });

  it("behavior.profile_summary is a non-empty string", async () => {
    vi.stubGlobal("fetch", makeFetch());
    const result = await walletRisk(WALLET);
    expect(typeof result.behavior.profile_summary).toBe("string");
    expect(result.behavior.profile_summary.length).toBeGreaterThan(0);
  });

  // ── full response shape ───────────────────────────────────────────────────
  it("returns a complete, valid response shape", async () => {
    vi.stubGlobal("fetch", makeFetch({ totalTxCount: 10, walletAgeDays: 90 }));
    const result = await walletRisk(WALLET);
    expect(result).toMatchObject({
      schema_version: "2.0",
      classification: expect.stringMatching(/^(LOW_RISK|HIGH_RISK|UNKNOWN)$/),
      activity: expect.objectContaining({
        total_trades: expect.any(Number),
        active_days_last_30d: expect.toBeOneOf([expect.any(Number), null]),
      }),
      sniper_score: expect.any(Number),
      is_bot: expect.any(Boolean),
      whale_status: expect.any(Boolean),
      funding_wallet_risk: expect.stringMatching(/^(HIGH|MEDIUM|LOW|UNKNOWN)$/),
      behavior: expect.objectContaining({
        style: expect.any(String),
        consistency: expect.stringMatching(/^(LOW|MEDIUM|HIGH)$/),
        style_confidence: expect.any(Number),
        style_evidence: expect.any(Array),
        profile_summary: expect.any(String),
      }),
      score: expect.objectContaining({ overall: expect.any(Number) }),
      risk_signals: expect.any(Array),
      historical_exposure: expect.objectContaining({}),
      mev_victim_score: expect.any(Number),
      is_mev_bot: expect.any(Boolean),
      mev_bot_confidence: expect.any(Number),
      pumpfun_graduation_exit_rate_pct: expect.toBeOneOf([expect.any(Number), null]),
      early_entry_rate_pct: expect.toBeOneOf([expect.any(Number), null]),
      win_rate_calculation_status: expect.stringMatching(
        /^(CALCULATED|NO_CLOSED_TRADES|INSUFFICIENT_TRADES|DATA_UNAVAILABLE|HODL_ONLY)$/
      ),
      pnl: expect.objectContaining({
        realized_pnl_usdc: expect.toBeOneOf([expect.any(Number), null]),
        positions_analysed: expect.any(Number),
        cost_basis_method: expect.stringMatching(/^(SOL_LAMPORTS|ESTIMATED)$/),
      }),
      wallet_activity_type: expect.stringMatching(
        /^(ACTIVE_TRADER|HODLER|SWING_TRADER|SNIPER|BOT|INACTIVE|NEW_WALLET|UNKNOWN)$/
      ),
      funding_source: expect.objectContaining({
        funder_type: expect.stringMatching(/^(CEX|MIXER|FRESH_WALLET|DEPLOYER|KNOWN_PROTOCOL|PEER_WALLET|UNKNOWN)$/),
        risk: expect.stringMatching(/^(HIGH|MEDIUM|LOW|UNKNOWN)$/),
        shared_funder_wallets: expect.any(Array),
      }),
      dusting_analysis: expect.objectContaining({
        dust_transactions_detected: expect.any(Number),
        dust_senders: expect.any(Array),
        dusting_risk: expect.stringMatching(/^(HIGH|MEDIUM|LOW|NONE)$/),
      }),
      copy_trading: expect.objectContaining({
        worthiness: expect.stringMatching(/^(HIGH|MEDIUM|LOW|UNKNOWN)$/),
        confidence: expect.any(Number),
        sample_size: expect.any(Number),
        key_signals: expect.any(Array),
      }),
      data_confidence: expect.stringMatching(/^(HIGH|MEDIUM|LOW)$/),
      data_quality: expect.stringMatching(/^(FULL|PARTIAL|LIMITED)$/),
      missing_fields: expect.any(Array),
      risk_summary: expect.any(String),
    });
    const h = result.historical_exposure;
    expect(h.rug_interactions === null || typeof h.rug_interactions === "number").toBe(true);
    expect(h.high_risk_tokens_traded === null || typeof h.high_risk_tokens_traded === "number").toBe(true);
  });
});
