// ---------------------------------------------------------------------------
// Jupiter Token Authority Lookup
// Tier 1: tokenMap (bulk strict list) — loaded at startup, refreshed every 24h
// Tier 2: TOKEN_CACHE — per-address cache (1h TTL) populated by API hits
// Tier 3: Jupiter v2 search API — one call per unseen address
// ---------------------------------------------------------------------------

interface JupiterToken {
  address: string;
  symbol: string;
  name: string;
  tags: string[];
}

interface TokenCacheEntry {
  exempt: boolean;
  reason: string | null;
  fetchedAt: number;
}

// Tags that indicate legitimately retained authority — not a rug risk
const EXEMPT_TAGS = new Set([
  "stable",       // stablecoins in v2 (USDC, USDT etc)
  "stablecoin",   // keep for seed list compatibility
  "wormhole",     // wormhole wrapped assets
  "wrapped",      // other wrapped assets
  "verified",     // broadly verified tokens
]);
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const TOKEN_CACHE_TTL_MS   =  1 * 60 * 60 * 1000; // 1 hour

// Critical tokens that must always be exempt even if the fetch fails
const SEED_LIST: JupiterToken[] = [
  { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC",    name: "USD Coin",       tags: ["stable", "stablecoin"] },
  { address: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", symbol: "USDT",    name: "Tether USD",    tags: ["stable", "stablecoin"] },
  { address: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs", symbol: "wETH",    name: "Wrapped Ether",  tags: ["wormhole", "wrapped"] },
  { address: "9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E", symbol: "wBTC",    name: "Wrapped Bitcoin", tags: ["wormhole", "wrapped"] },
  { address: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",  symbol: "mSOL",    name: "Marinade staked SOL", tags: ["verified"] },
  { address: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", symbol: "JitoSOL", name: "Jito Staked SOL",    tags: ["verified"] },
];

// Pre-populate with seed list — available synchronously before the async fetch completes
let tokenMap  = new Map<string, JupiterToken>(SEED_LIST.map(t => [t.address, t]));
let lastFetched = 0;
const TOKEN_CACHE = new Map<string, TokenCacheEntry>();

// ---------------------------------------------------------------------------
// Bulk list loader (seed list — covers all majors synchronously)
// ---------------------------------------------------------------------------

export async function loadJupiterTokenList(): Promise<void> {
  try {
    const res = await fetch("https://lite-api.jup.ag/tokens/v2/tag?query=verified", {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Jupiter list HTTP ${res.status}`);
    const tokens = (await res.json()) as any[];
    // Seed the map first so critical stablecoins survive a partial fetch
    const map = new Map<string, JupiterToken>(SEED_LIST.map((t: JupiterToken) => [t.address, t]));
    for (const t of tokens) {
      map.set(t.id, {
        address: t.id,
        name: t.name ?? "",
        symbol: t.symbol ?? "",
        tags: t.tags ?? [],
      });
    }
    tokenMap = map;
    lastFetched = Date.now();
    console.info(`[jupiter] loaded ${map.size} tokens from strict list`);
  } catch (err) {
    console.warn("[jupiter] failed to load token list — using cached version", err);
  }
}

export async function ensureFresh(): Promise<void> {
  if (Date.now() - lastFetched > REFRESH_INTERVAL_MS) {
    await loadJupiterTokenList();
  }
}

export function getJupiterToken(address: string): JupiterToken | null {
  return tokenMap.get(address) ?? null;
}

// ---------------------------------------------------------------------------
// Synchronous seed-list accessors (tokenMap only — for backward compat)
// ---------------------------------------------------------------------------

export function isAuthorityExempt(address: string): boolean {
  const token = tokenMap.get(address);
  if (!token) return false;
  return token.tags.some(tag => EXEMPT_TAGS.has(tag));
}

export function getExemptReason(address: string): string | null {
  const token = tokenMap.get(address);
  if (!token) return null;
  const matchedTag = token.tags.find(tag => EXEMPT_TAGS.has(tag));
  if (!matchedTag) return null;
  const reasons: Record<string, string> = {
    stablecoin: `${token.symbol} is a verified stablecoin — mint authority retained by regulated issuer`,
    wormhole:   `${token.symbol} is a Wormhole-wrapped asset — authority retained by bridge program`,
    wrapped:    `${token.symbol} is a wrapped asset — authority retained by wrapping protocol`,
  };
  return reasons[matchedTag] ?? `${token.symbol} is a verified token with legitimate retained authority`;
}

// ---------------------------------------------------------------------------
// Per-address API lookup (tiers 2 + 3)
// ---------------------------------------------------------------------------

async function lookupJupiterToken(address: string): Promise<{ exempt: boolean; reason: string | null }> {
  const cached = TOKEN_CACHE.get(address);
  if (cached && Date.now() - cached.fetchedAt < TOKEN_CACHE_TTL_MS) {
    return { exempt: cached.exempt, reason: cached.reason };
  }

  try {
    const res = await fetch(
      `https://lite-api.jup.ag/tokens/v2/search?query=${address}`,
      { signal: AbortSignal.timeout(3_000) }
    );
    if (!res.ok) throw new Error(`Jupiter API ${res.status}`);

    // Response is an array — find the exact address match
    const tokens = await res.json();
    const token = Array.isArray(tokens)
      ? tokens.find((t: any) => t.id === address || t.address === address)
      : null;

    if (!token) {
      TOKEN_CACHE.set(address, { exempt: false, reason: null, fetchedAt: Date.now() });
      return { exempt: false, reason: null };
    }

    const tags: string[] = token.tags ?? [];
    const exempt = tags.some((t: string) => EXEMPT_TAGS.has(t));
    const matchedTag = tags.find((t: string) => EXEMPT_TAGS.has(t));

    const reasons: Record<string, string> = {
      stablecoin: `${token.symbol} is a verified stablecoin — mint authority retained by regulated issuer`,
      wormhole:   `${token.symbol} is a Wormhole-wrapped asset — authority retained by bridge program`,
      wrapped:    `${token.symbol} is a wrapped asset — authority retained by wrapping protocol`,
    };
    const reason = matchedTag
      ? (reasons[matchedTag] ?? `${token.symbol} is a verified token with legitimate retained authority`)
      : null;

    if (exempt) {
      console.info(`[jupiter] ${token.symbol} (${address}) identified as exempt via API — cached`);
    }

    TOKEN_CACHE.set(address, { exempt, reason, fetchedAt: Date.now() });
    return { exempt, reason };
  } catch (err) {
    console.warn(`[jupiter] API lookup failed for ${address}`, err);
    TOKEN_CACHE.set(address, { exempt: false, reason: null, fetchedAt: Date.now() });
    return { exempt: false, reason: null };
  }
}

// ---------------------------------------------------------------------------
// Full 3-tier resolver — use this in scan paths
// ---------------------------------------------------------------------------

export async function resolveAuthorityExempt(
  address: string
): Promise<{ exempt: boolean; reason: string | null }> {
  // Tier 1: seed list (tokenMap) — synchronous, zero cost, covers all majors
  const seedToken = tokenMap.get(address);
  if (seedToken) {
    const matchedTag = seedToken.tags.find(tag => EXEMPT_TAGS.has(tag));
    if (!matchedTag) return { exempt: false, reason: null };
    const reasons: Record<string, string> = {
      stablecoin: `${seedToken.symbol} is a verified stablecoin — mint authority retained by regulated issuer`,
      wormhole:   `${seedToken.symbol} is a Wormhole-wrapped asset — authority retained by bridge program`,
      wrapped:    `${seedToken.symbol} is a wrapped asset — authority retained by wrapping protocol`,
    };
    return {
      exempt: true,
      reason: reasons[matchedTag] ?? `${seedToken.symbol} is a verified token with legitimate retained authority`,
    };
  }

  // Tiers 2 + 3: TOKEN_CACHE then API call
  return lookupJupiterToken(address);
}
