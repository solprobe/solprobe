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
