// ---------------------------------------------------------------------------
// Jupiter Strict Token List
// Authoritative source for identifying tokens with legitimately retained
// authorities — stablecoins, wrapped assets, and bridge tokens.
// Fetched once at startup and refreshed every 24 hours in the background.
// ---------------------------------------------------------------------------

interface JupiterToken {
  address: string;
  symbol: string;
  name: string;
  tags: string[];
}

// Tags that indicate legitimately retained authority — not a rug risk
const EXEMPT_TAGS = new Set(["stablecoin", "wormhole", "wrapped"]);
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

let tokenMap = new Map<string, JupiterToken>();
let lastFetched = 0;

export async function loadJupiterTokenList(): Promise<void> {
  try {
    const res = await fetch("https://token.jup.ag/strict", {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Jupiter list HTTP ${res.status}`);
    const tokens: JupiterToken[] = await res.json();
    const map = new Map<string, JupiterToken>();
    for (const t of tokens) map.set(t.address, t);
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
