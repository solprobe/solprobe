import { PublicKey } from "@solana/web3.js";

export function isValidSolanaAddress(address: string): boolean {
  if (typeof address !== "string") return false;
  if (address.length < 32 || address.length > 44) return false;
  try {
    new PublicKey(address); // deserialises to 32-byte pubkey — throws if invalid
    return true;
  } catch {
    return false;
  }
}

export function isValidSolanaWallet(address: string): boolean {
  return isValidSolanaAddress(address);
}
