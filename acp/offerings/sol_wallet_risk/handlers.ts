import { isValidSolanaAddress } from "../../../src/validate.js";
import { withRetry, RETRY_CONFIG } from "../../../src/utils/retry.js";
import type { ExecuteJobResult } from "../../../runtime/offeringTypes.js";

export async function executeJob(
  requirements: unknown
): Promise<ExecuteJobResult> {
  try {
    const result = await withRetry(
      () =>
        fetch("http://localhost:8000/wallet/risk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requirements),
          signal: AbortSignal.timeout(RETRY_CONFIG.sol_wallet_risk.timeoutMs),
        }).then((r) => r.json()),
      {
        attempts: RETRY_CONFIG.sol_wallet_risk.attempts,
        delayMs: RETRY_CONFIG.sol_wallet_risk.delayMs,
        backoff: "exponential",
        label: "sol_wallet_risk",
      }
    );
    return { deliverable: JSON.stringify(result) };
  } catch (err) {
    return {
      deliverable: JSON.stringify({
        error: true,
        message: "Service temporarily unavailable after 3 attempts",
        retry_suggested: true,
        data_confidence: "NONE",
      }),
    };
  }
}

export function validateRequirements(requirements: unknown): boolean {
  return isValidSolanaAddress(
    (requirements as Record<string, unknown>)?.wallet_address as string
  );
}

export async function requestPayment(
  _requirements: unknown
): Promise<string> {
  return "Payment accepted";
}
