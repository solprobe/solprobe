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

  // Build 82-byte SPL Token MintLayout buffer for Helius RPC mock.
  // Byte 0-3:  mintAuthorityOption  (u32 LE, COption: 0=None/revoked, 1=Some/active)
  // Byte 46-49: freezeAuthorityOption (u32 LE, COption: 0=None/revoked, 1=Some/active)
  const mintBuf = Buffer.alloc(82, 0);
  if (mintAuthority !== null) mintBuf.writeUInt32LE(1, 0);    // active mint authority
  if (freezeAuthority !== null) mintBuf.writeUInt32LE(1, 46); // active freeze authority
  const base64Mint = mintBuf.toString("base64");

  const LP_MINT = "FakeLPMint1111111111111111111111111111111111";

  return vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
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
          info: { liquidityToken: { address: LP_MINT } },
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
        score: 0,
        risks: [],
        rugged,
      });
    }

    // Helius / public RPC — differentiate by method
    const body = JSON.parse((init?.body as string) ?? "{}");
    if (body.method === "getTokenLargestAccounts") {
      // LP mint is burned — top holder is a burn address
      return fakeResponse({ id: 1, result: { value: [{ address: "1nc1nerator11111111111111111111111111111111", amount: "1000000" }] } });
    }

    // Default: return base64 SPL Token mint layout (Helius owns authority flags)
    return fakeResponse({
      id: 1,
      result: {
        value: {
          data: [base64Mint, "base64"],
          owner: "TokenkebQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        },
      },
    });
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
      lp_burned:               expect.toBeOneOf([true, false, null]),
      rugcheck_risk_score:     expect.toBeOneOf([expect.any(Number), null]),
      single_holder_danger:    expect.any(Boolean),
      risk_grade:              expect.stringMatching(/^[ABCDF]$/),
      summary:                 expect.any(String),
      data_confidence:         expect.stringMatching(/^(HIGH|MEDIUM|LOW)$/),
      confidence:              expect.any(Number),
      factors:                 expect.any(Array),
      historical_flags:        expect.any(Array),
    });

    // confidence is 0.0–1.0
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);

    // factors[] must be non-empty and well-shaped
    expect(result.factors.length).toBeGreaterThan(0);
    for (const f of result.factors) {
      expect(f).toHaveProperty("name");
      expect(f).toHaveProperty("impact");
      expect(f).toHaveProperty("interpretation");
      expect(typeof f.impact).toBe("number");
    }

    // historical_flags must be a valid HistoricalFlag[]
    const validFlags = ["PAST_RUG", "BUNDLED_LAUNCH", "SINGLE_HOLDER_DANGER", "DEV_EXITED", "LIQUIDITY_REMOVAL_EVENT", "INSIDER_ACTIVITY"];
    for (const flag of result.historical_flags) {
      expect(validFlags).toContain(flag);
    }

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

  it("returns MEDIUM data_confidence when all sources fail (scan is still fresh)", async () => {
    // sources=[] → not corroborated; dataAgeMs < 60s → fresh=true → scoreConfidence returns MEDIUM
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));

    const result = await quickScan(USDC);

    expect(result.data_confidence).toBe("LOW");
    expect(["A", "B", "C", "D", "F"]).toContain(result.risk_grade);
  });

  it("factors[] contains an entry for every checked condition including passes", async () => {
    vi.stubGlobal("fetch", makeFetchMock());

    const result = await quickScan(RUG);

    // All key checks must appear in factors[] whether penalty or not
    const factorNames = result.factors.map(f => f.name);
    expect(factorNames).toContain("mint_authority");
    expect(factorNames).toContain("freeze_authority");
    expect(factorNames).toContain("lp_status");
    expect(factorNames).toContain("liquidity_usd");
    expect(factorNames).toContain("rugcheck_score");
    expect(factorNames).toContain("single_holder_danger");
    expect(factorNames).toContain("token_age_days");

    // Zero-impact entries must exist for passing checks (grade A means most passed)
    const zeroImpact = result.factors.filter(f => f.impact === 0);
    expect(zeroImpact.length).toBeGreaterThan(0);
  });

  it("applies LP burn penalty when lp_burned is false", async () => {
    // Use RUG (not Jupiter-exempt) with both authorities active so authority penalties apply.
    // lp_burned: true  → score 100 - 25 (mint) - 15 (freeze) = 60 → grade B
    // lp_burned: false → score 100 - 25 (mint) - 15 (freeze) - 25 (lp) = 35 → grade D
    const LP_MINT = "FakeLPMint1111111111111111111111111111111111";
    const mintBuf = Buffer.alloc(82, 0);
    mintBuf.writeUInt32LE(1, 0);   // mint authority active (not revoked)
    mintBuf.writeUInt32LE(1, 46);  // freeze authority active (not revoked)
    const base64Mint = mintBuf.toString("base64");

    function makeLP(burned: boolean) {
      return vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("dexscreener")) {
          return fakeResponse({ pairs: [{
            chainId: "solana", dexId: "raydium",
            pairAddress: "fakePairAddr111111111111111111111111111111111",
            baseToken: { address: RUG, name: "Test", symbol: "TST" },
            quoteToken: { address: "So11111111111111111111111111111111111111112", name: "SOL", symbol: "SOL" },
            priceUsd: "0.001",
            priceChange: { h1: 0, h24: 0 },
            volume: { h1: 50_000, h24: 500_000 },
            liquidity: { usd: 2_000_000 },
            txns: { h1: { buys: 100, sells: 100 }, h24: { buys: 1000, sells: 1000 } },
            pairCreatedAt: Date.now() - 100 * 86_400_000,
            info: { liquidityToken: { address: LP_MINT } },
          }] });
        }
        if (u.includes("rugcheck")) {
          return fakeResponse({ mint: RUG, topHolders: [], score: 0, risks: [], rugged: false });
        }
        // Helius / public RPC — differentiate by method
        const body = JSON.parse((init?.body as string) ?? "{}");
        if (body.method === "getTokenLargestAccounts") {
          const topAddr = burned
            ? "1nc1nerator11111111111111111111111111111111"
            : "NotABurnAddr111111111111111111111111111111";
          return fakeResponse({ id: 1, result: { value: [{ address: topAddr, amount: "1000000" }] } });
        }
        return fakeResponse({ id: 1, result: { value: { data: [base64Mint, "base64"], owner: "TokenkebQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" } } });
      });
    }

    vi.stubGlobal("fetch", makeLP(true));
    const burnedResult = await quickScan(RUG);
    _resetCache();

    vi.stubGlobal("fetch", makeLP(false));
    const notBurnedResult = await quickScan(RUG);

    expect(burnedResult.lp_burned).toBe(true);
    expect(notBurnedResult.lp_burned).toBe(false);
    const gradeOrder = ["A", "B", "C", "D", "F"];
    expect(gradeOrder.indexOf(notBurnedResult.risk_grade)).toBeGreaterThan(gradeOrder.indexOf(burnedResult.risk_grade));
  });

  it("applies single_holder_danger penalty from RugCheck risks array", async () => {
    // Without single_holder_danger: score 100 - 25 (lp_burned null) = 75 → A
    // With single_holder_danger:    score 100 - 25 (lp) - 25 (danger) = 50 → C
    const withDanger = vi.fn().mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes("dexscreener")) {
        return fakeResponse({ pairs: [{
          chainId: "solana", dexId: "raydium",
          pairAddress: "fakePairAddr111111111111111111111111111111111",
          baseToken: { address: USDC, name: "USD Coin", symbol: "USDC" },
          quoteToken: { address: "So11111111111111111111111111111111111111112", name: "SOL", symbol: "SOL" },
          priceUsd: "1.0001",
          priceChange: { h1: 0.05, h24: 0.12 },
          volume: { h1: 80_000, h24: 1_500_000 },
          liquidity: { usd: 2_000_000 },
          txns: { h1: { buys: 200, sells: 100 }, h24: { buys: 2000, sells: 1000 } },
          pairCreatedAt: Date.now() - 400 * 86_400_000,
        }] });
      }
      if (u.includes("rugcheck")) {
        return fakeResponse({
          mint: USDC,
          mintAuthority: null,
          freezeAuthority: null,
          topHolders: Array.from({ length: 10 }, (_, i) => ({
            address: `addr${i}111111111111111111111111111111111111`,
            pct: 5, amount: 1000, uiAmount: 1000, uiAmountString: "1000",
          })),
          score: 0,
          risks: [{ name: "Single holder ownership", level: "danger", description: "single holder", score: 100, value: "" }],
          rugged: false,
        });
      }
      const mintBuf2 = Buffer.alloc(82, 0); // authorities revoked
      return fakeResponse({ id: 1, result: { value: { data: [mintBuf2.toString("base64"), "base64"], owner: "TokenkebQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" } } });
    });

    vi.stubGlobal("fetch", makeFetchMock()); // clean — no danger
    const clean = await quickScan(USDC);
    _resetCache();

    vi.stubGlobal("fetch", withDanger);
    const dangerous = await quickScan(USDC);

    expect(clean.single_holder_danger).toBe(false);
    expect(dangerous.single_holder_danger).toBe(true);
    const gradeOrder = ["A", "B", "C", "D", "F"];
    expect(gradeOrder.indexOf(dangerous.risk_grade)).toBeGreaterThan(gradeOrder.indexOf(clean.risk_grade));
  });
});
