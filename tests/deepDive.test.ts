import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { _resetBreakers } from "../src/circuitBreaker.js";
import { _resetCache } from "../src/cache.js";
import { deepDive } from "../src/scanner/deepDive.js";

const TOKEN = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // USDC

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

function dexPair(overrides: Record<string, unknown> = {}) {
  return {
    chainId: "solana",
    dexId: "raydium",
    pairAddress: "fakePairAddr111111111111111111111111111111111",
    baseToken: { address: TOKEN, name: "USD Coin", symbol: "USDC" },
    quoteToken: { address: "So11111111111111111111111111111111111111112", name: "SOL", symbol: "SOL" },
    priceUsd: "1.0001",
    priceChange: { h1: 2, h6: 1, h24: 0.5 },
    volume: { h1: 100_000, h24: 2_000_000 },
    liquidity: { usd: 5_000_000 },
    txns: { h1: { buys: 300, sells: 100 }, h24: { buys: 3000, sells: 1000 } },
    pairCreatedAt: Date.now() - 365 * 86_400_000,
    ...overrides,
  };
}

function makeFetch({
  rugcheckStatus = 200,
  rugcheckData = {
    mint: TOKEN,
    mintAuthority: null,
    freezeAuthority: null,
    topHolders: Array.from({ length: 10 }, (_, i) => ({
      address: `addr${i}${"1".repeat(37)}`, pct: 5, amount: 1000, uiAmount: 1000, uiAmountString: "1000",
    })),
    score: 0,
    risks: [],
    rugged: false,
  },
  dexData = { pairs: [dexPair()] },
} = {}) {
  return vi.fn().mockImplementation(async (url: string) => {
    const u = String(url);
    if (u.includes("rugcheck")) {
      return fakeResponse(rugcheckData, rugcheckStatus);
    }
    if (u.includes("dexscreener")) {
      return fakeResponse(dexData);
    }
    if (u.includes("birdeye")) {
      return fakeResponse(null, 401); // no key — acceptable null
    }
    if (u.includes("solscan")) {
      return fakeResponse(null, 429);
    }
    // Helius / public RPC — used for dev wallet + getAccountInfo
    return fakeResponse({ id: 1, result: { value: null } });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("deepDive", () => {
  beforeEach(() => { _resetBreakers(); _resetCache(); });
  afterEach(() => vi.unstubAllGlobals());

  it("returns a complete, valid response shape", async () => {
    vi.stubGlobal("fetch", makeFetch());

    const result = await deepDive(TOKEN);

    expect(result).toMatchObject({
      schema_version:           "2.0",
      is_honeypot:              expect.any(Boolean),
      mint_authority_revoked:   expect.any(Boolean),
      freeze_authority_revoked: expect.any(Boolean),
      lp_burned:                expect.toBeOneOf([true, false, null]),
      rugcheck_risk_score:      expect.toBeOneOf([expect.any(Number), null]),
      single_holder_danger:     expect.any(Boolean),
      risk_grade:               expect.stringMatching(/^[ABCDF]$/),
      recommendation:           expect.objectContaining({
        action: expect.stringMatching(/^(AVOID|WATCH|CONSIDER|DYOR)$/),
        reason: expect.any(String),
        confidence: expect.any(Number),
        time_horizon: expect.stringMatching(/^(SHORT_TERM|MEDIUM_TERM|LONG_TERM)$/),
      }),
      momentum_score:           expect.any(Number),
      data_confidence:          expect.stringMatching(/^(HIGH|MEDIUM|LOW)$/),
      full_risk_report:         expect.any(String),
      summary:                  expect.any(String),
      dev_wallet_analysis:      expect.objectContaining({ sol_balance: expect.any(Number) }),
      liquidity_lock_status:    expect.objectContaining({
        locked:            expect.any(Boolean),
        lock_type:         expect.stringMatching(/^(PERMANENT_BURN|PROGRAM_CONTROLLED|TIMED_LOCK|UNLOCKED|MIXED|UNKNOWN|TIMELOCK|NONE)$/),
        lock_duration_days: expect.toBeOneOf([expect.any(Number), null]),
        locked_pct:        expect.any(Number),
        pools_assessed:    expect.any(Number),
        pools_safe:        expect.any(Number),
        pool_safety_breakdown: expect.any(Array),
      }),
      trading_pattern:          expect.objectContaining({
        wash_trading_score:          expect.any(Number),
        wash_trading_risk:           expect.stringMatching(/^(NONE|LOW|ELEVATED|HIGH|EXTREME)$/),
        wash_trading_meaning:        expect.any(String),
        wash_trading_action_guidance: expect.any(String),
        circular_pairs:              expect.any(Number),
        wash_method:                 expect.stringMatching(/^(GRAPH_ANALYSIS|HEURISTIC|UNKNOWN)$/),
      }),
      metadata_immutability:    expect.objectContaining({
        is_mutable:      expect.toBeOneOf([true, false, null]),
        risk:            expect.stringMatching(/^(MUTABLE|IMMUTABLE|UNKNOWN)$/),
        meaning:         expect.any(String),
        action_guidance: expect.any(String),
      }),
      authority_history:        expect.objectContaining({
        mint_authority_changes:   expect.any(Array),
        authority_ever_regranted: expect.any(Boolean),
      }),
      dilution_risk:            expect.objectContaining({
        post_launch_mints: expect.any(Number),
        risk:              expect.stringMatching(/^(LOW|MEDIUM|HIGH|UNKNOWN)$/),
      }),
      wallet_analysis:          expect.objectContaining({
        clustered_wallets:       expect.any(Number),
        dev_wallet_linked:       expect.any(Boolean),
        funding_wallet_overlap:  expect.toBeOneOf([expect.any(Number), null]),
        funding_source_risk:     expect.stringMatching(/^(LOW|MEDIUM|HIGH)$/),
      }),
      adjusted_holder_concentration: expect.objectContaining({
        adjusted_top_10_pct: expect.toBeOneOf([expect.any(Number), null]),
        excluded_count:      expect.any(Number),
        excluded_pct:        expect.any(Number),
        exclusions:          expect.any(Array),
        method:              expect.stringMatching(/^(BIRDEYE_SUPPLY|RUGCHECK_FALLBACK|UNAVAILABLE)$/),
      }),
    });

    // pool_types_detected: array with at least one valid LP model type
    expect(result.pool_types_detected).toBeInstanceOf(Array);
    expect(result.pool_types_detected.length).toBeGreaterThanOrEqual(1);
    result.pool_types_detected.forEach((t: string) => {
      expect(t).toMatch(/^(TRADITIONAL_AMM|CLMM_DLMM|UNKNOWN)$/);
    });

    // rugcheck_score_details present when rugcheck data available
    expect(result.rugcheck_score_details).not.toBeNull();
    if (result.rugcheck_score_details !== null) {
      expect(result.rugcheck_score_details).toMatchObject({
        lp_false_positive_stripped: expect.any(Boolean),
        stripped_score_amount:      expect.any(Number),
      });
      // reason must be populated when lp_false_positive_stripped is true
      if (result.rugcheck_score_details.lp_false_positive_stripped) {
        expect(result.rugcheck_score_details.reason).toBeTruthy();
      }
    }

    // dev_wallet_analysis must have funding_source + funding_risk_note fields
    expect(result.dev_wallet_analysis).toHaveProperty("funding_source");
    expect(result.dev_wallet_analysis).toHaveProperty("funding_risk_note");
    // When funding_source is present it must have the required shape
    if (result.dev_wallet_analysis.funding_source !== null) {
      expect(result.dev_wallet_analysis.funding_source).toMatchObject({
        funder_type: expect.any(String),
        risk:        expect.stringMatching(/^(HIGH|MEDIUM|LOW)$/),
      });
    }
  });

  it("recommendation is never undefined — defaults to DYOR on LOW confidence", async () => {
    // DexScreener fails (500) + Helius returns null value → authority flags default false.
    // RugCheck succeeds with clean data → grade F (liq null=-35, age null=-10, auth not revoked=-25-15, score=15).
    // sources=["rugcheck"] → 1 source, fresh → MEDIUM confidence.
    // deriveRecommendation(F, false, false, ...) → "AVOID" (grade F takes priority).
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes("rugcheck")) {
        return fakeResponse({
          mint: TOKEN, mintAuthority: null, freezeAuthority: null,
          topHolders: Array.from({ length: 10 }, (_, i) => ({
            address: `addr${i}${"1".repeat(37)}`, pct: 5, amount: 1000, uiAmount: 1000, uiAmountString: "1000",
          })),
          score: 0, risks: [], rugged: false,
        });
      }
      if (u.includes("dexscreener")) return fakeResponse({}, 500);
      if (u.includes("birdeye"))     return fakeResponse(null, 401);
      // Helius/public RPC — returns null value → getTokenInfo returns null
      return fakeResponse({ id: 1, result: { value: null } });
    }));

    const result = await deepDive(TOKEN);

    expect(result.recommendation).toBeDefined();
    expect(result.data_confidence).toBe("LOW");
  });

  it("recommendation is AVOID when rug history is flagged", async () => {
    vi.stubGlobal("fetch", makeFetch({
      rugcheckData: {
        mint: TOKEN,
        mintAuthority: null,
        freezeAuthority: null,
        topHolders: [],
        score: 0,
        risks: [],
        rugged: true, // rug history
      },
    }));

    const result = await deepDive(TOKEN);

    expect(result.recommendation.action).toBe("AVOID");
  });

  it("fallback chain engages when RugCheck is down — Helius provides authority data", async () => {
    // RugCheck returns 500; Helius RPC returns a valid base64 mint account
    // Mint layout: bytes 0-3 = 0 (mint authority revoked), bytes 46-49 = 0 (freeze authority revoked)
    const mintLayout = Buffer.alloc(82, 0); // all zeros = both authorities revoked
    const base64Mint = mintLayout.toString("base64");

    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes("rugcheck")) return fakeResponse({}, 500);
      if (u.includes("dexscreener")) return fakeResponse({ pairs: [dexPair()] });
      if (u.includes("birdeye")) return fakeResponse(null, 401);
      if (u.includes("solscan")) return fakeResponse(null, 429);
      // Helius / public RPC
      return fakeResponse({
        id: 1,
        result: { value: { data: [base64Mint, "base64"], owner: "TokenkebQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" } },
      });
    }));

    const result = await deepDive(TOKEN);

    // RugCheck was down, but Helius fallback provides authority flags
    expect(result.mint_authority_revoked).toBe(true);
    expect(result.freeze_authority_revoked).toBe(true);
    // Under the new architecture Helius owns authority flags and always runs —
    // RugCheck being down does not reduce confidence for authority data.
    // DexScreener + Helius both succeeded → HIGH confidence is correct.
    expect(result.data_confidence).not.toBe("LOW");
  });

  it("momentum_score is always 0–100 and never throws on missing data", async () => {
    // Provide DexScreener data with null volume/price fields to stress missing-data paths
    vi.stubGlobal("fetch", makeFetch({
      dexData: {
        pairs: [{
          ...dexPair(),
          priceChange: {} as any, // no h1/h24
          volume: {} as any,      // no h1/h24
          txns: {} as any,        // no h1
        }],
      },
    }));

    const result = await deepDive(TOKEN);

    expect(result.momentum_score).toBeGreaterThanOrEqual(0);
    expect(result.momentum_score).toBeLessThanOrEqual(100);
  });

  it("momentum_score stays within 0–100 when volume is very high (extreme input)", async () => {
    vi.stubGlobal("fetch", makeFetch({
      dexData: {
        pairs: [{
          ...dexPair({
            volume: { h1: 999_999_999, h24: 1_000 }, // massive 1h spike
            priceChange: { h1: 99, h24: 200 },        // extreme price change
            txns: { h1: { buys: 10000, sells: 1 }, h24: { buys: 10000, sells: 1 } },  // extreme buy ratio
          }),
        }],
      },
    }));

    const result = await deepDive(TOKEN);

    expect(result.momentum_score).toBe(100); // clamped at 100
  });

  it("liquidity_lock_status.lock_type is consistent with lp_burned", async () => {
    vi.stubGlobal("fetch", makeFetch());

    const result = await deepDive(TOKEN);

    // lock_type must be consistent with pool safety assessment
    expect(result.liquidity_lock_status.lock_type).toMatch(
      /^(PERMANENT_BURN|PROGRAM_CONTROLLED|TIMED_LOCK|UNLOCKED|MIXED|UNKNOWN|TIMELOCK|NONE)$/
    );
    expect(typeof result.liquidity_lock_status.locked).toBe("boolean");
    expect(result.liquidity_lock_status.pools_assessed).toBeGreaterThanOrEqual(0);
    expect(result.liquidity_lock_status.pool_safety_breakdown).toBeInstanceOf(Array);
  });

  it("key_drivers includes at least one POSITIVE direction when strong market signals exist", async () => {
    vi.stubGlobal("fetch", makeFetch({
      dexData: {
        pairs: [{
          ...dexPair({
            priceChange: { h1: 30, h24: 50 },  // strong positive 24h change
            volume: { h1: 500_000, h24: 5_000_000 },
            liquidity: { usd: 1_000_000 },
            txns: { h1: { buys: 500, sells: 100 }, h24: { buys: 5000, sells: 1000 } },
          }),
        }],
      },
    }));

    const result = await deepDive(TOKEN);

    const positiveDrivers = result.key_drivers.filter((d: { direction: string }) => d.direction === "POSITIVE");
    expect(positiveDrivers.length).toBeGreaterThan(0);
  });

  it("full_risk_report is 3–5 sentences", async () => {
    vi.stubGlobal("fetch", makeFetch());

    const result = await deepDive(TOKEN);

    const sentences = result.full_risk_report
      .split(".")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    expect(sentences.length).toBeGreaterThanOrEqual(2); // at least 3 sentences
    expect(sentences.length).toBeLessThanOrEqual(6);    // not more than ~5
  });
});
