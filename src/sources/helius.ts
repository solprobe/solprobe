import { isAvailable, recordSuccess, recordFailure } from "../circuitBreaker.js";
import { recordSourceResult } from "./resolver.js";

export interface HeliusTokenData {
  mint_authority_revoked: boolean | null;
  freeze_authority_revoked: boolean | null;
  top_10_holder_pct: number | null;
  token_age_days: number | null; // null — derived from DexScreener pair creation instead
}

// ---------------------------------------------------------------------------
// RPC endpoint rotation
// ---------------------------------------------------------------------------

const RPC_ENDPOINTS = [
  process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com",
  "https://rpc.ankr.com/solana",
  "https://api.mainnet-beta.solana.com",
] as const;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function rpcPost<T>(
  endpoint: string,
  body: unknown,
  timeoutMs: number
): Promise<T> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const err = new Error(`RPC HTTP ${res.status}`) as any;
    err.status = res.status;
    err.headers = Object.fromEntries(res.headers.entries());
    throw err;
  }

  const json = await res.json();

  // Solana RPC returns HTTP 200 even for rate-limit errors — detect them in the body.
  if (Array.isArray(body)) {
    // Batch request: endpoint must return an array. Some providers (e.g. ankr) return a
    // single object instead — treat that as a failure so the retry loop tries the next endpoint.
    if (!Array.isArray(json)) {
      const err = new Error("RPC batch expected array response, got object") as any;
      err.status = 500;
      throw err;
    }
    // Throw if every item is an error so the retry loop fires.
    const allErrors = (json as any[]).every((r: any) => r.error != null);
    if (allErrors) {
      const first = (json as any[])[0]?.error;
      // JSON-RPC rate-limit codes: 429 or -32005
      const isRateLimit = first?.code === 429 || first?.code === -32005 ||
        String(first?.message ?? "").toLowerCase().includes("too many");
      const err = new Error(`RPC batch all-errors: ${first?.message}`) as any;
      err.status = isRateLimit ? 429 : 500;
      throw err;
    }
  }

  return json as T;
}

async function rpcWithRetry<T>(
  fn: (endpoint: string) => Promise<T>
): Promise<T | null> {
  const delays = [500, 1000, 2000];
  for (let i = 0; i < RPC_ENDPOINTS.length; i++) {
    try {
      return await fn(RPC_ENDPOINTS[i]);
    } catch (err: any) {
      // Don't retry bad-address errors
      if (err?.status === 400 || err?.status === 404) return null;

      const isRateLimit = err?.status === 429;
      const retryAfter = isRateLimit
        ? Math.min(parseInt(err?.headers?.["retry-after"] ?? "0") * 1000, 5000)
        : 0;
      const delay = retryAfter || (delays[i] ?? 2000);
      if (i < RPC_ENDPOINTS.length - 1) await sleep(delay);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Mint account parsing
// SPL Token mint layout (82 bytes):
//   0–3:   COption<Pubkey> for mint_authority  (0 = None/revoked, 1 = Some)
//   4–35:  mint_authority pubkey
//   36–43: supply (u64 LE)
//   44:    decimals
//   45:    is_initialized
//   46–49: COption<Pubkey> for freeze_authority (0 = None/revoked, 1 = Some)
//   50–81: freeze_authority pubkey
// ---------------------------------------------------------------------------

function parseMintAccount(base64Data: string): {
  mint_authority_revoked: boolean;
  freeze_authority_revoked: boolean;
} {
  const buf = Buffer.from(base64Data, "base64");
  if (buf.length < 82) throw new Error(`Unexpected mint account size: ${buf.length}`);

  const mintAuthorityOption = buf.readUInt32LE(0);
  const freezeAuthorityOption = buf.readUInt32LE(46);

  return {
    mint_authority_revoked: mintAuthorityOption === 0,
    freeze_authority_revoked: freezeAuthorityOption === 0,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch ONLY the mint and freeze authority flags for a token.
 *
 * This is the sole source of truth for these flags — Helius RPC is queried
 * unconditionally on every scan. RugCheck no longer owns these fields.
 *
 * Returns null on any error — never throws.
 * Retries across RPC endpoints via rpcWithRetry().
 *
 * SPL Token MintLayout (byte layout decoded manually — equivalent to
 * @solana/spl-token MintLayout.decode()):
 *   bytes 0–3:   COption discriminator for mintAuthority (0 = None/revoked)
 *   bytes 46–49: COption discriminator for freezeAuthority (0 = None/revoked)
 */
export async function getTokenMintInfo(
  address: string,
  options: { timeout?: number } = {}
): Promise<{ mint_authority_revoked: boolean; freeze_authority_revoked: boolean } | null> {
  if (!isAvailable("helius_rpc")) return null;

  const timeout = options.timeout ?? 3000;
  const start = Date.now();

  type SingleResponse = { id: number; result?: any; error?: { code: number; message: string } };

  const accountResult = await rpcWithRetry<SingleResponse>(
    (endpoint) => rpcPost<SingleResponse>(endpoint, {
      jsonrpc: "2.0",
      id: 1,
      method: "getAccountInfo",
      params: [address, { encoding: "base64" }],
    }, timeout)
  );

  if (!accountResult) {
    recordSourceResult("helius", false, Date.now() - start);
    recordFailure("helius_rpc");
    return null;
  }

  try {
    const accountData = accountResult?.result?.value?.data;
    if (!Array.isArray(accountData) || typeof accountData[0] !== "string") {
      recordSourceResult("helius", false, Date.now() - start);
      recordFailure("helius_rpc");
      return null;
    }

    const parsed = parseMintAccount(accountData[0]);
    recordSourceResult("helius", true, Date.now() - start);
    recordSuccess("helius_rpc");
    return parsed;
  } catch {
    recordSourceResult("helius", false, Date.now() - start);
    recordFailure("helius_rpc");
    return null;
  }
}

// Solana burn addresses — LP tokens sent here are permanently locked/burned
const BURN_ADDRESSES = new Set([
  "1nc1nerator11111111111111111111111111111111",
  "11111111111111111111111111111111",
]);

/**
 * Check whether the LP token for a pool has been burned.
 *
 * Calls getTokenLargestAccounts on the LP mint and checks whether any of the
 * top holders is a known burn address. Returns:
 *   true  — LP is burned (one or more accounts at a burn address)
 *   false — LP is NOT burned (no burn address found in top holders)
 *   null  — Unable to determine (RPC failure or LP mint unavailable)
 */
export async function checkLPBurned(
  lpMintAddress: string,
  options: { timeout?: number } = {}
): Promise<boolean | null> {
  if (!isAvailable("helius_rpc")) return null;

  const timeout = options.timeout ?? 3000;
  const start = Date.now();

  type SingleResponse = { id: number; result?: any; error?: any };

  const result = await rpcWithRetry<SingleResponse>(
    (endpoint) => rpcPost<SingleResponse>(endpoint, {
      jsonrpc: "2.0",
      id: 1,
      method: "getTokenLargestAccounts",
      params: [lpMintAddress],
    }, timeout)
  );

  if (!result) {
    recordSourceResult("helius", false, Date.now() - start);
    return null;
  }

  try {
    const accounts: Array<{ address: string; amount: string }> = result?.result?.value ?? [];
    if (!Array.isArray(accounts) || accounts.length === 0) return null;

    recordSourceResult("helius", true, Date.now() - start);
    const burned = accounts.some((a) => BURN_ADDRESSES.has(a.address));
    return burned;
  } catch {
    recordSourceResult("helius", false, Date.now() - start);
    return null;
  }
}

// BPF Upgradeable Loader — pool accounts owned by this cannot be withdrawn by any wallet
const BPF_UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";

// Known DLMM/CLMM program IDs — pools belonging to these have no fungible LP token
const DLMM_PROGRAM_IDS = new Set([
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",  // Meteora DLMM
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",  // Raydium CLMM
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",   // Orca Whirlpool
]);

export interface PoolLiquiditySafety {
  pool_address: string;
  pool_type: "TRADITIONAL_AMM" | "DLMM_CLMM" | "UNKNOWN";
  lp_token_exists: boolean;
  lp_burned: boolean | null;
  program_owned: boolean;        // owned by BPF = no one can withdraw
  owner_program: string | null;
  safety: "BURNED" | "PROGRAM_CONTROLLED" | "LOCKED" | "UNLOCKED" | "UNKNOWN";
  safety_note: string;
}

function buildUnknownSafety(poolAddress: string): PoolLiquiditySafety {
  return {
    pool_address: poolAddress,
    pool_type: "UNKNOWN",
    lp_token_exists: false,
    lp_burned: null,
    program_owned: false,
    owner_program: null,
    safety: "UNKNOWN",
    safety_note: "Pool safety could not be determined",
  };
}

/**
 * Determine liquidity safety for a pool by inspecting the pool account's owner program.
 *
 * DLMM/CLMM pools (Meteora, Raydium CLMM, Orca Whirlpool) have no fungible LP token.
 * When the pool account is owned by a known DLMM program or BPF Upgradeable Loader,
 * no wallet can unilaterally withdraw liquidity.
 *
 * Traditional AMM pools (Raydium AMM v4, PumpSwap) mint an LP token — safety depends
 * on whether those LP tokens have been burned.
 */
export async function checkPoolLiquiditySafety(
  poolAddress: string,
  lpMintAddress: string | null,
  options: { timeout?: number } = {}
): Promise<PoolLiquiditySafety> {
  if (!isAvailable("helius_rpc")) return buildUnknownSafety(poolAddress);

  const timeout = options.timeout ?? 3000;
  const start = Date.now();

  type SingleResponse = { id: number; result?: any; error?: any };

  try {
    const accountResult = await rpcWithRetry<SingleResponse>(
      (endpoint) => rpcPost<SingleResponse>(endpoint, {
        jsonrpc: "2.0",
        id: 1,
        method: "getAccountInfo",
        params: [poolAddress, { encoding: "base64", commitment: "confirmed" }],
      }, timeout)
    );

    if (!accountResult?.result?.value) {
      recordSourceResult("helius", false, Date.now() - start);
      return buildUnknownSafety(poolAddress);
    }

    recordSourceResult("helius", true, Date.now() - start);
    const ownerProgram: string = accountResult.result.value.owner;
    const isProgramOwned = ownerProgram === BPF_UPGRADEABLE_LOADER ||
      DLMM_PROGRAM_IDS.has(ownerProgram);

    // No LP mint = DLMM pool — no fungible LP token can be burned or withdrawn
    if (!lpMintAddress) {
      return {
        pool_address: poolAddress,
        pool_type: "DLMM_CLMM",
        lp_token_exists: false,
        lp_burned: null,
        program_owned: isProgramOwned,
        owner_program: ownerProgram,
        safety: isProgramOwned ? "PROGRAM_CONTROLLED" : "UNKNOWN",
        safety_note: isProgramOwned
          ? "DLMM pool owned by system program — no LP token exists, liquidity cannot be withdrawn by any wallet"
          : "DLMM pool with unknown ownership — verify independently",
      };
    }

    // Traditional AMM — check whether LP tokens are burned
    const lp_burned = await checkLPBurned(lpMintAddress, { timeout: Math.max(1000, timeout - (Date.now() - start)) });

    return {
      pool_address: poolAddress,
      pool_type: "TRADITIONAL_AMM",
      lp_token_exists: true,
      lp_burned,
      program_owned: isProgramOwned,
      owner_program: ownerProgram,
      safety: lp_burned === true ? "BURNED"
            : isProgramOwned   ? "PROGRAM_CONTROLLED"
            : "UNLOCKED",
      safety_note: lp_burned === true
        ? "LP tokens permanently burned — liquidity cannot be removed"
        : isProgramOwned
        ? "Pool controlled by program — withdrawal requires program upgrade"
        : "LP tokens not burned and not locked — liquidity can be removed",
    };
  } catch {
    recordSourceResult("helius", false, Date.now() - start);
    return buildUnknownSafety(poolAddress);
  }
}

/**
 * Estimate wallet age in days by finding its oldest transaction signature.
 *
 * Fetches up to 2 batches of 1000 signatures (oldest-first walk) to find the
 * first transaction. Returns null on any RPC failure.
 */
export async function getWalletAgeDays(
  walletAddress: string,
  options: { timeout?: number } = {}
): Promise<number | null> {
  const timeout = options.timeout ?? 5000;

  type SingleResponse = { id: number; result?: any; error?: any };

  // Batch 1: fetch most recent 1000 signatures, then jump to the oldest
  const batch1 = await rpcWithRetry<SingleResponse>(
    (endpoint) => rpcPost<SingleResponse>(endpoint, {
      jsonrpc: "2.0",
      id: 1,
      method: "getSignaturesForAddress",
      params: [walletAddress, { limit: 1000 }],
    }, timeout)
  );

  if (!batch1) return null;

  const sigs1: Array<{ signature: string; blockTime?: number | null }> = batch1?.result ?? [];
  if (!Array.isArray(sigs1) || sigs1.length === 0) return null;

  let oldestSig = sigs1[sigs1.length - 1];

  // If we got a full page there may be older txs — fetch one more batch before it
  if (sigs1.length === 1000) {
    const batch2 = await rpcWithRetry<SingleResponse>(
      (endpoint) => rpcPost<SingleResponse>(endpoint, {
        jsonrpc: "2.0",
        id: 2,
        method: "getSignaturesForAddress",
        params: [walletAddress, { limit: 1000, before: oldestSig.signature }],
      }, timeout)
    );

    if (batch2) {
      const sigs2: Array<{ signature: string; blockTime?: number | null }> = batch2?.result ?? [];
      if (Array.isArray(sigs2) && sigs2.length > 0) {
        oldestSig = sigs2[sigs2.length - 1];
      }
    }
  }

  if (oldestSig.blockTime == null) return null;
  return (Date.now() / 1000 - oldestSig.blockTime) / 86_400;
}

/**
 * Fetch the oldest transaction slot and blockTime for a mint address.
 * Used for launch anomaly detection (same-block mint + pool creation).
 *
 * Fetches up to 1000 signatures for the address — the last entry is the
 * creation transaction. Returns null on failure or timeout.
 * Uses a hard 2000ms timeout per the SLA requirement.
 */
// ---------------------------------------------------------------------------
// Helius Enhanced API — transaction history
// ---------------------------------------------------------------------------

const HELIUS_ENHANCED_BASE = "https://api.helius.xyz/v0";
const HELIUS_DAS_BASE = "https://mainnet.helius-rpc.com";

/**
 * Fetch the mint deployer (Metaplex update authority) via Helius DAS getAsset.
 *
 * For pump.fun tokens the mint authority is burned post-launch, so getMintAuthorityAddress
 * returns null. The Metaplex update authority stored in getAsset.authorities[0] is the
 * token creator and serves as the dev wallet address in that case.
 *
 * Returns null when HELIUS_API_KEY is missing, on any fetch failure, or when the
 * authority is a known program address (executable accounts are filtered out by the caller).
 */
export async function getMintDeployer(
  mintAddress: string,
  options: { timeout?: number } = {}
): Promise<string | null> {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) return null;

  const timeout = options.timeout ?? 3000;
  const url = `${HELIUS_DAS_BASE}/?api-key=${apiKey}`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getAsset",
        params: { id: mintAddress },
      }),
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) return null;
    const json = await res.json() as { result?: { authorities?: Array<{ address: string; scopes: string[] }> } };
    const authorities = json?.result?.authorities ?? [];
    return authorities[0]?.address ?? null;
  } catch {
    return null;
  }
}

/**
 * Circular wash trading detection via Helius SWAP transactions.
 * Builds an adjacency map { fromWallet → Map<toWallet, timestamp> } filtered
 * to this mint, then detects A→B→A cycles within a 60-minute window.
 * Returns null when HELIUS_API_KEY is missing or on any fetch failure.
 */
export interface WashTradingDetectionResult {
  circular_pairs: number;
  total_swaps: number;
}

export async function detectCircularWashTrading(
  mintAddress: string,
  options: { timeout?: number } = {}
): Promise<WashTradingDetectionResult | null> {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) return null;

  const timeout = options.timeout ?? 4000;
  const url = `${HELIUS_ENHANCED_BASE}/addresses/${mintAddress}/transactions?type=SWAP&api-key=${apiKey}&limit=100`;

  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  } catch {
    return null;
  }

  if (!res.ok) return null;

  let result: unknown;
  try {
    result = await res.json();
  } catch {
    return null;
  }

  if (!Array.isArray(result)) return null;

  // Build adjacency map: { fromWallet → Map<toWallet, unix_timestamp> }
  const adjacency = new Map<string, Map<string, number>>();

  for (const tx of result as Array<{ timestamp?: number; tokenTransfers?: Array<{ fromUserAccount?: string; toUserAccount?: string; mint?: string }> }>) {
    const blockTime = tx.timestamp ?? 0;
    for (const t of tx.tokenTransfers ?? []) {
      if (t.mint !== mintAddress) continue;
      const from = t.fromUserAccount;
      const to = t.toUserAccount;
      if (!from || !to || from === to) continue;
      if (!adjacency.has(from)) adjacency.set(from, new Map());
      adjacency.get(from)!.set(to, blockTime);
    }
  }

  // Detect A→B→A within 60-minute window
  const WINDOW_SEC = 3600;
  let circular_pairs = 0;

  for (const [a, targets] of adjacency) {
    for (const [b, ts_ab] of targets) {
      const bTargets = adjacency.get(b);
      if (!bTargets) continue;
      const ts_ba = bTargets.get(a);
      if (ts_ba === undefined) continue;
      if (Math.abs(ts_ab - ts_ba) <= WINDOW_SEC) {
        circular_pairs++;
      }
    }
  }

  // Each pair counted twice (A→B and B→A), divide by 2
  return {
    circular_pairs: Math.floor(circular_pairs / 2),
    total_swaps: result.length,
  };
}

/**
 * Fetch the earliest parsed transactions for a token address from the Helius enhanced API.
 * Omits type filter so it captures all transaction types (TRANSFER, SWAP, MINT, etc.)
 * to cover the initial token distribution at launch — the key window for cluster detection.
 * Returns null when HELIUS_API_KEY is missing or the request fails.
 */
export async function getTokenSwapTransactions(
  mintAddress: string,
  options: { timeout?: number; limit?: number; order?: "asc" | "desc" } = {}
): Promise<any[] | null> {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) return null;

  const timeout = options.timeout ?? 5000;
  const limit = options.limit ?? 100;
  const order = options.order ?? "asc";
  // No type filter — include SWAP, TRANSFER, MINT etc. to capture initial distribution
  const url = `${HELIUS_ENHANCED_BASE}/addresses/${mintAddress}/transactions?api-key=${apiKey}&limit=${limit}&order=${order}`;

  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  } catch {
    return null;
  }

  if (!res.ok) return null;

  try {
    const result = await res.json();
    return Array.isArray(result) ? result : null;
  } catch {
    return null;
  }
}

/**
 * Fetch the fee payer for a wallet's earliest known swaps.
 * Used by deepDive Phase 1b to detect shared fee payers across top holders,
 * which is the primary on-chain signal for coordinated/bundled buying.
 * Returns null on any error or when HELIUS_API_KEY is missing.
 */
export async function getWalletSwapFeePayers(
  walletAddress: string,
  options: { timeout?: number; limit?: number } = {}
): Promise<Array<{ fee_payer: string; block_time: number }> | null> {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) return null;

  const timeout = options.timeout ?? 1500;
  const limit = options.limit ?? 5;
  // order=asc → earliest swaps first (capturing bundled launch purchases)
  const url = `${HELIUS_ENHANCED_BASE}/addresses/${walletAddress}/transactions?type=SWAP&api-key=${apiKey}&limit=${limit}&order=asc`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
    if (!res.ok) return null;
    const txs = await res.json();
    if (!Array.isArray(txs)) return null;
    return txs.map(tx => ({
      fee_payer: (tx.feePayer ?? tx.fee_payer ?? "") as string,
      block_time: (tx.timestamp ?? tx.blockTime ?? 0) as number,
    }));
  } catch {
    return null;
  }
}

/**
 * Fetch authority change history from Helius enhanced API.
 * Queries SET_AUTHORITY and MINT_TO transaction types.
 * Handles non-array responses (Helius returns error object when no txns exist).
 * Returns null when HELIUS_API_KEY is missing.
 */
export interface AuthorityHistoryResult {
  mint_authority_changes: number;
  authority_ever_regranted: boolean;
  post_launch_mints: number;
}

export async function getAuthorityHistory(
  mintAddress: string,
  options: { timeout?: number } = {}
): Promise<AuthorityHistoryResult | null> {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) return null;

  const timeout = options.timeout ?? 3000;

  const [setAuthRes, mintToRes] = await Promise.allSettled([
    fetch(
      `${HELIUS_ENHANCED_BASE}/addresses/${mintAddress}/transactions?type=SET_AUTHORITY&api-key=${apiKey}`,
      { signal: AbortSignal.timeout(timeout) }
    ),
    fetch(
      `${HELIUS_ENHANCED_BASE}/addresses/${mintAddress}/transactions?type=MINT_TO&api-key=${apiKey}`,
      { signal: AbortSignal.timeout(timeout) }
    ),
  ]);

  let setAuthTxns: unknown[] = [];
  if (setAuthRes.status === "fulfilled" && setAuthRes.value.ok) {
    try {
      const data = await setAuthRes.value.json();
      setAuthTxns = Array.isArray(data) ? data : [];
    } catch { /* non-fatal */ }
  }

  let mintToTxns: unknown[] = [];
  if (mintToRes.status === "fulfilled" && mintToRes.value.ok) {
    try {
      const data = await mintToRes.value.json();
      mintToTxns = Array.isArray(data) ? data : [];
    } catch { /* non-fatal */ }
  }

  const mint_authority_changes = setAuthTxns.length;
  return {
    mint_authority_changes,
    authority_ever_regranted: mint_authority_changes > 0,
    post_launch_mints: mintToTxns.length,
  };
}

export async function getMintCreationBlock(
  mintAddress: string,
  options: { timeout?: number } = {}
): Promise<{ slot: number | null; blockTime: number | null } | null> {
  const timeout = options.timeout ?? 2000;

  type SingleResponse = { id: number; result?: any; error?: any };

  const result = await rpcWithRetry<SingleResponse>(
    (endpoint) => rpcPost<SingleResponse>(endpoint, {
      jsonrpc: "2.0",
      id: 1,
      method: "getSignaturesForAddress",
      params: [mintAddress, { limit: 1000 }],
    }, timeout)
  );

  if (!result?.result) return null;

  const sigs: Array<{ signature: string; slot: number; blockTime?: number | null }> =
    Array.isArray(result.result) ? result.result : [];

  if (sigs.length === 0) return null;

  const oldest = sigs[sigs.length - 1];
  return {
    slot: typeof oldest.slot === "number" ? oldest.slot : null,
    blockTime: typeof oldest.blockTime === "number" ? oldest.blockTime : null,
  };
}

export async function getTokenInfo(
  address: string,
  options: { timeout?: number } = {}
): Promise<HeliusTokenData | null> {
  if (!isAvailable("helius_rpc")) return null;

  const timeout = options.timeout ?? 3000;

  // Fetch mint account only — authority flags are the critical fallback data.
  // top_10_holder_pct comes from RugCheck (primary); adding getTokenLargestAccounts
  // to the batch causes rate-limit failures on high-traffic tokens with public RPCs.
  type SingleResponse = { id: number; result?: any; error?: { code: number; message: string } };

  const start = Date.now();
  const accountResult = await rpcWithRetry<SingleResponse>(
    (endpoint) => rpcPost<SingleResponse>(endpoint, {
      jsonrpc: "2.0",
      id: 1,
      method: "getAccountInfo",
      params: [address, { encoding: "base64" }],
    }, timeout)
  );

  if (!accountResult) {
    recordSourceResult("helius", false, Date.now() - start);
    recordFailure("helius_rpc");
    return null;
  }

  // Parse mint account for authority flags
  let mint_authority_revoked: boolean | null = null;
  let freeze_authority_revoked: boolean | null = null;

  try {
    const accountData = accountResult?.result?.value?.data;
    if (Array.isArray(accountData) && typeof accountData[0] === "string") {
      const parsed = parseMintAccount(accountData[0]);
      mint_authority_revoked = parsed.mint_authority_revoked;
      freeze_authority_revoked = parsed.freeze_authority_revoked;
    }
  } catch {
    // Non-fatal: leave as null
  }

  // Only record success if we actually got useful data back
  const gotSomething = mint_authority_revoked !== null || freeze_authority_revoked !== null;
  if (gotSomething) {
    recordSourceResult("helius", true, Date.now() - start);
    recordSuccess("helius_rpc");
  } else {
    recordSourceResult("helius", false, Date.now() - start);
    recordFailure("helius_rpc");
    return null;
  }

  return {
    mint_authority_revoked,
    freeze_authority_revoked,
    top_10_holder_pct: null, // RugCheck is primary; not fetched here to avoid rate-limit pressure
    token_age_days: null,    // derived from DexScreener pair_created_at_ms
  };
}

export interface WalletIdentityResult {
  type: "exchange" | "protocol" | "wallet" | "unknown";
  name: string | null;
  category: string | null;
}

/**
 * Returns the Helius wallet identity for a given address.
 * Used to dynamically identify exchange and protocol wallets in holder lists.
 * Returns null when HELIUS_API_KEY is missing or on any fetch failure.
 *
 * Verified live: AC5RDfQFmDS1deWZos921JfqscXdByf8BKHs5ACWjtW2 →
 *   {"type":"exchange","name":"Bybit Hot Wallet 1","category":"Centralized Exchange"}
 */
export async function getWalletIdentity(
  address: string,
  options: { timeout?: number } = {}
): Promise<WalletIdentityResult | null> {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) return null;

  const timeout = options.timeout ?? 2000;
  const url = `https://api.helius.xyz/v1/wallet/${address}/identity?api-key=${apiKey}`;

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeout),
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const raw = await res.json() as { type?: string; name?: string; category?: string };
    return {
      type: (raw.type as WalletIdentityResult["type"]) ?? "unknown",
      name: raw.name ?? null,
      category: raw.category ?? null,
    };
  } catch {
    return null;
  }
}
