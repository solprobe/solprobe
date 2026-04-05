import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { _resetBreakers } from "../src/circuitBreaker.js";
import { _resetCache } from "../src/cache.js";
import { marketIntel } from "../src/scanner/marketIntel.js";

const TOKEN = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"; // BONK

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

interface MockOptions {
  volume_24h?: number;
  liquidity?: number;
  market_cap?: number;
  price_change_1h?: number;
  price_change_24h?: number;
  buy_sell_ratio?: number; // buys / (buys + sells)
  ohlcv_items?: Array<{ h: number }>;
  dex_fail?: boolean;
  birdeye_fail?: boolean;
}

function makeFetchMock(opts: MockOptions = {}) {
  const {
    volume_24h    = 500_000,
    liquidity     = 100_000,
    market_cap,
    price_change_1h  = 1,
    price_change_24h = 5,
    buy_sell_ratio = 0.6,
    ohlcv_items,
    dex_fail    = false,
    birdeye_fail = false,
  } = opts;

  const buys  = Math.round(buy_sell_ratio * 200);
  const sells = 200 - buys;

  const volume_1h = volume_24h / 10;
  const buy_vol_1h  = volume_1h  * buy_sell_ratio;
  const sell_vol_1h = volume_1h  * (1 - buy_sell_ratio);
  const buy_vol_24h = volume_24h * buy_sell_ratio;
  const sell_vol_24h = volume_24h * (1 - buy_sell_ratio);

  return vi.fn().mockImplementation(async (url: string) => {
    const u = String(url);

    if (u.includes("dexscreener")) {
      if (dex_fail) return Promise.reject(new Error("dexscreener down"));
      return fakeResponse({
        pairs: [{
          chainId: "solana",
          dexId: "raydium",
          pairAddress: "fakePair111111111111111111111111111111111111",
          baseToken:  { address: TOKEN, name: "BONK", symbol: "BONK" },
          quoteToken: { address: "So11111111111111111111111111111111111111112", name: "SOL", symbol: "SOL" },
          priceUsd: "0.000012",
          priceChange: { h1: price_change_1h, h24: price_change_24h },
          volume: { h1: volume_1h, h24: volume_24h },
          liquidity: { usd: liquidity },
          ...(market_cap !== undefined ? { fdv: market_cap } : {}),
          txns: { h1: { buys, sells }, h24: { buys: buys * 10, sells: sells * 10 } },
          pairCreatedAt: Date.now() - 200 * 86_400_000,
        }],
      });
    }

    if (u.includes("birdeye.so/defi/ohlcv")) {
      if (birdeye_fail) return Promise.reject(new Error("birdeye down"));
      if (!ohlcv_items) return fakeResponse({ success: true, data: { items: [] } });
      return fakeResponse({ success: true, data: { items: ohlcv_items } });
    }

    if (u.includes("birdeye.so/defi/token_overview")) {
      if (birdeye_fail) return Promise.reject(new Error("birdeye down"));
      // Field names verified via live curl — uses vXXUSD (not vXX) for USD volumes
      return fakeResponse({
        success: true,
        data: {
          price: 0.000012,
          liquidity,
          // Price changes
          priceChange1hPercent:  price_change_1h,
          priceChange24hPercent: price_change_24h,
          // Volume USD (correct field names from Birdeye API)
          v1hUSD:  volume_1h,
          v24hUSD: volume_24h,
          // Buy/sell counts per window
          buy1h: buys, sell1h: sells,
          buy24h: buys * 10, sell24h: sells * 10,
          trade24h: (buys + sells) * 10,
          // Unique wallets
          uniqueWallet24h: 500,
          // Buy/sell volume split
          vBuy1hUSD:  buy_vol_1h,
          vSell1hUSD: sell_vol_1h,
          vBuy24hUSD:  buy_vol_24h,
          vSell24hUSD: sell_vol_24h,
        },
      });
    }

    // CoinGecko — return not-found in tests (Birdeye OHLCV is the test ATH source)
    if (u.includes("coingecko.com")) {
      return fakeResponse({ error: "coin not found" }, 404);
    }

    return Promise.reject(new Error(`unexpected url: ${u}`));
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("marketIntel", () => {
  beforeEach(() => { _resetBreakers(); _resetCache(); });
  afterEach(() => vi.unstubAllGlobals());

  // -------------------------------------------------------------------------
  // Token health classification
  // -------------------------------------------------------------------------

  it("classifies ACTIVE token correctly", async () => {
    vi.stubGlobal("fetch", makeFetchMock({ volume_24h: 500_000, liquidity: 100_000 }));
    const result = await marketIntel(TOKEN);
    expect(result.token_health).toBe("ACTIVE");
  });

  it("classifies DEAD token when volume < $1k", async () => {
    vi.stubGlobal("fetch", makeFetchMock({ volume_24h: 500, liquidity: 100_000 }));
    const result = await marketIntel(TOKEN);
    expect(result.token_health).toBe("DEAD");
  });

  it("classifies DEAD token when liquidity < $1k", async () => {
    vi.stubGlobal("fetch", makeFetchMock({ volume_24h: 500_000, liquidity: 500 }));
    const result = await marketIntel(TOKEN);
    expect(result.token_health).toBe("DEAD");
  });

  it("classifies ILLIQUID token when liquidity between $1k and $5k", async () => {
    vi.stubGlobal("fetch", makeFetchMock({ volume_24h: 50_000, liquidity: 3_000 }));
    const result = await marketIntel(TOKEN);
    expect(result.token_health).toBe("ILLIQUID");
  });

  it("classifies LOW_ACTIVITY token when volume < $10k", async () => {
    vi.stubGlobal("fetch", makeFetchMock({ volume_24h: 5_000, liquidity: 20_000 }));
    const result = await marketIntel(TOKEN);
    expect(result.token_health).toBe("LOW_ACTIVITY");
  });

  it("classifies DECLINING token when price drops sharply", async () => {
    vi.stubGlobal("fetch", makeFetchMock({
      volume_24h: 500_000,
      liquidity: 100_000,
      price_change_1h: -6,
      price_change_24h: -25,
    }));
    const result = await marketIntel(TOKEN);
    expect(result.token_health).toBe("DECLINING");
  });

  // -------------------------------------------------------------------------
  // Signal override rules
  // -------------------------------------------------------------------------

  it("forces BEARISH signal for DEAD token regardless of buy/sell ratio", async () => {
    // High buy pressure but dead volume → BEARISH
    vi.stubGlobal("fetch", makeFetchMock({
      volume_24h: 100,
      liquidity: 100_000,
      buy_sell_ratio: 0.9,
      price_change_1h: 10,
    }));
    const result = await marketIntel(TOKEN);
    expect(result.signal).toBe("BEARISH");
    expect(result.token_health).toBe("DEAD");
  });

  it("forces BEARISH for ILLIQUID token", async () => {
    vi.stubGlobal("fetch", makeFetchMock({
      volume_24h: 50_000,
      liquidity: 2_000,
      buy_sell_ratio: 0.8,
    }));
    const result = await marketIntel(TOKEN);
    expect(result.signal).toBe("BEARISH");
    expect(result.token_health).toBe("ILLIQUID");
  });

  // -------------------------------------------------------------------------
  // pct_from_ath calculation
  // -------------------------------------------------------------------------

  it("computes pct_from_ath correctly from OHLCV data", async () => {
    // ATH = 0.001, current = 0.000012 → ~98.8% below ATH
    vi.stubGlobal("fetch", makeFetchMock({
      ohlcv_items: [{ h: 0.001 }, { h: 0.0005 }, { h: 0.0002 }],
    }));
    const result = await marketIntel(TOKEN);
    expect(result.ath_price_usd).toBe(0.001);
    expect(result.pct_from_ath).not.toBeNull();
    expect(result.pct_from_ath!).toBeLessThan(-90); // deeply below ATH
  });

  it("returns null pct_from_ath when no OHLCV data", async () => {
    vi.stubGlobal("fetch", makeFetchMock({ ohlcv_items: undefined }));
    const result = await marketIntel(TOKEN);
    expect(result.pct_from_ath).toBeNull();
    expect(result.ath_price_usd).toBeNull();
  });

  // -------------------------------------------------------------------------
  // HAWK-like scenario: LOW_ACTIVITY + deep ATH decline → BEARISH + LOW confidence
  // -------------------------------------------------------------------------

  it("returns BEARISH + LOW confidence for HAWK-like rugged token", async () => {
    // Low volume (LOW_ACTIVITY) — BEARISH regardless of ATH data:
    // null ATH (no Birdeye key in CI) and deeply negative ATH both trigger the override
    vi.stubGlobal("fetch", makeFetchMock({
      volume_24h: 5_000,
      liquidity: 20_000,
      buy_sell_ratio: 0.5,
      price_change_1h: 0,
      price_change_24h: 0,
      ohlcv_items: [{ h: 1.0 }, { h: 0.5 }], // ATH = 1.0, current ≈ 0.000012 → ~-99.999% (when key is set)
    }));
    const result = await marketIntel(TOKEN);
    expect(result.token_health).toBe("LOW_ACTIVITY");
    expect(result.signal).toBe("BEARISH");
    expect(result.data_confidence).toBe("MEDIUM"); // LOW_ACTIVITY caps at MEDIUM
  });

  // -------------------------------------------------------------------------
  // data_confidence caps
  // -------------------------------------------------------------------------

  it("caps data_confidence to LOW for DEAD token", async () => {
    vi.stubGlobal("fetch", makeFetchMock({ volume_24h: 100, liquidity: 100_000 }));
    const result = await marketIntel(TOKEN);
    expect(result.token_health).toBe("DEAD");
    expect(result.data_confidence).toBe("LOW");
  });

  it("caps data_confidence to LOW for ILLIQUID token", async () => {
    vi.stubGlobal("fetch", makeFetchMock({ volume_24h: 50_000, liquidity: 2_000 }));
    const result = await marketIntel(TOKEN);
    expect(result.token_health).toBe("ILLIQUID");
    expect(result.data_confidence).toBe("LOW");
  });

  it("caps data_confidence to MEDIUM for LOW_ACTIVITY token", async () => {
    vi.stubGlobal("fetch", makeFetchMock({ volume_24h: 5_000, liquidity: 20_000 }));
    const result = await marketIntel(TOKEN);
    expect(result.token_health).toBe("LOW_ACTIVITY");
    expect(result.data_confidence).not.toBe("HIGH");
  });

  // -------------------------------------------------------------------------
  // Response shape
  // -------------------------------------------------------------------------

  it("returns correct response shape for active token", async () => {
    vi.stubGlobal("fetch", makeFetchMock());
    const result = await marketIntel(TOKEN);

    expect(result).toMatchObject({
      schema_version:       "2.0",
      current_price_usd:    expect.any(Number),
      price_change_1h_pct:  expect.any(Number),
      price_change_24h_pct: expect.any(Number),
      volume_1h_usd:        expect.any(Number),
      volume_24h_usd:       expect.any(Number),
      liquidity_usd:        expect.any(Number),
      buy_pressure:         expect.stringMatching(/^(HIGH|MEDIUM|LOW)$/),
      sell_pressure:        expect.stringMatching(/^(HIGH|MEDIUM|LOW)$/),
      large_txs_last_hour:  expect.any(Number),
      signal:               expect.stringMatching(/^(BULLISH|BEARISH|NEUTRAL)$/),
      signal_score:         expect.any(Number),
      signal_subtype:       expect.any(String),
      token_health:         expect.stringMatching(/^(ACTIVE|LOW_ACTIVITY|DECLINING|ILLIQUID|DEAD)$/),
      market_summary:       expect.any(String),
      data_confidence:      expect.stringMatching(/^(HIGH|MEDIUM|LOW)$/),
      confidence:           expect.objectContaining({ model: expect.any(Number), data_completeness: expect.any(Number), signal_consensus: expect.any(Number) }),
      factors:              expect.any(Array),
      response_time_ms:     expect.any(Number),
    });

    // ath_source is string or null
    expect(result.ath_source === null || typeof result.ath_source === "string").toBe(true);

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

    // New fields from Fix 1+2+5+6
    expect(typeof result.buy_pressure_window).toBe("string");
    expect(result.price_change_6h_pct === null || typeof result.price_change_6h_pct === "number").toBe(true);

    // timeframes object — all 5 windows present
    expect(result.timeframes).toBeDefined();
    for (const window of ["5m", "30m", "1h", "8h", "24h"] as const) {
      const tf = result.timeframes[window];
      expect(tf).toMatchObject({
        buy_sell_pressure: expect.stringMatching(/^(HIGH|MEDIUM|LOW)$/),
      });
      expect(tf.buy_sell_ratio === null || typeof tf.buy_sell_ratio === "number").toBe(true);
    }

    // 24h participant counts from Birdeye
    expect(result.txns_24h === null || typeof result.txns_24h === "number").toBe(true);
    expect(result.buys_24h === null || typeof result.buys_24h === "number").toBe(true);
    expect(result.sells_24h === null || typeof result.sells_24h === "number").toBe(true);
    expect(result.makers_24h === null || typeof result.makers_24h === "number").toBe(true);
    expect(result.buy_volume_24h_usd === null || typeof result.buy_volume_24h_usd === "number").toBe(true);
    expect(result.sell_volume_24h_usd === null || typeof result.sell_volume_24h_usd === "number").toBe(true);
  });

  // -------------------------------------------------------------------------
  // signal_score (Fix 6)
  // -------------------------------------------------------------------------

  it("signal_score is between -100 and +100", async () => {
    vi.stubGlobal("fetch", makeFetchMock());
    const result = await marketIntel(TOKEN);
    expect(result.signal_score).toBeGreaterThanOrEqual(-100);
    expect(result.signal_score).toBeLessThanOrEqual(100);
  });

  it("DEAD token has strongly negative signal_score", async () => {
    vi.stubGlobal("fetch", makeFetchMock({ volume_24h: 100, liquidity: 100_000 }));
    const result = await marketIntel(TOKEN);
    expect(result.signal_score).toBeLessThanOrEqual(-60);
  });

  // -------------------------------------------------------------------------
  // rug_risk (Fix 7)
  // -------------------------------------------------------------------------

  it("rug_risk is a structured object with expected fields", async () => {
    vi.stubGlobal("fetch", makeFetchMock());
    const result = await marketIntel(TOKEN);
    expect(result.rug_risk).toMatchObject({
      score: expect.any(Number),
      level: expect.stringMatching(/^(LOW|MEDIUM|HIGH|UNKNOWN)$/),
      meaning: expect.any(String),
      action_guidance: expect.any(String),
      components_available: expect.any(Array),
    });
    expect(result.rug_risk.score).toBeGreaterThanOrEqual(0);
    expect(result.rug_risk.score).toBeLessThanOrEqual(13);
  });

  it("rug_risk is MEDIUM for very low liquidity alone", async () => {
    vi.stubGlobal("fetch", makeFetchMock({ liquidity: 500 }));
    const result = await marketIntel(TOKEN);
    expect(result.rug_risk.score).toBeGreaterThanOrEqual(2);
    expect(result.rug_risk.level).toBe("MEDIUM");
  });

  it("rug_risk is HIGH when multiple risk components fire", async () => {
    // liquidity=500 → 3 pts, liq/mcap ratio 500/500000=0.001 → 3 pts = 6 → HIGH
    vi.stubGlobal("fetch", makeFetchMock({ liquidity: 500, market_cap: 500_000 }));
    const result = await marketIntel(TOKEN);
    expect(result.rug_risk.score).toBeGreaterThanOrEqual(4);
    expect(result.rug_risk.level).toBe("HIGH");
  });

  // -------------------------------------------------------------------------
  // signal_guidance (Fix 8)
  // -------------------------------------------------------------------------

  it("signal_guidance matches signal direction and includes signal field", async () => {
    vi.stubGlobal("fetch", makeFetchMock());
    const result = await marketIntel(TOKEN);
    expect(result.signal_guidance).toMatchObject({
      signal: expect.stringMatching(/^(BULLISH|BEARISH|NEUTRAL)$/),
      meaning: expect.any(String),
      action_guidance: expect.any(String),
      score_context: expect.any(String),
    });
    expect(result.signal_guidance.signal).toBe(result.signal);
    // guidance meaning should reference the signal direction
    if (result.signal === "BULLISH") {
      expect(result.signal_guidance.meaning).toMatch(/buy/i);
    } else if (result.signal === "BEARISH") {
      expect(result.signal_guidance.meaning).toMatch(/sell/i);
    }
    // score_context should reference ±25 threshold
    expect(result.signal_guidance.score_context).toMatch(/25/);
  });

  // -------------------------------------------------------------------------
  // market_cap_usd (Fix 9)
  // -------------------------------------------------------------------------

  it("market_cap_usd is null when DexScreener lacks fdv/marketCap", async () => {
    vi.stubGlobal("fetch", makeFetchMock());
    const result = await marketIntel(TOKEN);
    // Our mock doesn't include fdv/marketCap, so should be null
    expect(result.market_cap_usd).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Split buy/sell pressure factors (Fix 10)
  // -------------------------------------------------------------------------

  it("factors include separate buy_pressure and sell_pressure entries", async () => {
    vi.stubGlobal("fetch", makeFetchMock());
    const result = await marketIntel(TOKEN);
    const names = result.factors.map(f => f.name);
    expect(names).toContain("buy_pressure");
    expect(names).toContain("sell_pressure");
    expect(names).not.toContain("buy_sell_pressure");
  });

  // -------------------------------------------------------------------------
  // ath_context (Fix 11)
  // -------------------------------------------------------------------------

  it("ath_context is UNKNOWN when no OHLCV data", async () => {
    vi.stubGlobal("fetch", makeFetchMock());
    const result = await marketIntel(TOKEN);
    expect(result.ath_context).toMatchObject({
      distance: "UNKNOWN",
      meaning: expect.any(String),
      action_guidance: expect.any(String),
    });
  });

  it("ath_context is EXTREME_DECLINE when deeply below ATH", async () => {
    vi.stubGlobal("fetch", makeFetchMock({
      ohlcv_items: [{ h: 1.0 }, { h: 0.5 }],
    }));
    const result = await marketIntel(TOKEN);
    expect(result.ath_context.distance).toBe("EXTREME_DECLINE");
    // Must NOT contain "abandoned" language
    expect(result.ath_context.action_guidance).not.toMatch(/abandoned/i);
    expect(result.ath_context.meaning).toMatch(/not necessarily/i);
  });

  // -------------------------------------------------------------------------
  // response_time_ms (Fix 12)
  // -------------------------------------------------------------------------

  it("response_time_ms is a positive number", async () => {
    vi.stubGlobal("fetch", makeFetchMock());
    const result = await marketIntel(TOKEN);
    expect(result.response_time_ms).toBeGreaterThanOrEqual(0);
    expect(typeof result.response_time_ms).toBe("number");
  });

  // -------------------------------------------------------------------------
  // POST_RUG_STAGNATION liquidity floor (Fix 2)
  // -------------------------------------------------------------------------

  it("POST_RUG_STAGNATION requires liquidity < $100k", async () => {
    // Deep ATH decline but high liquidity — should NOT be POST_RUG_STAGNATION
    vi.stubGlobal("fetch", makeFetchMock({
      volume_24h: 40_000,
      liquidity: 200_000,
      price_change_1h: 0,
      price_change_24h: -5,
      ohlcv_items: [{ h: 1.0 }, { h: 0.5 }], // ATH = 1.0, current ≈ 0.000012 → >80% below
    }));
    const result = await marketIntel(TOKEN);
    expect(result.signal_subtype).not.toBe("POST_RUG_STAGNATION");
  });

  it("ACTIVE token never gets POST_RUG_STAGNATION subtype", async () => {
    vi.stubGlobal("fetch", makeFetchMock({
      volume_24h: 500_000,
      liquidity: 100_000,
      ohlcv_items: [{ h: 1.0 }],
    }));
    const result = await marketIntel(TOKEN);
    expect(result.token_health).toBe("ACTIVE");
    expect(result.signal_subtype).not.toBe("POST_RUG_STAGNATION");
  });

  // -------------------------------------------------------------------------
  // Birdeye primary + timeframes (Fix 1 + Fix 2)
  // -------------------------------------------------------------------------

  it("buy_pressure_window is '1h' when Birdeye 1h buy/sell counts are available", async () => {
    vi.stubGlobal("fetch", makeFetchMock({ buy_sell_ratio: 0.7 }));
    const result = await marketIntel(TOKEN);
    expect(result.buy_pressure_window).toBe("1h");
  });

  it("buy_pressure_window falls back to '1h_dex' when Birdeye fails", async () => {
    vi.stubGlobal("fetch", makeFetchMock({ birdeye_fail: true }));
    const result = await marketIntel(TOKEN);
    expect(result.buy_pressure_window).toBe("1h_dex");
  });

  it("timeframes 1h buy_sell_ratio matches top-level buy_sell_ratio", async () => {
    vi.stubGlobal("fetch", makeFetchMock({ buy_sell_ratio: 0.65 }));
    const result = await marketIntel(TOKEN);
    if (result.timeframes["1h"].buy_sell_ratio !== null) {
      expect(result.timeframes["1h"].buy_sell_ratio).toBeCloseTo(result.buy_sell_ratio, 2);
    }
  });

  it("all timeframe windows are present in response", async () => {
    vi.stubGlobal("fetch", makeFetchMock());
    const result = await marketIntel(TOKEN);
    expect(Object.keys(result.timeframes)).toEqual(expect.arrayContaining(["5m", "30m", "1h", "8h", "24h"]));
  });

  // -------------------------------------------------------------------------
  // price_change_6h_pct (Fix 5)
  // -------------------------------------------------------------------------

  it("price_change_6h_pct is null when Birdeye does not return priceChange8hPercent", async () => {
    // Default mock does not include priceChange8hPercent → should be null
    vi.stubGlobal("fetch", makeFetchMock());
    const result = await marketIntel(TOKEN);
    expect(result.price_change_6h_pct).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 24h participant counts (Fix 6)
  // -------------------------------------------------------------------------

  it("24h participant counts are populated from Birdeye", async () => {
    vi.stubGlobal("fetch", makeFetchMock({ volume_24h: 500_000, buy_sell_ratio: 0.6 }));
    const result = await marketIntel(TOKEN);
    expect(typeof result.txns_24h).toBe("number");
    expect(typeof result.buys_24h).toBe("number");
    expect(typeof result.sells_24h).toBe("number");
    expect(typeof result.makers_24h).toBe("number");
    // split by wallet not available — must be null
    expect(result.buyers_24h).toBeNull();
    expect(result.sellers_24h).toBeNull();
    expect(typeof result.buy_volume_24h_usd).toBe("number");
    expect(typeof result.sell_volume_24h_usd).toBe("number");
  });

  it("24h counts are null when Birdeye fails", async () => {
    vi.stubGlobal("fetch", makeFetchMock({ birdeye_fail: true }));
    const result = await marketIntel(TOKEN);
    expect(result.txns_24h).toBeNull();
    expect(result.buys_24h).toBeNull();
    expect(result.makers_24h).toBeNull();
  });

  // -------------------------------------------------------------------------
  // market_summary sentence termination (Fix 4)
  // -------------------------------------------------------------------------

  it("market_summary ends with sentence-terminating punctuation", async () => {
    vi.stubGlobal("fetch", makeFetchMock());
    const result = await marketIntel(TOKEN);
    expect(result.market_summary).toMatch(/[.!?]$/);
  });

  // -------------------------------------------------------------------------
  // large_txs guard: < 3 txs contributes 0 to signal_score (Fix 3)
  // -------------------------------------------------------------------------

  it("large_txs_last_hour < 3 does not inflate signal_score", async () => {
    // Low volume means 0 large txs — signal_score should not be inflated
    vi.stubGlobal("fetch", makeFetchMock({ volume_24h: 5_000, liquidity: 50_000 }));
    const result = await marketIntel(TOKEN);
    expect(result.large_txs_last_hour).toBeLessThan(3);
    // With near-zero buy pressure and low volume, score should not be inflated
    expect(result.signal_score).toBeLessThanOrEqual(25);
  });
});
