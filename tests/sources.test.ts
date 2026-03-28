import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { _resetBreakers } from "../src/circuitBreaker.js";
import { _resetCache } from "../src/cache.js";
import { getDexScreenerToken } from "../src/sources/dexscreener.js";
import { getRugCheckSummary } from "../src/sources/rugcheck.js";
import { getTokenInfo } from "../src/sources/helius.js";
import { quickScan } from "../src/scanner/quickScan.js";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeResponse(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    headers: new Headers(headers),
  };
}

function solanaPath() {
  return [{
    chainId: "solana",
    dexId: "raydium",
    pairAddress: "fakePair1111111111111111111111111111111111111",
    baseToken:  { address: USDC, name: "USD Coin", symbol: "USDC" },
    quoteToken: { address: "So11111111111111111111111111111111111111112", name: "SOL", symbol: "SOL" },
    priceUsd: "1.0001",
    priceChange: { h1: 0.1, h24: 0.2 },
    volume: { h1: 50_000, h24: 1_000_000 },
    liquidity: { usd: 3_000_000 },
    txns: { h1: { buys: 150, sells: 50 }, h24: { buys: 1500, sells: 500 } },
    pairCreatedAt: Date.now() - 200 * 86_400_000,
  }];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// DexScreener client
// ---------------------------------------------------------------------------

describe("getDexScreenerToken", () => {
  beforeEach(() => { _resetBreakers(); _resetCache(); });
  afterEach(() => vi.unstubAllGlobals());

  it("parses a 200 response and returns derived fields", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      fakeResponse({ pairs: solanaPath() })
    ));

    const result = await getDexScreenerToken(USDC, { timeout: 1000 });

    expect(result.price_usd).toBeCloseTo(1.0001);
    expect(result.liquidity_usd).toBe(3_000_000);
    expect(result.buy_sell_ratio_1h).toBeCloseTo(150 / 200); // 0.75
    expect(result.pairs).toHaveLength(1);
  });

  it("throws and records a failure on HTTP 500", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      fakeResponse({}, 500)
    ));

    await expect(getDexScreenerToken(USDC, { timeout: 1000 })).rejects.toThrow("DexScreener HTTP 500");
  });

  it("throws and records a failure on network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    await expect(getDexScreenerToken(USDC, { timeout: 1000 })).rejects.toThrow("ECONNREFUSED");
  });

  it("returns null pair when no Solana pairs found", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      fakeResponse({ pairs: [] })
    ));

    const result = await getDexScreenerToken(USDC, { timeout: 1000 });

    expect(result.pair).toBeNull();
    expect(result.price_usd).toBeNull();
    expect(result.liquidity_usd).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// RugCheck client
// ---------------------------------------------------------------------------

describe("getRugCheckSummary", () => {
  beforeEach(() => { _resetBreakers(); _resetCache(); });
  afterEach(() => vi.unstubAllGlobals());

  it("parses a 200 response correctly", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      fakeResponse({
        mint: USDC,
        mintAuthority: null,
        freezeAuthority: null,
        topHolders: Array.from({ length: 10 }, (_, i) => ({
          address: `addr${i}${"1".repeat(37)}`, pct: 5, amount: 1000, uiAmount: 1000, uiAmountString: "1000",
        })),
        score: 150,
        risks: [],
        rugged: null,
      })
    ));

    const result = await getRugCheckSummary(USDC, { timeout: 1000 });

    expect(result).not.toBeNull();
    // RugCheck owns: has_rug_history, bundled_launch_detected, rugcheck_risk_score, insider_flags, report_age_seconds
    // mint_authority_revoked and freeze_authority_revoked are Helius-only fields
    expect(result!.has_rug_history).toBe(false);
    expect(result!.bundled_launch_detected).toBe(false);
    expect(result!.insider_flags).toBe(false);
    expect(result!.report_age_seconds).toBe(-1); // no timestamp in mock → -1
    expect(result!.top_10_holder_pct).toBeCloseTo(50);   // 10 × 5% — RugCheck still owns holder concentration
    expect(result!.rugcheck_risk_score).toBe(150);
    expect(result!.single_holder_danger).toBe(false);
  });

  it("throws on HTTP 500", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fakeResponse({}, 500)));

    await expect(getRugCheckSummary(USDC, { timeout: 1000 })).rejects.toThrow("RugCheck HTTP 500");
  });

  it("returns null for 400 (invalid address) without tripping breaker", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fakeResponse({}, 400)));

    const result = await getRugCheckSummary(USDC, { timeout: 1000 });

    expect(result).toBeNull();
    // Breaker should remain CLOSED — 400 is not a transient failure
    const { isAvailable } = await import("../src/circuitBreaker.js");
    expect(isAvailable("rugcheck")).toBe(true);
  });

  it("detects honeypot from risks array", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      fakeResponse({
        mint: USDC,
        topHolders: [],
        risks: [{ name: "Honeypot", description: "honeypot pattern detected", score: 100, level: "danger", value: "" }],
        rugged: false,
      })
    ));

    const result = await getRugCheckSummary(USDC, { timeout: 1000 });

    expect(result!.is_honeypot).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Helius / RPC client
// ---------------------------------------------------------------------------

describe("getTokenInfo", () => {
  beforeEach(() => { _resetBreakers(); _resetCache(); });
  afterEach(() => vi.unstubAllGlobals());

  it("parses a valid mint account base64 response", async () => {
    // Build a minimal 82-byte buffer: both COption fields set to 0 (revoked)
    const buf = Buffer.alloc(82, 0);
    const base64Data = buf.toString("base64");

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      fakeResponse({
        id: 1,
        result: {
          value: {
            data: [base64Data, "base64"],
            owner: "TokenkebQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
          },
        },
      })
    ));

    const result = await getTokenInfo(USDC, { timeout: 1000 });

    expect(result).not.toBeNull();
    expect(result!.mint_authority_revoked).toBe(true);
    expect(result!.freeze_authority_revoked).toBe(true);
  });

  it("returns null when account data is missing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      fakeResponse({ id: 1, result: { value: null } })
    ));

    const result = await getTokenInfo(USDC, { timeout: 1000 });

    expect(result).toBeNull();
  });

  it("retries next RPC endpoint on 429 then succeeds", async () => {
    const buf = Buffer.alloc(82, 0);
    let callCount = 0;

    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // First endpoint: return HTTP 429 (non-ok) → rpcPost throws → rpcWithRetry retries
        return fakeResponse({}, 429);
      }
      // Second endpoint succeeds
      return fakeResponse({
        id: 1,
        result: {
          value: {
            data: [buf.toString("base64"), "base64"],
            owner: "TokenkebQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
          },
        },
      });
    }));

    const result = await getTokenInfo(USDC, { timeout: 2000 });

    expect(result).not.toBeNull();
    expect(callCount).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Circuit breaker integration
// ---------------------------------------------------------------------------

describe("circuit breaker integration via DexScreener", () => {
  beforeEach(() => { _resetBreakers(); _resetCache(); });
  afterEach(() => vi.unstubAllGlobals());

  it("opens after 5 consecutive DexScreener failures and then rejects immediately", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fakeResponse({}, 500)));

    // Exhaust the breaker (5 failures)
    for (let i = 0; i < 5; i++) {
      await getDexScreenerToken(USDC, { timeout: 200 }).catch(() => {});
    }

    // 6th call should throw "circuit breaker OPEN" without hitting fetch
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(getDexScreenerToken(USDC, { timeout: 200 })).rejects.toThrow(/circuit breaker/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("OPEN breaker recovers after cooldown and allows a probe", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fakeResponse({}, 500)));
    for (let i = 0; i < 5; i++) {
      await getDexScreenerToken(USDC, { timeout: 200 }).catch(() => {});
    }

    // Advance time past cooldown
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 61_000);

    // Probe should go through (HALF_OPEN); mock a success this time
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fakeResponse({ pairs: solanaPath() })));

    const result = await getDexScreenerToken(USDC, { timeout: 200 });
    vi.restoreAllMocks();

    expect(result.liquidity_usd).toBe(3_000_000);
  });
});

// ---------------------------------------------------------------------------
// Parallel fetching — sources run concurrently (not sequentially)
// ---------------------------------------------------------------------------

describe("parallel fetching", () => {
  beforeEach(() => { _resetBreakers(); _resetCache(); });
  afterEach(() => vi.unstubAllGlobals());

  it("total wall-clock time is ~max(source latencies), not their sum", async () => {
    const DELAY_MS = 80; // each source takes 80 ms

    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: string) => {
      await sleep(DELAY_MS);
      const u = String(url);
      if (u.includes("dexscreener")) {
        return fakeResponse({ pairs: solanaPath() });
      }
      if (u.includes("rugcheck")) {
        return fakeResponse({
          mint: USDC, mintAuthority: null, freezeAuthority: null,
          topHolders: [], risks: [], rugged: false,
        });
      }
      // Helius RPC
      return fakeResponse({ id: 1, result: { value: null } });
    }));

    const start = Date.now();
    await quickScan(USDC);
    const elapsed = Date.now() - start;

    // Three sources at 80 ms each: sequential would be ~240 ms, parallel ~80 ms.
    // Allow 2× headroom for CI jitter.
    expect(elapsed).toBeLessThan(DELAY_MS * 2.5);
  });
});
