import { isAvailable, recordSuccess, recordFailure } from "../circuitBreaker.js";
import { recordSourceResult } from "./resolver.js";

const BASE_URL            = "https://public-api.birdeye.so/defi/token_overview";
const OHLCV_URL           = "https://public-api.birdeye.so/defi/ohlcv";
const CREATION_INFO_URL   = "https://public-api.birdeye.so/defi/token_creation_info";
const TOKEN_SECURITY_URL  = "https://public-api.birdeye.so/defi/token_security";

// ---------------------------------------------------------------------------
// OHLCV candle — defined here (sources layer) so marketIntel.ts can import it
// without creating a reverse scanner→sources dependency.
// ---------------------------------------------------------------------------

export interface OHLCVCandle {
  unix_time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Raw token volume × close price (USD). */
  volume_usd: number;
}

// ---------------------------------------------------------------------------
// Legacy interface (used by deepDive.ts)
// ---------------------------------------------------------------------------

export interface BirdeyeTokenData {
  price_usd: number | null;
  liquidity_usd: number | null;
  volume_1h_usd: number | null;
  volume_24h_usd: number | null;
  price_change_1h_pct: number | null;
  price_change_24h_pct: number | null;
}

// ---------------------------------------------------------------------------
// Full token_overview interface — aggregated across ALL pools
// Field names verified via live curl against BONK on 2026-04-04.
// ---------------------------------------------------------------------------

export interface BirdeyeTokenOverview {
  // Core price/liquidity (aggregated across all pools)
  price_usd: number | null;
  liquidity_usd: number | null;
  market_cap_usd: number | null;

  // Price changes
  price_change_5m_pct: number | null;       // priceChange5mPercent
  price_change_30m_pct: number | null;      // priceChange30mPercent (no 15m available)
  price_change_1h_pct: number | null;       // priceChange1hPercent
  price_change_8h_pct: number | null;       // priceChange8hPercent (no 6h available)
  price_change_24h_pct: number | null;      // priceChange24hPercent

  // Volume (USD) per window — uses vXXUSD fields (not vXX which is in token units)
  volume_5m_usd: number | null;             // v5mUSD
  volume_30m_usd: number | null;            // v30mUSD (no 15m available)
  volume_1h_usd: number | null;             // v1hUSD
  volume_8h_usd: number | null;             // v8hUSD (no 6h available)
  volume_24h_usd: number | null;            // v24hUSD

  // Transaction counts per window
  trade_5m: number | null;                  // trade5m
  trade_30m: number | null;                 // trade30m
  trade_1h: number | null;                  // trade1h
  trade_8h: number | null;                  // trade8h
  trade_24h: number | null;                 // trade24h

  // Buy/sell breakdown per window
  buy_5m: number | null;                    // buy5m
  sell_5m: number | null;                   // sell5m
  buy_30m: number | null;                   // buy30m
  sell_30m: number | null;                  // sell30m
  buy_1h: number | null;                    // buy1h
  sell_1h: number | null;                   // sell1h
  buy_8h: number | null;                    // buy8h
  sell_8h: number | null;                   // sell8h
  buy_24h: number | null;                   // buy24h
  sell_24h: number | null;                  // sell24h

  // Volume split (USD) per window
  buy_volume_5m_usd: number | null;         // vBuy5mUSD
  sell_volume_5m_usd: number | null;        // vSell5mUSD
  buy_volume_30m_usd: number | null;        // vBuy30mUSD
  sell_volume_30m_usd: number | null;       // vSell30mUSD
  buy_volume_1h_usd: number | null;         // vBuy1hUSD
  sell_volume_1h_usd: number | null;        // vSell1hUSD
  buy_volume_8h_usd: number | null;         // vBuy8hUSD
  sell_volume_8h_usd: number | null;        // vSell8hUSD
  buy_volume_24h_usd: number | null;        // vBuy24hUSD
  sell_volume_24h_usd: number | null;       // vSell24hUSD

  // Unique wallets (combined, not split into buy/sell)
  unique_wallet_5m: number | null;          // uniqueWallet5m
  unique_wallet_30m: number | null;         // uniqueWallet30m
  unique_wallet_1h: number | null;          // uniqueWallet1h
  unique_wallet_8h: number | null;          // uniqueWallet8h
  unique_wallet_24h: number | null;         // uniqueWallet24h

  // On-chain holder count
  // Verified via live curl against BONK on 2026-04-05: .data.holder = 998381
  holder: number | null;                    // holder

  // First trade timestamp (Unix seconds); null for BONK (field absent on established tokens)
  first_trade_unix_time: number | null;     // firstTradeUnixTime
}

// Raw response shape from Birdeye token_overview endpoint
interface RawBirdeyeOverview {
  price?: number | null;
  liquidity?: number | null;
  marketCap?: number | null;

  priceChange5mPercent?: number | null;
  priceChange30mPercent?: number | null;
  priceChange1hPercent?: number | null;
  priceChange8hPercent?: number | null;
  priceChange24hPercent?: number | null;

  v5mUSD?: number | null;
  v30mUSD?: number | null;
  v1hUSD?: number | null;
  v8hUSD?: number | null;
  v24hUSD?: number | null;

  trade5m?: number | null;
  trade30m?: number | null;
  trade1h?: number | null;
  trade8h?: number | null;
  trade24h?: number | null;

  buy5m?: number | null;   sell5m?: number | null;
  buy30m?: number | null;  sell30m?: number | null;
  buy1h?: number | null;   sell1h?: number | null;
  buy8h?: number | null;   sell8h?: number | null;
  buy24h?: number | null;  sell24h?: number | null;

  vBuy5mUSD?: number | null;   vSell5mUSD?: number | null;
  vBuy30mUSD?: number | null;  vSell30mUSD?: number | null;
  vBuy1hUSD?: number | null;   vSell1hUSD?: number | null;
  vBuy8hUSD?: number | null;   vSell8hUSD?: number | null;
  vBuy24hUSD?: number | null;  vSell24hUSD?: number | null;

  uniqueWallet5m?: number | null;
  uniqueWallet30m?: number | null;
  uniqueWallet1h?: number | null;
  uniqueWallet8h?: number | null;
  uniqueWallet24h?: number | null;

  holder?: number | null;
  firstTradeUnixTime?: number | null;
}

interface RawBirdeyeResponse {
  success?: boolean;
  data?: RawBirdeyeOverview;
}

// ---------------------------------------------------------------------------
// Shared fetch helper
// ---------------------------------------------------------------------------

function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "x-chain": "solana",
  };
  if (process.env.BIRDEYE_API_KEY) {
    headers["X-API-KEY"] = process.env.BIRDEYE_API_KEY;
  }
  return headers;
}

// ---------------------------------------------------------------------------
// Full token_overview fetch — PRIMARY source for market intel
// ---------------------------------------------------------------------------

export async function getBirdeyeTokenOverview(
  address: string,
  options: { timeout?: number } = {}
): Promise<BirdeyeTokenOverview | null> {
  if (!isAvailable("birdeye")) return null;

  const timeout = options.timeout ?? 4000;
  const url = `${BASE_URL}?address=${encodeURIComponent(address)}`;
  const start = Date.now();
  const headers = buildHeaders();

  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeout), headers });
  } catch (err) {
    recordSourceResult("birdeye", false, Date.now() - start);
    recordFailure("birdeye");
    throw err;
  }

  if (res.status === 400 || res.status === 404) return null;

  if (!res.ok) {
    recordSourceResult("birdeye", false, Date.now() - start);
    recordFailure("birdeye");
    const err = new Error(`Birdeye HTTP ${res.status}`) as any;
    err.status = res.status;
    throw err;
  }

  const json = (await res.json()) as RawBirdeyeResponse;

  if (!json.success || !json.data) {
    recordSourceResult("birdeye", false, Date.now() - start);
    recordFailure("birdeye");
    throw new Error("Birdeye returned success=false");
  }

  recordSourceResult("birdeye", true, Date.now() - start);
  recordSuccess("birdeye");
  const d = json.data;

  return {
    price_usd: d.price ?? null,
    liquidity_usd: d.liquidity ?? null,
    market_cap_usd: d.marketCap ?? null,

    price_change_5m_pct: d.priceChange5mPercent ?? null,
    price_change_30m_pct: d.priceChange30mPercent ?? null,
    price_change_1h_pct: d.priceChange1hPercent ?? null,
    price_change_8h_pct: d.priceChange8hPercent ?? null,
    price_change_24h_pct: d.priceChange24hPercent ?? null,

    volume_5m_usd: d.v5mUSD ?? null,
    volume_30m_usd: d.v30mUSD ?? null,
    volume_1h_usd: d.v1hUSD ?? null,
    volume_8h_usd: d.v8hUSD ?? null,
    volume_24h_usd: d.v24hUSD ?? null,

    trade_5m: d.trade5m ?? null,
    trade_30m: d.trade30m ?? null,
    trade_1h: d.trade1h ?? null,
    trade_8h: d.trade8h ?? null,
    trade_24h: d.trade24h ?? null,

    buy_5m: d.buy5m ?? null,     sell_5m: d.sell5m ?? null,
    buy_30m: d.buy30m ?? null,   sell_30m: d.sell30m ?? null,
    buy_1h: d.buy1h ?? null,     sell_1h: d.sell1h ?? null,
    buy_8h: d.buy8h ?? null,     sell_8h: d.sell8h ?? null,
    buy_24h: d.buy24h ?? null,   sell_24h: d.sell24h ?? null,

    buy_volume_5m_usd: d.vBuy5mUSD ?? null,     sell_volume_5m_usd: d.vSell5mUSD ?? null,
    buy_volume_30m_usd: d.vBuy30mUSD ?? null,   sell_volume_30m_usd: d.vSell30mUSD ?? null,
    buy_volume_1h_usd: d.vBuy1hUSD ?? null,     sell_volume_1h_usd: d.vSell1hUSD ?? null,
    buy_volume_8h_usd: d.vBuy8hUSD ?? null,     sell_volume_8h_usd: d.vSell8hUSD ?? null,
    buy_volume_24h_usd: d.vBuy24hUSD ?? null,   sell_volume_24h_usd: d.vSell24hUSD ?? null,

    unique_wallet_5m: d.uniqueWallet5m ?? null,
    unique_wallet_30m: d.uniqueWallet30m ?? null,
    unique_wallet_1h: d.uniqueWallet1h ?? null,
    unique_wallet_8h: d.uniqueWallet8h ?? null,
    unique_wallet_24h: d.uniqueWallet24h ?? null,

    holder: d.holder ?? null,

    first_trade_unix_time: d.firstTradeUnixTime ?? null,
  };
}

// ---------------------------------------------------------------------------
// Token creation info — PRIMARY source for mint creation timestamp + slot
// Field names verified via live curl against BONK on 2026-04-05:
//   .data.blockUnixTime = 1670531612 (Unix seconds)
//   .data.slot          = 165714665
//   .data.creator       = "9AhKqLR67hwapvG8SA2JFXaCshXc9nALJjpKaHZrsbkw"
// ---------------------------------------------------------------------------

export interface BirdeyeTokenCreationInfo {
  block_unix_time: number;  // Unix seconds — token creation timestamp
  slot: number;             // Solana slot of the creation transaction
  creator: string;          // Creator wallet address
}

export async function getTokenCreationInfo(
  address: string,
  options: { timeout?: number } = {}
): Promise<BirdeyeTokenCreationInfo | null> {
  if (!isAvailable("birdeye")) return null;

  const timeout = options.timeout ?? 3000;
  const url = `${CREATION_INFO_URL}?address=${encodeURIComponent(address)}`;
  const start = Date.now();
  const headers = buildHeaders();

  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeout), headers });
  } catch {
    recordSourceResult("birdeye", false, Date.now() - start);
    return null;
  }

  if (!res.ok) {
    recordSourceResult("birdeye", false, Date.now() - start);
    return null;
  }

  const json = await res.json() as {
    success?: boolean;
    data?: { blockUnixTime?: number; slot?: number; creator?: string };
  };

  if (!json.success || !json.data) {
    recordSourceResult("birdeye", false, Date.now() - start);
    return null;
  }

  const { blockUnixTime, slot, creator } = json.data;
  if (typeof blockUnixTime !== "number" || typeof slot !== "number") {
    recordSourceResult("birdeye", false, Date.now() - start);
    return null;
  }

  recordSourceResult("birdeye", true, Date.now() - start);
  return { block_unix_time: blockUnixTime, slot, creator: creator ?? "" };
}

// ---------------------------------------------------------------------------
// Legacy token_overview fetch — used by deepDive.ts
// Maps to the same endpoint but returns the slim BirdeyeTokenData interface.
// ---------------------------------------------------------------------------

export async function getBirdeyeToken(
  address: string,
  options: { timeout?: number } = {}
): Promise<BirdeyeTokenData | null> {
  const overview = await getBirdeyeTokenOverview(address, options);
  if (!overview) return null;
  return {
    price_usd: overview.price_usd,
    liquidity_usd: overview.liquidity_usd,
    volume_1h_usd: overview.volume_1h_usd,
    volume_24h_usd: overview.volume_24h_usd,
    price_change_1h_pct: overview.price_change_1h_pct,
    price_change_24h_pct: overview.price_change_24h_pct,
  };
}

/**
 * Fetch OHLCV candles for a token at a given interval.
 * Candle fields verified via live curl on 2026-04-04:
 *   .data.items[n] = { o, h, l, c, v (token units), unixTime }
 * volume_usd per candle = v × c (close price).
 */
export async function getBirdeyeOHLCV(
  address: string,
  interval: "15m" | "1H",
  timeFrom: number,
  timeTo: number,
  options: { timeout?: number } = {}
): Promise<OHLCVCandle[] | null> {
  if (!isAvailable("birdeye")) return null;

  const timeout = options.timeout ?? 4000;
  const url = `${OHLCV_URL}?address=${encodeURIComponent(address)}&type=${interval}&time_from=${timeFrom}&time_to=${timeTo}&chain=solana`;
  const start = Date.now();
  const headers = buildHeaders();

  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeout), headers });
  } catch {
    recordSourceResult("birdeye", false, Date.now() - start);
    return null;
  }

  if (!res.ok) {
    recordSourceResult("birdeye", false, Date.now() - start);
    return null;
  }

  const data = await res.json() as { data?: { items?: Array<{ o?: number; h?: number; l?: number; c?: number; v?: number; unixTime?: number }> } };
  const items = data?.data?.items ?? [];

  recordSourceResult("birdeye", true, Date.now() - start);

  return items.map((item) => ({
    unix_time: item.unixTime ?? 0,
    open:  item.o ?? 0,
    high:  item.h ?? 0,
    low:   item.l ?? 0,
    close: item.c ?? 0,
    volume_usd: (item.v ?? 0) * (item.c ?? 0),
  }));
}

// ---------------------------------------------------------------------------
// Token security — metadata immutability + supply info
// Fields verified via live curl on 2026-04-05:
//   .data.mutableMetadata = true|false (boolean)
//   .data.metaplexUpdateAuthority = "..." (wallet address)
//   .data.creatorAddress = "..." (wallet address)
//   .data.totalSupply = number
// ---------------------------------------------------------------------------

export interface BirdeyeTokenSecurity {
  mutable_metadata: boolean | null;
  metaplex_update_authority: string | null;
  creator_address: string | null;
  total_supply: number | null;
}

export async function getBirdeyeTokenSecurity(
  address: string,
  options: { timeout?: number } = {}
): Promise<BirdeyeTokenSecurity | null> {
  if (!isAvailable("birdeye")) return null;

  const timeout = options.timeout ?? 3000;
  const url = `${TOKEN_SECURITY_URL}?address=${encodeURIComponent(address)}`;
  const start = Date.now();
  const headers = buildHeaders();

  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeout), headers });
  } catch {
    recordSourceResult("birdeye", false, Date.now() - start);
    return null;
  }

  if (!res.ok) {
    recordSourceResult("birdeye", false, Date.now() - start);
    return null;
  }

  const json = await res.json() as {
    success?: boolean;
    data?: {
      mutableMetadata?: boolean | null;
      metaplexUpdateAuthority?: string | null;
      creatorAddress?: string | null;
      totalSupply?: number | null;
    };
  };

  if (!json.success || !json.data) {
    recordSourceResult("birdeye", false, Date.now() - start);
    return null;
  }

  recordSourceResult("birdeye", true, Date.now() - start);
  const d = json.data;
  return {
    mutable_metadata: typeof d.mutableMetadata === "boolean" ? d.mutableMetadata : null,
    metaplex_update_authority: d.metaplexUpdateAuthority ?? null,
    creator_address: d.creatorAddress ?? null,
    total_supply: typeof d.totalSupply === "number" ? d.totalSupply : null,
  };
}

// ---------------------------------------------------------------------------
// Holder list — top N holders by balance
// Fields verified via live curl on 2026-04-05:
//   .data.items[n].owner = "..." (wallet address)
//   .data.items[n].ui_amount = number (human-readable balance)
// ---------------------------------------------------------------------------

export interface BirdeyeHolder {
  owner: string;
  ui_amount: number;
}

export async function getBirdeyeHolderList(
  address: string,
  limit = 20,
  options: { timeout?: number } = {}
): Promise<BirdeyeHolder[] | null> {
  if (!isAvailable("birdeye")) return null;

  const timeout = options.timeout ?? 3000;
  const url = `https://public-api.birdeye.so/defi/v3/token/holder?address=${encodeURIComponent(address)}&limit=${limit}`;
  const start = Date.now();
  const headers = buildHeaders();

  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeout), headers });
  } catch {
    recordSourceResult("birdeye", false, Date.now() - start);
    return null;
  }

  if (!res.ok) {
    recordSourceResult("birdeye", false, Date.now() - start);
    return null;
  }

  const json = await res.json() as {
    success?: boolean;
    data?: { items?: Array<{ owner?: string; ui_amount?: number }> };
  };

  if (!json.success || !json.data?.items) {
    recordSourceResult("birdeye", false, Date.now() - start);
    return null;
  }

  recordSourceResult("birdeye", true, Date.now() - start);
  return json.data.items
    .filter((item): item is { owner: string; ui_amount: number } =>
      typeof item.owner === "string" && typeof item.ui_amount === "number"
    )
    .map((item) => ({ owner: item.owner, ui_amount: item.ui_amount }));
}

// ---------------------------------------------------------------------------
// Wallet PnL summary — Birdeye /wallet/v2/pnl/summary
// Fields verified via live curl on 2026-04-08:
//   .data.summary.pnl.realized_profit_usd
//   .data.summary.pnl.unrealized_usd
//   .data.summary.pnl.total_usd
//   .data.summary.counts.win_rate  (0.0–1.0)
//   .data.summary.counts.total_trade
//   .data.summary.counts.total_win
//   .data.summary.counts.total_loss
//   .data.summary.unique_tokens
// ---------------------------------------------------------------------------

export interface BirdeyeWalletPnLSummary {
  total_realized_pnl_usd: number | null;
  total_unrealized_pnl_usd: number | null;
  total_pnl_usd: number | null;
  win_rate_pct: number | null;    // 0–100
  total_trades: number | null;
  winning_trades: number | null;
  losing_trades: number | null;
  tokens_traded: number | null;
  source: "birdeye_pnl_api";
}

export async function getBirdeyeWalletPnL(
  walletAddress: string,
  options: { timeout: number }
): Promise<BirdeyeWalletPnLSummary | null> {
  const apiKey = process.env.BIRDEYE_API_KEY;
  if (!apiKey) return null;
  if (!isAvailable("birdeye")) return null;

  const start = Date.now();
  const url = `https://public-api.birdeye.so/wallet/v2/pnl/summary` +
    `?wallet=${encodeURIComponent(walletAddress)}&chain=solana`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "X-API-KEY": apiKey, Accept: "application/json" },
      signal: AbortSignal.timeout(options.timeout),
    });
  } catch {
    recordSourceResult("birdeye", false, Date.now() - start);
    recordFailure("birdeye");
    return null;
  }

  if (!res.ok) {
    recordSourceResult("birdeye", false, Date.now() - start);
    recordFailure("birdeye");
    return null;
  }

  const json = await res.json() as {
    data?: {
      summary?: {
        unique_tokens?: number;
        counts?: {
          total_trade?: number;
          total_win?: number;
          total_loss?: number;
          win_rate?: number;
        };
        pnl?: {
          realized_profit_usd?: number;
          unrealized_usd?: number;
          total_usd?: number;
        };
      };
    };
  };

  const summary = json?.data?.summary;
  if (!summary) {
    recordSourceResult("birdeye", false, Date.now() - start);
    return null;
  }

  recordSourceResult("birdeye", true, Date.now() - start);
  recordSuccess("birdeye");

  const winRateRaw = summary.counts?.win_rate ?? null;

  return {
    total_realized_pnl_usd: summary.pnl?.realized_profit_usd ?? null,
    total_unrealized_pnl_usd: summary.pnl?.unrealized_usd ?? null,
    total_pnl_usd: summary.pnl?.total_usd ?? null,
    win_rate_pct: typeof winRateRaw === "number" ? Math.round(winRateRaw * 10000) / 100 : null,
    total_trades: summary.counts?.total_trade ?? null,
    winning_trades: summary.counts?.total_win ?? null,
    losing_trades: summary.counts?.total_loss ?? null,
    tokens_traded: summary.unique_tokens ?? null,
    source: "birdeye_pnl_api",
  };
}

// ---------------------------------------------------------------------------
// Wallet portfolio — current token holdings with live prices
// Fields verified via live curl on 2026-04-08:
//   .data.items[n] = { address, symbol, uiAmount, priceUsd, valueUsd }
//   Note: no isSpam field in response — is_spam defaults to false
// ---------------------------------------------------------------------------

export interface BirdeyeWalletPortfolioItem {
  address: string;       // token mint address
  symbol: string | null;
  ui_amount: number;     // human-readable balance
  price_usd: number | null;
  value_usd: number | null;
  is_spam: boolean;
}

export async function getBirdeyeWalletPortfolio(
  walletAddress: string,
  options: { timeout?: number } = {}
): Promise<BirdeyeWalletPortfolioItem[] | null> {
  if (!process.env.BIRDEYE_API_KEY) return null;
  if (!isAvailable("birdeye")) return null;

  const timeout = options.timeout ?? 4000;
  const url = `https://public-api.birdeye.so/v1/wallet/token_list?wallet=${encodeURIComponent(walletAddress)}`;
  const start = Date.now();
  const headers = buildHeaders();

  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeout), headers });
  } catch {
    recordSourceResult("birdeye", false, Date.now() - start);
    return null;
  }

  if (!res.ok) {
    recordSourceResult("birdeye", false, Date.now() - start);
    return null;
  }

  const json = await res.json() as {
    success?: boolean;
    data?: { items?: Array<{ address?: string; symbol?: string; uiAmount?: number; priceUsd?: number; valueUsd?: number }> };
  };

  if (!json.success || !json.data?.items) {
    recordSourceResult("birdeye", false, Date.now() - start);
    return null;
  }

  recordSourceResult("birdeye", true, Date.now() - start);
  return json.data.items
    .filter((item): item is { address: string; symbol?: string; uiAmount?: number; priceUsd?: number; valueUsd?: number } =>
      typeof item.address === "string"
    )
    .map((item) => ({
      address: item.address,
      symbol: item.symbol ?? null,
      ui_amount: item.uiAmount ?? 0,
      price_usd: typeof item.priceUsd === "number" ? item.priceUsd : null,
      value_usd: typeof item.valueUsd === "number" ? item.valueUsd : null,
      is_spam: false,  // Birdeye v1/wallet/token_list does not expose isSpam field
    }));
}

export async function getTokenOHLCV(
  address: string,
  options: { timeout: number }
): Promise<{ ath_price_usd: number; candles: number } | null> {
  if (!isAvailable("birdeye")) return null;

  const start = Date.now();
  const timeFrom = Math.floor(Date.now() / 1000) - 365 * 3 * 24 * 60 * 60; // 3 years
  const timeTo   = Math.floor(Date.now() / 1000);
  const url = `${OHLCV_URL}?address=${encodeURIComponent(address)}&type=1D&time_from=${timeFrom}&time_to=${timeTo}&chain=solana`;

  const headers = buildHeaders();

  let res: Response;
  try {
    res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(options.timeout),
    });
  } catch (err) {
    recordSourceResult("birdeye", false, Date.now() - start);
    recordFailure("birdeye");
    return null;
  }

  if (!res.ok) {
    recordSourceResult("birdeye", false, Date.now() - start);
    recordFailure("birdeye");
    return null;
  }

  const data = await res.json() as { data?: { items?: Array<{ h?: number }> } };
  const items = data?.data?.items ?? [];

  recordSourceResult("birdeye", true, Date.now() - start);
  recordSuccess("birdeye");

  if (!items.length) return null;

  const ath_price_usd = Math.max(...items.map((c) => c.h ?? 0));
  if (ath_price_usd <= 0) return null; // all candles have h=0 or missing
  return { ath_price_usd, candles: items.length };
}
