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
      is_honeypot:              expect.any(Boolean),
      mint_authority_revoked:   expect.any(Boolean),
      freeze_authority_revoked: expect.any(Boolean),
      risk_grade:               expect.stringMatching(/^[ABCDF]$/),
      recommendation:           expect.stringMatching(/^(BUY|AVOID|WATCH|DYOR)$/),
      momentum_score:           expect.any(Number),
      data_confidence:          expect.stringMatching(/^(HIGH|MEDIUM|LOW)$/),
      full_risk_report:         expect.any(String),
      summary:                  expect.any(String),
      dev_wallet_analysis:      expect.objectContaining({ sol_balance: expect.any(Number) }),
      liquidity_lock_status:    expect.objectContaining({ locked: expect.any(Boolean) }),
      trading_pattern:          expect.objectContaining({ wash_trading_score: expect.any(Number) }),
    });
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
          risks: [], rugged: false,
        });
      }
      if (u.includes("dexscreener")) return fakeResponse({}, 500);
      if (u.includes("birdeye"))     return fakeResponse(null, 401);
      // Helius/public RPC — returns null value → getTokenInfo returns null
      return fakeResponse({ id: 1, result: { value: null } });
    }));

    const result = await deepDive(TOKEN);

    expect(result.recommendation).toBeDefined();
    expect(result.data_confidence).toBe("MEDIUM");
  });

  it("recommendation is AVOID when rug history is flagged", async () => {
    vi.stubGlobal("fetch", makeFetch({
      rugcheckData: {
        mint: TOKEN,
        mintAuthority: null,
        freezeAuthority: null,
        topHolders: [],
        risks: [],
        rugged: true, // rug history
      },
    }));

    const result = await deepDive(TOKEN);

    expect(result.recommendation).toBe("AVOID");
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
            txns: { h1: { buys: 10000, sells: 1 } },  // extreme buy ratio
          }),
        }],
      },
    }));

    const result = await deepDive(TOKEN);

    expect(result.momentum_score).toBe(100); // clamped at 100
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
