import { isValidSolanaAddress } from "../../../src/validate.js";

export async function executeJob(requirements: any): Promise<any> {
  try {
    const response = await fetch("http://localhost:8000/scan/deep", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requirements),
      signal: AbortSignal.timeout(35_000),
    });
    return response.json();
  } catch (err) {
    return { error: true, message: String(err), data_confidence: "LOW" };
  }
}

export function validateRequirements(requirements: any): boolean {
  return isValidSolanaAddress(requirements?.token_address);
}

// ⚠️ TODO BEFORE PRODUCTION: Implement actual Virtuals Protocol payment verification.
// This stub always approves. Replace with real ACP payment verification flow
// using the Virtuals Protocol SDK before going live on the marketplace.
export async function requestPayment(_requirements: any): Promise<any> {
  return { approved: true };
}
