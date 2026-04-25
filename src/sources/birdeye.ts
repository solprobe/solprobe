import { isAvailable, recordSuccess, recordFailure } from "../circuitBreaker.js";
import { recordSourceResult } from "./resolver.js";

const BASE_URL            = "https://public-api.birdeye.so/defi/token_overview";
const OHLCV_URL           = "https://public-api.birdeye.so/defi/ohlcv";
const CREATION_INFO_URL   = "https://public-api.birdeye.so/defi/token_creation_info";
const TOKEN_SECURITY_URL  = "https://public-api.birdeye.so/defi/token_security";
const TOKEN_TXS_URL       = "https://public-api.birdeye.so/defi/txs/token";

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
  price_change_5m_pct: number | null;
  price_change_30m_pct: number | null;
  price_change_8h_pct: number | null;
  last_trade_unix_time: number | null;
  symbol: string | null;
  name: string | null;
  logo_uri: string | null;
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
  // Last trade timestamp (Unix seconds); verified via live curl: "lastTradeUnixTime": 1776515977
  last_trade_unix_time: number | null;      // lastTradeUnixTime

  // Token identity — verified via live curl against BONK: symbol="Bonk", name="Bonk", logoURI=...
  symbol: string | null;                    // symbol
  name: string | null;                      // name
  logo_uri: string | null;                  // logoURI
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
  lastTradeUnixTime?: number | null;
  symbol?: string | null;
  name?: string | null;
  logoURI?: string | null;
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
    last_trade_unix_time: d.lastTradeUnixTime ?? null,

    symbol: d.symbol ?? null,
    name: d.name ?? null,
    logo_uri: d.logoURI ?? null,
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
    price_change_5m_pct: overview.price_change_5m_pct,
    price_change_30m_pct: overview.price_change_30m_pct,
    price_change_8h_pct: overview.price_change_8h_pct,
    last_trade_unix_time: overview.last_trade_unix_time,
    symbol: overview.symbol,
    name: overview.name,
    logo_uri: overview.logo_uri,
  };
}

// ---------------------------------------------------------------------------
// Lightweight token metadata — identity fields only (symbol, name, logoURI).
// Used by quickScan which doesn't otherwise fetch token_overview.
// ---------------------------------------------------------------------------

export interface BirdeyeTokenMetadata {
  symbol: string | null;
  name: string | null;
  logo_uri: string | null;
}

export async function getBirdeyeTokenMetadata(
  address: string,
  options: { timeout?: number } = {}
): Promise<BirdeyeTokenMetadata | null> {
  const overview = await getBirdeyeTokenOverview(address, { timeout: options.timeout ?? 2000 });
  if (!overview) return null;
  return { symbol: overview.symbol, name: overview.name, logo_uri: overview.logo_uri };
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
  /** Creator's share of total supply, 0–100. Null when not available. */
  creator_percentage: number | null;
  /** Top-10 holder share (0–100), excluding DEX pools per Birdeye's own filtering. */
  top_10_holder_percent: number | null;
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
      creatorPercentage?: number | null;     // 0.0–1.0 scale
      top10HolderPercent?: number | null;    // 0.0–1.0 scale (Birdeye DEX-filtered)
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
    // Fields are 0.0–1.0 scale — multiply ×100 for percent
    creator_percentage: typeof d.creatorPercentage === "number" ? Math.round(d.creatorPercentage * 100 * 100) / 100 : null,
    top_10_holder_percent: typeof d.top10HolderPercent === "number" ? Math.round(d.top10HolderPercent * 100 * 100) / 100 : null,
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
// Top holders with token_account field — for deepDive adjusted concentration
// Fields verified via live curl on 2026-04-12:
//   .data.items[n].owner = "..." (wallet/program address)
//   .data.items[n].token_account = "..." (ATA address)
//   .data.items[n].ui_amount = number (human-readable balance)
//   NOTE: percentage field is null — must compute from total_supply
// ---------------------------------------------------------------------------

export interface BirdeyeTopHolder {
  owner: string;
  token_account: string;
  ui_amount: number;
}

export async function getBirdeyeTopHolders(
  address: string,
  limit = 20,
  options: { timeout?: number } = {}
): Promise<BirdeyeTopHolder[] | null> {
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
    data?: { items?: Array<{ owner?: string; token_account?: string; ui_amount?: number }> };
  };

  if (!json.success || !json.data?.items) {
    recordSourceResult("birdeye", false, Date.now() - start);
    return null;
  }

  recordSourceResult("birdeye", true, Date.now() - start);
  return json.data.items
    .filter((item): item is { owner: string; token_account: string; ui_amount: number } =>
      typeof item.owner === "string" &&
      typeof item.token_account === "string" &&
      typeof item.ui_amount === "number"
    )
    .map((item) => ({ owner: item.owner, token_account: item.token_account, ui_amount: item.ui_amount }));
}

// ---------------------------------------------------------------------------
// Wallet PnL details — Birdeye POST /wallet/v2/pnl/details
// Fields verified via live curl on 2026-04-11:
//   .data.tokens[n].address
//   .data.tokens[n].symbol
//   .data.tokens[n].pnl.unrealized_usd
//   .data.tokens[n].pnl.unrealized_percent
//   .data.tokens[n].pnl.realized_profit_usd
//   .data.tokens[n].pnl.total_usd
//   .data.tokens[n].cashflow_usd.total_invested
//   .data.tokens[n].cashflow_usd.current_value
//   .data.tokens[n].quantity.holding
//   .data.summary.pnl.unrealized_usd  (same as summary endpoint)
// ---------------------------------------------------------------------------

export interface BirdeyeTokenPnL {
  address: string;
  symbol: string | null;
  unrealized_usd: number | null;
  unrealized_percent: number | null;
  realized_profit_usd: number | null;
  total_usd: number | null;
  total_invested_usd: number | null;
  current_value_usd: number | null;
  holding: number | null;
  last_trade_unix_time: number | null;
}

export interface BirdeyeWalletPnLDetails {
  tokens: BirdeyeTokenPnL[];
  total_unrealized_usd: number | null;
  total_realized_usd: number | null;
  total_pnl_usd: number | null;
  tokens_with_unrealized: number;
  source: "birdeye_pnl_details";
}

export async function getBirdeyeWalletPnLDetails(
  walletAddress: string,
  options: { timeout: number }
): Promise<BirdeyeWalletPnLDetails | null> {
  const apiKey = process.env.BIRDEYE_API_KEY;
  if (!apiKey) return null;
  if (!isAvailable("birdeye")) return null;

  const start = Date.now();
  const url = `https://public-api.birdeye.so/wallet/v2/pnl/details`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "X-API-KEY": apiKey, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ wallet: walletAddress }),
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
      tokens?: Array<{
        address?: string;
        symbol?: string;
        last_trade_unix_time?: number;
        pnl?: {
          unrealized_usd?: number;
          unrealized_percent?: number;
          realized_profit_usd?: number;
          total_usd?: number;
        };
        cashflow_usd?: {
          total_invested?: number;
          current_value?: number;
        };
        quantity?: { holding?: number };
      }>;
      summary?: {
        pnl?: {
          unrealized_usd?: number;
          realized_profit_usd?: number;
          total_usd?: number;
        };
      };
    };
  };

  const rawTokens = json?.data?.tokens ?? [];
  if (rawTokens.length === 0 && !json?.data?.summary) {
    recordSourceResult("birdeye", false, Date.now() - start);
    return null;
  }

  recordSourceResult("birdeye", true, Date.now() - start);
  recordSuccess("birdeye");

  const tokens: BirdeyeTokenPnL[] = rawTokens
    .filter((t): t is typeof t & { address: string } => typeof t.address === "string")
    .map((t) => ({
      address: t.address,
      symbol: t.symbol ?? null,
      unrealized_usd: t.pnl?.unrealized_usd ?? null,
      unrealized_percent: t.pnl?.unrealized_percent ?? null,
      realized_profit_usd: t.pnl?.realized_profit_usd ?? null,
      total_usd: t.pnl?.total_usd ?? null,
      total_invested_usd: t.cashflow_usd?.total_invested ?? null,
      current_value_usd: t.cashflow_usd?.current_value ?? null,
      holding: t.quantity?.holding ?? null,
      last_trade_unix_time: t.last_trade_unix_time ?? null,
    }));

  const summary = json?.data?.summary;
  return {
    tokens,
    total_unrealized_usd: summary?.pnl?.unrealized_usd ?? null,
    total_realized_usd: summary?.pnl?.realized_profit_usd ?? null,
    total_pnl_usd: summary?.pnl?.total_usd ?? null,
    tokens_with_unrealized: tokens.filter((t) => (t.unrealized_usd ?? 0) !== 0).length,
    source: "birdeye_pnl_details",
  };
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
// Wallet first funded — Birdeye POST /wallet/v2/tx/first-funded
// Fields verified via live curl on 2026-04-20:
//   .data["<wallet>"].block_unix_time  (unix timestamp of first SOL receipt)
//   .data["<wallet>"].tx_hash
// Returns unix timestamp or null on failure.
// ---------------------------------------------------------------------------

export async function getBirdeyeWalletFirstFunded(
  walletAddress: string,
  options: { timeout: number }
): Promise<number | null> {
  const apiKey = process.env.BIRDEYE_API_KEY;
  if (!apiKey) return null;
  if (!isAvailable("birdeye")) return null;

  const start = Date.now();
  const url = "https://public-api.birdeye.so/wallet/v2/tx/first-funded";

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "X-API-KEY": apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
        "x-chain": "solana",
      },
      body: JSON.stringify({ wallets: [walletAddress] }),
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
    success?: boolean;
    data?: Record<string, { block_unix_time?: number }>;
  };

  if (!json.success || !json.data) {
    recordSourceResult("birdeye", false, Date.now() - start);
    return null;
  }

  const entry = json.data[walletAddress];
  const blockTime = entry?.block_unix_time ?? null;

  recordSourceResult("birdeye", typeof blockTime === "number", Date.now() - start);
  if (typeof blockTime === "number") recordSuccess("birdeye");

  return typeof blockTime === "number" ? blockTime : null;
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

// ---------------------------------------------------------------------------
// Bundled launch detection via Birdeye early trades
// Endpoint: GET /defi/txs/token?sort_type=asc&tx_type=swap
// Fields verified via live curl on 2026-04-16:
//   .data.items[n].blockUnixTime = number  (confirmed field name)
//   .data.items[n].owner         = string  (wallet address — buyer)
//   .data.items[n].txHash        = string
//   NOTE: feePayer is null in the v1 endpoint — same-blockUnixTime clustering
//         on the owner field is the primary bundler signal.
// ---------------------------------------------------------------------------

export interface BundlerDetectionResult {
  bundled_launch_detected: boolean;
  bundler_count: number;
  bundler_fee_payers: string[];
  bundled_sol_spent: number;
  bundled_supply_pct: number | null;
  launch_window_txs_analysed: number;
  detection_method: "LAUNCH_WINDOW_FEE_PAYER" | "RUGCHECK_FALLBACK" | "UNKNOWN";
  confidence: "HIGH" | "MEDIUM" | "LOW";
  meaning: string;
  action_guidance: string;
}

export const BUNDLER_NULL_RESULT: BundlerDetectionResult = {
  bundled_launch_detected: false,
  bundler_count: 0,
  bundler_fee_payers: [],
  bundled_sol_spent: 0,
  bundled_supply_pct: null,
  launch_window_txs_analysed: 0,
  detection_method: "UNKNOWN",
  confidence: "LOW",
  meaning: "Launch window transactions could not be retrieved. Bundler detection was not completed.",
  action_guidance: "Cannot assess bundler risk from available data.",
};

/**
 * Detect bundled launches by clustering wallets that bought in the same block
 * during the launch window.
 *
 * Primary signal: ≥3 distinct `owner` wallets sharing an identical `blockUnixTime`
 *   within 300 s of the earliest recorded trade. Since feePayer is null in the
 *   Birdeye v1 response, same-block buyer clustering is the strongest available signal.
 *
 * Confidence ceiling: "MEDIUM" because we lack fee-payer data.
 * The `bundler_fee_payers` field is populated with the actual buyer wallet addresses
 * that participated in coordinated same-block buying during the launch window.
 *
 * @param mintAddress  Token mint address
 * @param tokenCreationTime  Unix timestamp from Birdeye token_creation_info; pass 0
 *                           to use the earliest trade's timestamp as the window anchor.
 */
export async function detectBundledLaunchViaBirdeye(
  mintAddress: string,
  tokenCreationTime: number,
  options: { timeout: number }
): Promise<BundlerDetectionResult> {
  if (!isAvailable("birdeye")) return BUNDLER_NULL_RESULT;

  const url = `${TOKEN_TXS_URL}?address=${encodeURIComponent(mintAddress)}&limit=50&tx_type=swap&sort_type=asc`;
  const start = Date.now();
  const headers = buildHeaders();

  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(options.timeout), headers });
  } catch {
    recordSourceResult("birdeye", false, Date.now() - start);
    return BUNDLER_NULL_RESULT;
  }

  if (!res.ok) {
    recordSourceResult("birdeye", false, Date.now() - start);
    return BUNDLER_NULL_RESULT;
  }

  const json = await res.json() as {
    success?: boolean;
    data?: { items?: Array<{ blockUnixTime?: number; owner?: string; txHash?: string }> };
  };

  if (!json.success || !json.data?.items) {
    recordSourceResult("birdeye", false, Date.now() - start);
    return BUNDLER_NULL_RESULT;
  }

  recordSourceResult("birdeye", true, Date.now() - start);

  const allTrades = json.data.items.filter(
    (item): item is { blockUnixTime: number; owner: string; txHash?: string } =>
      typeof item.blockUnixTime === "number" && typeof item.owner === "string" && item.owner.length > 0
  );

  if (allTrades.length === 0) {
    return { ...BUNDLER_NULL_RESULT, detection_method: "LAUNCH_WINDOW_FEE_PAYER" };
  }

  // Window anchor: prefer tokenCreationTime; fall back to earliest trade timestamp.
  const windowStart = tokenCreationTime > 0 ? tokenCreationTime : allTrades[0].blockUnixTime;

  // Narrow window first (60 s), expand to 300 s if too few trades.
  let windowTxs = allTrades.filter(t => t.blockUnixTime >= windowStart && t.blockUnixTime <= windowStart + 60);
  if (windowTxs.length < 3) {
    windowTxs = allTrades.filter(t => t.blockUnixTime >= windowStart && t.blockUnixTime <= windowStart + 300);
  }

  if (windowTxs.length === 0) {
    return {
      ...BUNDLER_NULL_RESULT,
      launch_window_txs_analysed: 0,
      detection_method: "LAUNCH_WINDOW_FEE_PAYER",
    };
  }

  // Primary signal: ≥3 distinct buyer wallets in the exact same block.
  // feePayer is null per verified Birdeye v1 response — use owner as the clustering key.
  const blockMap = new Map<number, Set<string>>();
  for (const tx of windowTxs) {
    if (!blockMap.has(tx.blockUnixTime)) blockMap.set(tx.blockUnixTime, new Set());
    blockMap.get(tx.blockUnixTime)!.add(tx.owner);
  }

  const CLUSTER_THRESHOLD = 3;
  const coordBlocks: number[] = [];
  let totalBundledWallets = new Set<string>();

  for (const [block, owners] of blockMap.entries()) {
    if (owners.size >= CLUSTER_THRESHOLD) {
      coordBlocks.push(block);
      owners.forEach(o => totalBundledWallets.add(o));
    }
  }

  const detected = coordBlocks.length > 0;

  // bundler_fee_payers: actual buyer wallet addresses discovered during clustering.
  // feePayer is unavailable in Birdeye v1 — these are the coordinated buyer wallets.
  const bundlerFeePayers = Array.from(totalBundledWallets);

  // Confidence ceiling: MEDIUM because feePayer is absent.
  // Elevate to HIGH only if two or more blocks show coordinated buying.
  const confidence: "HIGH" | "MEDIUM" | "LOW" = detected
    ? coordBlocks.length >= 2 ? "HIGH" : "MEDIUM"
    : "LOW";

  const meaning = detected
    ? `${totalBundledWallets.size} distinct wallet${totalBundledWallets.size !== 1 ? "s" : ""} bought this token ` +
      `in the same block during the launch window — consistent with pre-planned coordinated accumulation.`
    : `No same-block buyer clustering detected in the launch window. Launch appears organic based on available data.`;

  const action_guidance = detected
    ? `Coordinated wallets may distribute supply over time, creating sustained sell pressure. ` +
      `Monitor for coordinated sell-offs. Current holder distribution may not reflect launch-time insider accumulation.`
    : `No bundler pattern detected. Launch appears organic based on available data.`;

  return {
    bundled_launch_detected: detected,
    bundler_count: totalBundledWallets.size,
    bundler_fee_payers: bundlerFeePayers,
    bundled_sol_spent: 0,  // not available from Birdeye v1 swap data
    bundled_supply_pct: null,
    launch_window_txs_analysed: windowTxs.length,
    detection_method: "LAUNCH_WINDOW_FEE_PAYER",
    confidence,
    meaning,
    action_guidance,
  };
}

// ---------------------------------------------------------------------------
// Wallet transaction list — vesting inflow / dump outflow detection
// Endpoint: GET /v1/wallet/tx_list
// Fields verified via live curl on 2026-04-25:
//   .data.solana[n].mainAction            = string  (e.g. "TRANSFER")
//   .data.solana[n].txHash                = string
//   .data.solana[n].blockUnixTime         = number
//   .data.solana[n].tokenTransfers[m].mint             = string
//   .data.solana[n].tokenTransfers[m].tokenAmount      = number
//   .data.solana[n].tokenTransfers[m].fromUserAccount  = string
//   .data.solana[n].tokenTransfers[m].toUserAccount    = string
// ---------------------------------------------------------------------------

export interface BirdeyeWalletTx {
  tx_hash: string | null;
  block_unix_time: number | null;
  main_action: string | null;
  token_transfers: Array<{
    mint: string;
    token_amount: number;
    from_user_account: string;
    to_user_account: string;
  }>;
}

/**
 * Fetch recent transactions for a wallet address.
 * Returns null on API unavailability or error.
 * Filters to `tx_type=all` to capture TRANSFER events (vesting inflows/outflows).
 */
export async function getBirdeyeWalletTxList(
  walletAddress: string,
  options: { timeout?: number; limit?: number } = {}
): Promise<BirdeyeWalletTx[] | null> {
  const apiKey = process.env.BIRDEYE_API_KEY;
  if (!apiKey) return null;
  if (!isAvailable("birdeye")) return null;

  const timeout = options.timeout ?? 4000;
  const limit = options.limit ?? 100;
  const start = Date.now();

  const url = `https://public-api.birdeye.so/v1/wallet/tx_list` +
    `?wallet=${encodeURIComponent(walletAddress)}&limit=${limit}&tx_type=all`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        "X-API-KEY": apiKey,
        Accept: "application/json",
        "x-chain": "solana",
      },
      signal: AbortSignal.timeout(timeout),
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
    success?: boolean;
    data?: {
      solana?: Array<{
        txHash?: string;
        blockUnixTime?: number;
        mainAction?: string;
        tokenTransfers?: Array<{
          mint?: string;
          tokenAmount?: number;
          fromUserAccount?: string;
          toUserAccount?: string;
        }>;
      }>;
    };
  };

  if (!json.success || !json.data?.solana) {
    recordSourceResult("birdeye", false, Date.now() - start);
    return null;
  }

  recordSourceResult("birdeye", true, Date.now() - start);
  recordSuccess("birdeye");

  return json.data.solana.map((tx) => ({
    tx_hash: tx.txHash ?? null,
    block_unix_time: tx.blockUnixTime ?? null,
    main_action: tx.mainAction ?? null,
    token_transfers: (tx.tokenTransfers ?? [])
      .filter((t): t is { mint: string; tokenAmount: number; fromUserAccount: string; toUserAccount: string } =>
        typeof t.mint === "string" &&
        typeof t.tokenAmount === "number" &&
        typeof t.fromUserAccount === "string" &&
        typeof t.toUserAccount === "string"
      )
      .map((t) => ({
        mint: t.mint,
        token_amount: t.tokenAmount,
        from_user_account: t.fromUserAccount,
        to_user_account: t.toUserAccount,
      })),
  }));
}
