// ---------------------------------------------------------------------------
// Virtuals Protocol Address Whitelist
// ---------------------------------------------------------------------------
// These are protocol-owned on-chain addresses (Base chain) that should be
// excluded from holder concentration calculations. Virtuals Protocol holds
// tokens in these accounts as part of bonding-curve / treasury mechanics —
// counting them as normal holders would inflate concentration figures.
// ---------------------------------------------------------------------------

const VIRTUALS_PROTOCOL_ADDRESSES = new Set<string>([
  // Virtuals Protocol genesis / deployer address
  "0xe2890629ef31b32132003c02b29a50a025deee8a",
  // VIRTUAL token contract address (Base chain)
  "0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b",
]);

/**
 * Returns true if the given address belongs to Virtuals Protocol.
 * Comparison is case-insensitive.
 *
 * @example
 * isProtocolAddress("0xe2890629EF31b32132003C02B29a50A025dEeE8a") // true
 */
export function isProtocolAddress(address: string): boolean {
  return VIRTUALS_PROTOCOL_ADDRESSES.has(address.toLowerCase());
}

// ---------------------------------------------------------------------------
// Solana Program IDs
// ---------------------------------------------------------------------------

export const PROGRAMS = {
  PUMP_FUN:          "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  TOKEN_PROGRAM:     "TokenkebQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  TOKEN_2022:        "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  METAPLEX_METADATA: "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
  RAYDIUM_AMM_V4:    "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
  ORCA_WHIRLPOOL:    "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
} as const;
