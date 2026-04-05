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
