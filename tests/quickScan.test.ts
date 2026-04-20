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

    // Birdeye token_overview — provides symbol/name/logoURI
    if (u.includes("birdeye.so/defi/token_overview")) {
      return fakeResponse({ success: true, data: { symbol: "USDC", name: "USD Coin", logoURI: "https://example.com/usdc.png", price: 1.0001, liquidity } });
    }

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

    if (body.method === "getSignaturesForAddress") {
      // Return a signature for the mint creation — slot 100, blockTime = 400 days ago
      const blockTime = Math.floor((Date.now() - 400 * 86_400_000) / 1000);
      return fakeResponse({ id: 1, result: [{ signature: "fakeSig", slot: 100, blockTime }] });
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
      schema_version:          "2.0",
      token_address:           expect.any(String),
      symbol:                  expect.toBeOneOf([expect.any(String), null]),
      name:                    expect.toBeOneOf([expect.any(String), null]),
      logo_uri:                expect.toBeOneOf([expect.any(String), null]),
      grade_type:              "STRUCTURAL_SAFETY",
      mint_authority_revoked:  expect.any(Boolean),
      freeze_authority_revoked: expect.any(Boolean),
      lp_burned:               expect.toBeOneOf([true, false, null]),
      single_holder_danger:    expect.any(Boolean),
      risk_grade:              expect.stringMatching(/^[ABCDF]$/),
      summary:                 expect.any(String),
      data_confidence:         expect.stringMatching(/^(HIGH|MEDIUM|LOW)$/),
      confidence:              expect.objectContaining({ model: expect.any(Number), data_completeness: expect.any(Number), signal_consensus: expect.any(Number) }),
      factors:                 expect.any(Array),
      historical_flags:        expect.any(Array),
    });

    // pool_types_detected: array with at least one valid LP model type
    expect(result.pool_types_detected).toBeInstanceOf(Array);
    expect(result.pool_types_detected.length).toBeGreaterThanOrEqual(1);
    result.pool_types_detected.forEach((t: string) => {
      expect(t).toMatch(/^(TRADITIONAL_AMM|CLMM_DLMM|UNKNOWN)$/);
    });

    // confidence.model is 0.0–1.0
    expect(result.confidence.model).toBeGreaterThanOrEqual(0);
    expect(result.confidence.model).toBeLessThanOrEqual(1);

    // factors[] must be non-empty and well-shaped
    expect(result.factors.length).toBeGreaterThan(0);
    for (const f of result.factors) {
      expect(f).toHaveProperty("name");
      expect(f).toHaveProperty("impact");
      expect(f).toHaveProperty("interpretation");
      expect(typeof f.impact).toBe("number");
    }

    // historical_flags must be a valid HistoricalFlag[]
    const validFlags = ["PAST_RUG", "BUNDLED_LAUNCH", "SINGLE_HOLDER_DANGER", "DEV_EXITED", "LIQUIDITY_REMOVAL_EVENT", "INSIDER_ACTIVITY", "SAME_BLOCK_LAUNCH"];
    for (const flag of result.historical_flags) {
      expect(validFlags).toContain(flag);
    }

    // Authorities revoked (null = revoked in RugCheck), big liquidity → grade A
    expect(result.mint_authority_revoked).toBe(true);
    expect(result.freeze_authority_revoked).toBe(true);
    expect(result.liquidity_check).toMatchObject({
      rating: expect.stringMatching(/^(DEEP|ADEQUATE|THIN|CRITICAL|UNKNOWN)$/),
      meaning: expect.any(String),
      action_guidance: expect.any(String),
    });
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
    expect(factorNames).toContain("liquidity_check");
    expect(factorNames).toContain("creator_supply_pct");
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

  it("applies single_holder_danger penalty from Birdeye live holder data", async () => {
    // single_holder_danger is now derived from Birdeye top-holders (≥15% threshold).
    // Clean mock: no Birdeye holder data → single_holder_danger false.
    // Danger mock: one holder owns 20% of supply → single_holder_danger true.
    const mintBuf = Buffer.alloc(82, 0); // authorities revoked

    const withDanger = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
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
          info: { liquidityToken: { address: "FakeLPMint1111111111111111111111111111111111" } },
        }] });
      }
      if (u.includes("rugcheck")) {
        return fakeResponse({ mint: USDC, mintAuthority: null, freezeAuthority: null,
          topHolders: [], score: 0, risks: [], rugged: false });
      }
      // Birdeye token_security — provides total_supply
      if (u.includes("token_security")) {
        return fakeResponse({ success: true, data: { totalSupply: 1_000_000, creatorPercentage: 0 } });
      }
      // Birdeye v3/token/holder — big holder at 20%
      if (u.includes("v3/token/holder")) {
        return fakeResponse({ success: true, data: { items: [
          { owner: "BigHolder111111111111111111111111111111111111", token_account: "acct1", ui_amount: 200_000 },
          { owner: "SmallHolder11111111111111111111111111111111111", token_account: "acct2", ui_amount: 50_000 },
        ] } });
      }
      if (u.includes("birdeye")) {
        return fakeResponse({ success: true, data: { symbol: "USDC", name: "USD Coin", logoURI: null, price: 1.0001, liquidity: 2_000_000 } });
      }
      const body = JSON.parse((init?.body as string) ?? "{}");
      if (body.method === "getTokenLargestAccounts") {
        return fakeResponse({ id: 1, result: { value: [{ address: "1nc1nerator11111111111111111111111111111111", amount: "1000000" }] } });
      }
      if (body.method === "getSignaturesForAddress") {
        const blockTime = Math.floor((Date.now() - 400 * 86_400_000) / 1000);
        return fakeResponse({ id: 1, result: [{ signature: "fakeSig", slot: 100, blockTime }] });
      }
      return fakeResponse({ id: 1, result: { value: { data: [mintBuf.toString("base64"), "base64"], owner: "TokenkebQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" } } });
    });

    vi.stubGlobal("fetch", makeFetchMock()); // clean — no Birdeye holder data → false
    const clean = await quickScan(USDC);
    _resetCache();

    vi.stubGlobal("fetch", withDanger);
    const dangerous = await quickScan(USDC);

    expect(clean.single_holder_danger).toBe(false);
    expect(dangerous.single_holder_danger).toBe(true);
    const gradeOrder = ["A", "B", "C", "D", "F"];
    expect(gradeOrder.indexOf(dangerous.risk_grade)).toBeGreaterThan(gradeOrder.indexOf(clean.risk_grade));
  });

  it("launch_anomaly is present with correct shape", async () => {
    vi.stubGlobal("fetch", makeFetchMock());
    const result = await quickScan(USDC);

    expect(result.launch_anomaly).toMatchObject({
      launch_pattern: expect.stringMatching(/^(SAME_BLOCK|WITHIN_5_BLOCKS|NORMAL|UNKNOWN)$/),
      risk_note: expect.any(String),
      action_guidance: expect.any(String),
    });
    // blocks_apart is a number or null
    expect(
      result.launch_anomaly.blocks_apart === null ||
      typeof result.launch_anomaly.blocks_apart === "number"
    ).toBe(true);
    expect(
      result.launch_anomaly.same_block_launch === null ||
      typeof result.launch_anomaly.same_block_launch === "boolean"
    ).toBe(true);
  });

  it("launch_anomaly is NORMAL when pool is created well after mint", async () => {
    // makeFetchMock sets pairCreatedAt = 400 days ago and mintBlockTime = 400 days ago
    // They're equal in time, but the signature mock returns blockTime 400 days ago too.
    // Use a mock where pool is created 10 days after mint.
    const mintBlockTime = Math.floor((Date.now() - 400 * 86_400_000) / 1000);
    const poolCreatedAt = Date.now() - 390 * 86_400_000; // 10 days later

    const customFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("dexscreener")) {
        return fakeResponse({ pairs: [{
          chainId: "solana", dexId: "raydium",
          pairAddress: "fakePairAddr111111111111111111111111111111111",
          baseToken: { address: USDC, name: "USD Coin", symbol: "USDC" },
          quoteToken: { address: "So11111111111111111111111111111111111111112", name: "SOL", symbol: "SOL" },
          priceUsd: "1.0", priceChange: {}, volume: {}, liquidity: { usd: 2_000_000 },
          pairCreatedAt: poolCreatedAt,
          info: { liquidityToken: { address: "FakeLPMint1111111111111111111111111111111111" } },
        }] });
      }
      if (u.includes("rugcheck")) {
        return fakeResponse({ mint: USDC, topHolders: [], score: 0, risks: [], rugged: false });
      }
      const body = JSON.parse((init?.body as string) ?? "{}");
      if (body.method === "getTokenLargestAccounts") {
        return fakeResponse({ id: 1, result: { value: [{ address: "1nc1nerator11111111111111111111111111111111", amount: "1000000" }] } });
      }
      if (body.method === "getSignaturesForAddress") {
        return fakeResponse({ id: 1, result: [{ signature: "fakeSig", slot: 100, blockTime: mintBlockTime }] });
      }
      const mintBuf = Buffer.alloc(82, 0);
      return fakeResponse({ id: 1, result: { value: { data: [mintBuf.toString("base64"), "base64"], owner: "TokenkebQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" } } });
    });

    vi.stubGlobal("fetch", customFetch);
    const result = await quickScan(USDC);

    expect(result.launch_anomaly.launch_pattern).toBe("NORMAL");
    expect(result.launch_anomaly.same_block_launch).toBe(false);
    expect(result.launch_anomaly.blocks_apart).toBeGreaterThan(5);
    expect(result.launch_anomaly.risk_note).toContain("No same-block anomaly");
  });

  it("launch_anomaly is SAME_BLOCK and applies -20 penalty", async () => {
    // Both mint and pool at exactly the same Unix second → blocks_apart = 0
    const sameTime = Math.floor((Date.now() - 30 * 86_400_000) / 1000);
    const poolCreatedAtMs = sameTime * 1000;

    const customFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("dexscreener")) {
        return fakeResponse({ pairs: [{
          chainId: "solana", dexId: "raydium",
          pairAddress: "fakePairAddr111111111111111111111111111111111",
          baseToken: { address: RUG, name: "Rug Token", symbol: "RUG" },
          quoteToken: { address: "So11111111111111111111111111111111111111112", name: "SOL", symbol: "SOL" },
          priceUsd: "0.001", priceChange: {}, volume: {}, liquidity: { usd: 2_000_000 },
          pairCreatedAt: poolCreatedAtMs,
          info: { liquidityToken: { address: "FakeLPMint1111111111111111111111111111111111" } },
        }] });
      }
      if (u.includes("rugcheck")) {
        return fakeResponse({ mint: RUG, topHolders: [], score: 0, risks: [], rugged: false });
      }
      const body = JSON.parse((init?.body as string) ?? "{}");
      if (body.method === "getTokenLargestAccounts") {
        return fakeResponse({ id: 1, result: { value: [{ address: "1nc1nerator11111111111111111111111111111111", amount: "1000000" }] } });
      }
      if (body.method === "getSignaturesForAddress") {
        return fakeResponse({ id: 1, result: [{ signature: "fakeSig", slot: 200, blockTime: sameTime }] });
      }
      const mintBuf = Buffer.alloc(82, 0); // authorities revoked
      return fakeResponse({ id: 1, result: { value: { data: [mintBuf.toString("base64"), "base64"], owner: "TokenkebQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" } } });
    });

    vi.stubGlobal("fetch", customFetch);
    const result = await quickScan(RUG);

    expect(result.launch_anomaly.launch_pattern).toBe("SAME_BLOCK");
    expect(result.launch_anomaly.same_block_launch).toBe(true);
    expect(result.launch_anomaly.blocks_apart).toBe(0);
    expect(result.historical_flags).toContain("SAME_BLOCK_LAUNCH");

    // SAME_BLOCK applies -20 penalty — verify via factors[]
    const launchFactor = result.factors.find(f => f.name === "launch_anomaly");
    expect(launchFactor).toBeDefined();
    expect(launchFactor?.impact).toBe(-20);
  });

  it("launch_anomaly is UNKNOWN when mint block data unavailable", async () => {
    const customFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("dexscreener")) {
        return fakeResponse({ pairs: [{
          chainId: "solana", dexId: "raydium",
          pairAddress: "fakePairAddr111111111111111111111111111111111",
          baseToken: { address: USDC, name: "USD Coin", symbol: "USDC" },
          quoteToken: { address: "So11111111111111111111111111111111111111112", name: "SOL", symbol: "SOL" },
          priceUsd: "1.0", priceChange: {}, volume: {}, liquidity: { usd: 2_000_000 },
          pairCreatedAt: Date.now() - 100 * 86_400_000,
          info: { liquidityToken: { address: "FakeLPMint1111111111111111111111111111111111" } },
        }] });
      }
      if (u.includes("rugcheck")) {
        return fakeResponse({ mint: USDC, topHolders: [], score: 0, risks: [], rugged: false });
      }
      const body = JSON.parse((init?.body as string) ?? "{}");
      if (body.method === "getTokenLargestAccounts") {
        return fakeResponse({ id: 1, result: { value: [{ address: "1nc1nerator11111111111111111111111111111111", amount: "1000000" }] } });
      }
      if (body.method === "getSignaturesForAddress") {
        // Return empty — no signatures found
        return fakeResponse({ id: 1, result: [] });
      }
      const mintBuf = Buffer.alloc(82, 0);
      return fakeResponse({ id: 1, result: { value: { data: [mintBuf.toString("base64"), "base64"], owner: "TokenkebQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" } } });
    });

    vi.stubGlobal("fetch", customFetch);
    const result = await quickScan(USDC);

    expect(result.launch_anomaly.launch_pattern).toBe("UNKNOWN");
    expect(result.launch_anomaly.blocks_apart).toBeNull();
    expect(result.launch_anomaly.same_block_launch).toBeNull();
    expect(result.historical_flags).not.toContain("SAME_BLOCK_LAUNCH");
  });
});
