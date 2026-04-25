// ---------------------------------------------------------------------------
// Custodial LP Platform Registry
// ---------------------------------------------------------------------------
// DEX platforms that hold LP tokens in a known protocol-controlled wallet
// rather than burning them. When lp_burn check returns null AND the dex_id
// matches an entry here, the LP status is CUSTODIAL (not UNKNOWN).
//
// To add a new platform: verify the custodial wallet via Helius /identity,
// confirm the wallet type is "wallet" and name identifies the protocol.
// ---------------------------------------------------------------------------

export interface CustodialLPPlatform {
  platform: string;
  /** Addresses that hold LP tokens on behalf of bonding-curve or pool participants */
  custodial_wallets: string[];
  /** Protocol treasury / operational wallets also holding LP */
  treasury_wallets: string[];
  type_description: string;
  risk_implication: string;
}

/**
 * Map of DexScreener dexId → custodial platform info.
 * Lookup: `CUSTODIAL_DEX_LP_PLATFORMS.get(dex_id)`.
 */
export const CUSTODIAL_DEX_LP_PLATFORMS = new Map<string, CustodialLPPlatform>([
  ["pumpswap", {
    platform: "pump.fun",
    // Verified via Helius identity API 2025-04-25
    custodial_wallets: ["Cfq1ts1iFr1eUWWBm8eFxUzm5R3YA3UvMZznwiShbgZt"],
    treasury_wallets:  ["G8CcfRffqZWHSAQJXLDfwbAkGE95SddUqVXnTrL4kqjm"],
    type_description:  "Pump.fun Protocol Custody & Treasury",
    risk_implication:
      "Liquidity is controlled by the pump.fun platform, not an anonymous creator. " +
      "Not an immediate rug vector, but represents single-point-of-failure platform risk.",
  }],
]);

// ---------------------------------------------------------------------------
// Known Protocol / Custodian Address Whitelist
// ---------------------------------------------------------------------------
// Protocol-owned addresses that should be excluded from holder concentration
// calculations. Counting these as normal holders inflates concentration figures.
// Includes Virtuals Protocol (Base chain) and pump.fun custodian/treasury (Solana).
// ---------------------------------------------------------------------------

const KNOWN_PROTOCOL_ADDRESSES = new Set<string>([
  // Virtuals Protocol genesis / deployer address (Base chain)
  "0xe2890629ef31b32132003c02b29a50a025deee8a",
  // VIRTUAL token contract address (Base chain)
  "0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b",
  // Pump.fun Token Custodian — holds tokens on behalf of bonding-curve buyers
  // Verified via Helius identity: type=wallet, name="Pump.fun Token Custodian"
  "cfq1ts1ifr1euwwbm8efxuzm5r3ya3uvmzznwishbgzt",
  // Pump.fun Treasury — fee collection / operational wallet
  // Verified via Helius identity: type=wallet, name="Pump.fun Treasury"
  "g8ccfrffqzwhsaqjxldfwbakge95sdduqvxntrl4kqjm",
]);

/**
 * Returns true if the given address is a known protocol/custodian address
 * that should be excluded from holder concentration calculations.
 * Comparison is case-insensitive.
 *
 * @example
 * isProtocolAddress("0xe2890629EF31b32132003C02B29a50A025dEeE8a") // true
 * isProtocolAddress("Cfq1ts1iFr1eUWWBm8eFxUzm5R3YA3UvMZznwiShbgZt") // true
 */
export function isProtocolAddress(address: string): boolean {
  return KNOWN_PROTOCOL_ADDRESSES.has(address.toLowerCase());
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

// ---------------------------------------------------------------------------
// LP-burning launchpads
// ---------------------------------------------------------------------------
// Programs that burn LP tokens at launch by default. Tokens created through
// these programs always have burned LP — the -25 lp_burned penalty must not
// apply.
//
// IMPORTANT: only add a program after confirming it burns LP by default.
// Verify via Helius getAsset on a known token from that launchpad and check
// that the LP largest-account holder is a burn address.
// ---------------------------------------------------------------------------

export const LP_BURN_LAUNCHPADS = new Set([
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",  // pump.fun — confirmed
  // "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj",  // launch.coinlaunch — UNVERIFIED, do not uncomment until confirmed
  // "BonkLaunchpadProgrm11111111111111111111111111",   // bonk launchpad    — UNVERIFIED, do not uncomment until confirmed
  // "MoonShotTokenLaunchpad111111111111111111111111",  // moonshot           — UNVERIFIED, do not uncomment until confirmed
]);

/**
 * Returns true if the given Solana program ID is a known launchpad that burns
 * LP tokens at launch by default.
 */
export function isLPBurnLaunchpad(programId: string): boolean {
  return LP_BURN_LAUNCHPADS.has(programId);
}

// ---------------------------------------------------------------------------
// Known Vesting Programs
// ---------------------------------------------------------------------------
// Programs that lock tokens in escrow and release them to recipients over time.
// Used to detect when a top holder received tokens via vesting and transferred
// them out — a dump risk signal.
//
// IMPORTANT: escrow wallet addresses return {"type":"unknown"} from Helius
// identity — match on program ID only.
// ---------------------------------------------------------------------------

/**
 * Map of program ID → platform name for known vesting programs.
 * Lookup: `KNOWN_VESTING_PROGRAMS.get(programId)`.
 */
export const KNOWN_VESTING_PROGRAMS = new Map<string, string>([
  ["strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m", "Streamflow"],
  ["vesTcKoh7z3Yg9noSNMJ2RbHKTwNEfDCBY1Z3kQzYuV", "Valhalla"],
  ["Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS", "Unloc"],
]);
