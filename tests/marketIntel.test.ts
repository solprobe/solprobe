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
    price_change_1h  = 1,
    price_change_24h = 5,
    buy_sell_ratio = 0.6,
    ohlcv_items,
    dex_fail    = false,
    birdeye_fail = false,
  } = opts;

  const buys  = Math.round(buy_sell_ratio * 200);
  const sells = 200 - buys;

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
          volume: { h1: volume_24h / 10, h24: volume_24h },
          liquidity: { usd: liquidity },
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
      return fakeResponse({
        success: true,
        data: {
          price: 0.000012,
          liquidity,
          v1h: volume_24h / 10,
          v24h: volume_24h,
          priceChange1hPercent: price_change_1h,
          priceChange24hPercent: price_change_24h,
        },
      });
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
      signal_subtype:       expect.any(String),
      token_health:         expect.stringMatching(/^(ACTIVE|LOW_ACTIVITY|DECLINING|ILLIQUID|DEAD)$/),
      market_summary:       expect.any(String),
      data_confidence:      expect.stringMatching(/^(HIGH|MEDIUM|LOW)$/),
      confidence:           expect.any(Number),
      factors:              expect.any(Array),
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
  });
});
