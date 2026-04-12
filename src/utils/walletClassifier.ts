import type { FunderType, FundingSource } from "../scanner/types.js";

const PRIMARY_RPC = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const FALLBACK_RPC = "https://api.mainnet-beta.solana.com";

async function rpcPost<T>(endpoint: string, body: unknown, timeoutMs: number): Promise<T | null> {
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as any;
    if (json?.error) return null;
    return (json?.result ?? null) as T | null;
  } catch {
    return null;
  }
}

async function rpcWithFallback<T>(body: unknown, timeoutMs: number): Promise<T | null> {
  const r = await rpcPost<T>(PRIMARY_RPC, body, timeoutMs);
  if (r !== null) return r;
  return rpcPost<T>(FALLBACK_RPC, body, timeoutMs);
}

function validateFunderAge(
  funderCreatedAt: number | null,
  fundingTxTimestamp: number | null
): number | null {
  if (funderCreatedAt === null) return null;
  if (fundingTxTimestamp === null) return null;
  if (funderCreatedAt > fundingTxTimestamp) return null;
  const ageMs = Date.now() - funderCreatedAt * 1000;
  return Math.floor(ageMs / (1000 * 60 * 60 * 24));
}

const _default: FundingSource = {
  funder_address: null,
  funder_type: "UNKNOWN",
  funder_age_days: null,
  funder_tx_count: null,
  shared_funder_wallets: [],
  cluster_size: 1,
  risk: "MEDIUM",
  risk_reason: "funder details unavailable",
  action_guidance: "verify funding source manually before high-value trades",
};

/**
 * Classify the funding source of a wallet given its oldest known transaction signature.
 * Returns a clean FundingSource (no internal _warnings field).
 */
export async function classifyWalletFundingSource(
  walletAddress: string,
  oldestSig: string | null,
  timeoutMs: number
): Promise<FundingSource> {
  if (!oldestSig) return _default;

  try {
    const tx = await rpcWithFallback<any>(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "getTransaction",
        params: [oldestSig, { encoding: "json", maxSupportedTransactionVersion: 0 }],
      },
      timeoutMs
    );
    if (!tx) return _default;

    const fundingTxTimestamp: number | null =
      typeof tx.blockTime === "number" ? tx.blockTime : null;

    const accountKeys: string[] = tx.transaction?.message?.accountKeys ?? [];
    const preBalances: number[] = tx.meta?.preBalances ?? [];
    const postBalances: number[] = tx.meta?.postBalances ?? [];
    const walletIdx = accountKeys.indexOf(walletAddress);
    if (walletIdx === -1) return _default;

    let funderIdx = -1;
    for (let i = 0; i < accountKeys.length; i++) {
      if (i === walletIdx) continue;
      if ((postBalances[i] ?? 0) - (preBalances[i] ?? 0) < 0) {
        funderIdx = i;
        break;
      }
    }
    if (funderIdx === -1) return _default;

    const funderAddress = accountKeys[funderIdx];

    const funderSigs = await rpcWithFallback<any[]>(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "getSignaturesForAddress",
        params: [funderAddress, { limit: 200 }],
      },
      timeoutMs
    );

    if (!funderSigs || funderSigs.length === 0) {
      return {
        funder_address: funderAddress,
        funder_type: "FRESH_WALLET",
        funder_age_days: null,
        funder_tx_count: 0,
        shared_funder_wallets: [],
        cluster_size: 1,
        risk: "HIGH",
        risk_reason: "funded by brand-new wallet with zero transaction history",
        action_guidance: "treat as high-risk — fresh wallets are common deployer proxies",
      };
    }

    const funderTxCount = funderSigs.length;
    const oldest = funderSigs[funderSigs.length - 1];
    const funderCreatedAt: number | null =
      typeof oldest?.blockTime === "number" ? oldest.blockTime : null;
    const funderAgeDays = validateFunderAge(funderCreatedAt, fundingTxTimestamp);

    let funder_type: FunderType;
    if (funderTxCount > 10_000) {
      funder_type = "CEX";
    } else if (funderAgeDays !== null && funderAgeDays < 3 && funderTxCount < 10) {
      funder_type = "FRESH_WALLET";
    } else if (funderAgeDays !== null && funderAgeDays < 30 && funderTxCount < 100) {
      funder_type = "DEPLOYER";
    } else {
      funder_type = "PEER_WALLET";
    }

    let risk: "HIGH" | "MEDIUM" | "LOW";
    let risk_reason: string;
    let action_guidance: string;

    if (funder_type === "FRESH_WALLET") {
      risk = "HIGH";
      risk_reason = "funder is a fresh wallet (<3 days, <10 txns) — probable deployer proxy";
      action_guidance = "avoid high-value trades — fresh funder chain is a common rug setup";
    } else if (funder_type === "DEPLOYER") {
      risk = "HIGH";
      risk_reason = "funder has deployer-like activity pattern (<30 days, <100 txns)";
      action_guidance = "verify funder is not associated with token deployers you are trading";
    } else if (funder_type === "CEX") {
      risk = "LOW";
      risk_reason = "funded from a high-volume account (likely CEX withdrawal)";
      action_guidance = "no unusual funding risk detected";
    } else if (funderAgeDays !== null && funderAgeDays > 365) {
      risk = "LOW";
      risk_reason = "funded by an aged wallet (>1 year) — low chain risk";
      action_guidance = "no unusual funding risk detected";
    } else {
      risk = "MEDIUM";
      risk_reason = "funder is a peer wallet with limited history";
      action_guidance = "standard caution — no specific risk signal detected";
    }

    return {
      funder_address: funderAddress,
      funder_type,
      funder_age_days: funderAgeDays,
      funder_tx_count: funderTxCount,
      shared_funder_wallets: [],
      cluster_size: 1,
      risk,
      risk_reason,
      action_guidance,
    };
  } catch {
    return _default;
  }
}
