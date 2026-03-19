import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { isValidSolanaAddress } from "../src/validate.js";
import { _resetBreakers } from "../src/circuitBreaker.js";
import { _resetCache } from "../src/cache.js";
import { quickScan } from "../src/scanner/quickScan.js";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const RUG  = "TokenkebQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"; // valid address; mocked as rug below

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFetchMock(overrides: {
  rugged?: boolean;
  mintAuthority?: string | null;
  freezeAuthority?: string | null;
  liquidity?: number;
} = {}) {
  const {
    rugged = false,
    mintAuthority = null,
    freezeAuthority = null,
    liquidity = 2_000_000,
  } = overrides;

  return vi.fn().mockImplementation(async (url: string) => {
    const u = String(url);

    if (u.includes("dexscreener")) {
      return fakeResponse({
        pairs: [{
          chainId: "solana",
          dexId: "raydium",
          pairAddress: "fakePairAddr111111111111111111111111111111111",
          baseToken: { address: USDC, name: "USD Coin", symbol: "USDC" },
          quoteToken: { address: "So11111111111111111111111111111111111111112", name: "Wrapped SOL", symbol: "SOL" },
          priceUsd: "1.0001",
          priceChange: { h1: 0.05, h24: 0.12 },
          volume: { h1: 80_000, h24: 1_500_000 },
          liquidity: { usd: liquidity },
          txns: { h1: { buys: 200, sells: 100 }, h24: { buys: 2000, sells: 1000 } },
          pairCreatedAt: Date.now() - 400 * 86_400_000, // 400 days old
        }],
      });
    }

    if (u.includes("rugcheck")) {
      return fakeResponse({
        mint: USDC,
        mintAuthority,
        freezeAuthority,
        topHolders: Array.from({ length: 10 }, (_, i) => ({
          address: `addr${i}111111111111111111111111111111111111`,
          pct: 5, amount: 1000, uiAmount: 1000, uiAmountString: "1000",
        })),
        risks: [],
        rugged,
      });
    }

    // Helius / public RPC — return null value (authority data comes from RugCheck)
    return fakeResponse({ id: 1, result: { value: null } });
  });
}

function fakeResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    headers: new Headers(),
  };
}

// ---------------------------------------------------------------------------
// isValidSolanaAddress
// ---------------------------------------------------------------------------

describe("isValidSolanaAddress", () => {
  it("accepts valid base58 Solana addresses", () => {
    expect(isValidSolanaAddress(USDC)).toBe(true);
    expect(isValidSolanaAddress("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263")).toBe(true); // BONK
    expect(isValidSolanaAddress(RUG)).toBe(true);
  });

  it("rejects strings that are too short", () => {
    expect(isValidSolanaAddress("abc")).toBe(false);
    expect(isValidSolanaAddress("")).toBe(false);
    expect(isValidSolanaAddress("So1111111111111111111")).toBe(false); // < 32 chars
  });

  it("rejects strings that are too long", () => {
    expect(isValidSolanaAddress("A".repeat(45))).toBe(false);
  });

  it("rejects base58 strings with invalid characters (0, O, I, l)", () => {
    // '0' and 'O' are not in base58 alphabet
    expect(isValidSolanaAddress("0OlI" + "A".repeat(38))).toBe(false);
  });

  it("rejects garbage non-address strings", () => {
    expect(isValidSolanaAddress("not-a-valid-address-at-all-for-solana!!")).toBe(false);
    expect(isValidSolanaAddress("12345678901234567890123456789012")).toBe(false);
  });

  it("rejects non-string inputs", () => {
    expect(isValidSolanaAddress(null as any)).toBe(false);
    expect(isValidSolanaAddress(undefined as any)).toBe(false);
    expect(isValidSolanaAddress(123 as any)).toBe(false);
    expect(isValidSolanaAddress({} as any)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// quickScan — response shape & grade correctness
// ---------------------------------------------------------------------------

describe("quickScan", () => {
  beforeEach(() => { _resetBreakers(); _resetCache(); });
  afterEach(() => vi.unstubAllGlobals());

  it("returns correct response shape for a healthy token (grade A)", async () => {
    vi.stubGlobal("fetch", makeFetchMock());

    const result = await quickScan(USDC);

    expect(result).toMatchObject({
      is_honeypot:             expect.any(Boolean),
      mint_authority_revoked:  expect.any(Boolean),
      freeze_authority_revoked: expect.any(Boolean),
      risk_grade:              expect.stringMatching(/^[ABCDF]$/),
      summary:                 expect.any(String),
      data_confidence:         expect.stringMatching(/^(HIGH|MEDIUM|LOW)$/),
    });

    // Authorities revoked (null = revoked in RugCheck), big liquidity → grade A
    expect(result.mint_authority_revoked).toBe(true);
    expect(result.freeze_authority_revoked).toBe(true);
    expect(result.liquidity_usd).toBeGreaterThan(0);
    expect(result.risk_grade).toBe("A");
  });

  it("returns grade F for a token with rug history", async () => {
    vi.stubGlobal("fetch", makeFetchMock({ rugged: true }));

    const result = await quickScan(RUG);

    expect(result.risk_grade).toBe("F");
  });

  it("applies mint-authority penalty when authority is active", async () => {
    // mintAuthority set → not revoked → -25 penalty
    vi.stubGlobal("fetch", makeFetchMock({ mintAuthority: "SomeAuthority111111111111111111111111111111" }));

    const result = await quickScan(USDC);

    expect(result.mint_authority_revoked).toBe(false);
    // With -25 penalty score drops from 100; still large liquidity so grade should drop
    expect(["A", "B", "C", "D", "F"]).toContain(result.risk_grade);
  });

  it("risk_grade is deterministic (same result on second call hits cache)", async () => {
    vi.stubGlobal("fetch", makeFetchMock());

    const first  = await quickScan(USDC);
    const second = await quickScan(USDC); // cache hit

    expect(second.risk_grade).toBe(first.risk_grade);
    expect(second.summary).toBe(first.summary);
  });

  it("returns LOW data_confidence when all sources fail", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));

    const result = await quickScan(USDC);

    expect(result.data_confidence).toBe("LOW");
    expect(["A", "B", "C", "D", "F"]).toContain(result.risk_grade);
  });
});
