// ---------------------------------------------------------------------------
// LLM Narrative Engine
// Generates analyst-quality summaries with a two-provider cascade:
//   1. Anthropic (Haiku / Sonnet) — primary
//   2. Groq (Llama / Mixtral)    — fallback
// Both public functions are fully fault-tolerant — they always return a
// string, even when all API keys are absent or every call fails.
// ---------------------------------------------------------------------------

import type { ScoringFactor } from "../scanner/types.js";

// ---------------------------------------------------------------------------
// Provider definitions
// ---------------------------------------------------------------------------

type ProviderFormat = "anthropic" | "openai";

interface Provider {
  name: string;
  baseUrl: string;
  apiKey: () => string | undefined;
  models: { fast: string; deep: string };
  format: ProviderFormat;
}

const PROVIDERS: Provider[] = [
  {
    name: "anthropic",
    baseUrl: "https://api.anthropic.com/v1/messages",
    apiKey: () => process.env.ANTHROPIC_API_KEY,
    models: {
      fast: "claude-haiku-4-5-20251001",
      deep: "claude-sonnet-4-6",
    },
    format: "anthropic",
  },
  {
    name: "groq",
    baseUrl: "https://api.groq.com/openai/v1/chat/completions",
    apiKey: () => process.env.GROQ_API_KEY,
    models: {
      fast: "llama-3.1-8b-instant",
      deep: "llama-3.3-70b-versatile",
    },
    format: "openai",
  },
];

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface QuickScanData {
  mint_authority_revoked: boolean;
  freeze_authority_revoked: boolean;
  top_10_holder_pct: number | null;
  liquidity_usd: number | null;
  risk_grade: string;
  data_confidence: string;
  has_rug_history?: boolean;
  authority_exempt?: boolean;
  authority_exempt_reason?: string | null;
  factors?: ScoringFactor[];
}

export interface DeepDiveData {
  risk_grade: string;
  has_rug_history: boolean;
  mint_authority_revoked: boolean;
  freeze_authority_revoked: boolean;
  top_10_holder_pct: number | null;
  liquidity_usd: number | null;
  volume_24h: number;
  momentum_score: number;
  pump_fun_launched: boolean;
  bundled_launch_detected: boolean;
  data_confidence: string;
  recommendation: string;
  authority_exempt?: boolean;
  authority_exempt_reason?: string | null;
  factors?: ScoringFactor[];
  historical_flags?: string[];
  name?: string | null;
  symbol?: string | null;
}

// ---------------------------------------------------------------------------
// Provider cascade helpers
// ---------------------------------------------------------------------------

async function callProvider(
  provider: Provider,
  tier: "fast" | "deep",
  maxTokens: number,
  system: string,
  userMessage: string
): Promise<string | null> {
  const apiKey = provider.apiKey();
  if (!apiKey) {
    console.warn(`[llm] ${provider.name} — API key not set, skipping`);
    return null;
  }

  const model = provider.models[tier];

  let body: Record<string, unknown>;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };

  if (provider.format === "anthropic") {
    // Anthropic uses x-api-key + separate system field (supports prompt caching)
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
    delete headers["Authorization"];
    body = {
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: userMessage }],
    };
  } else {
    // OpenAI-compatible: system as first message
    body = {
      model,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userMessage },
      ],
    };
  }

  const res = await fetch(provider.baseUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8_000),
  });

  if (!res.ok) {
    throw new Error(`${provider.name} HTTP ${res.status}`);
  }

  const json = (await res.json()) as any;

  let text: string | undefined;
  if (provider.format === "anthropic") {
    text = json?.content?.[0]?.text;
  } else {
    text = json?.choices?.[0]?.message?.content;
  }

  return text && text.trim().length > 0 ? text.trim() : null;
}

async function callWithFallback(
  tier: "fast" | "deep",
  maxTokens: number,
  system: string,
  userMessage: string
): Promise<string> {
  for (const provider of PROVIDERS) {
    try {
      const result = await callProvider(provider, tier, maxTokens, system, userMessage);
      if (result) {
        if (provider !== PROVIDERS[0]) {
          console.info(`[llm] served by fallback provider: ${provider.name}`);
        }
        return result;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[llm] ${provider.name} failed — trying next provider (${msg})`);
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// Fallback generators (no LLM — deterministic templates)
// ---------------------------------------------------------------------------

export function fallbackQuickSummary(data: QuickScanData): string {
  const flags: string[] = [];
  if (data.has_rug_history) flags.push("rug history");
  if (!data.mint_authority_revoked) flags.push("mint authority active");
  if (!data.freeze_authority_revoked) flags.push("freeze authority active");
  if (data.top_10_holder_pct !== null && data.top_10_holder_pct > 80)
    flags.push(`top-10 own ${data.top_10_holder_pct.toFixed(1)}%`);

  const liq = data.liquidity_usd !== null
    ? `$${data.liquidity_usd.toLocaleString("en-US", { maximumFractionDigits: 0 })} liquidity`
    : "liquidity unknown";
  const conf = data.data_confidence !== "HIGH" ? ` (${data.data_confidence.toLowerCase()} confidence)` : "";
  const flagStr = flags.length > 0 ? `${flags.join(", ")}; ` : "";
  return `${flagStr}${liq}; risk grade ${data.risk_grade}${conf}.`;
}

export function fallbackDeepReport(data: DeepDiveData): string {
  const gradeDesc: Record<string, string> = {
    A: "low-risk", B: "moderate-risk", C: "elevated-risk", D: "high-risk", F: "critical-risk",
  };
  const sentences: string[] = [];

  sentences.push(
    `This token carries a ${gradeDesc[data.risk_grade] ?? "unknown-risk"} profile (grade ${data.risk_grade}); recommendation: ${data.recommendation}.`
  );

  const authIssues: string[] = [];
  if (!data.mint_authority_revoked) authIssues.push("mint authority active");
  if (!data.freeze_authority_revoked) authIssues.push("freeze authority active");
  if (authIssues.length > 0) {
    sentences.push(`Authority risk: ${authIssues.join(" and ")}.`);
  } else {
    sentences.push("Both mint and freeze authorities are revoked — supply is fixed.");
  }

  const liq = data.liquidity_usd !== null
    ? `$${data.liquidity_usd.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
    : "unknown";
  const vol = data.volume_24h > 0
    ? `$${data.volume_24h.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
    : "minimal";
  sentences.push(`Liquidity: ${liq}; 24 h volume: ${vol}; momentum ${data.momentum_score}/100.`);

  const risks: string[] = [];
  if (data.has_rug_history) risks.push("prior rug");
  if (data.pump_fun_launched) risks.push("pump.fun launch");
  if (data.bundled_launch_detected) risks.push("bundled launch");
  if (data.top_10_holder_pct !== null && data.top_10_holder_pct > 80)
    risks.push(`top-10 control ${data.top_10_holder_pct.toFixed(1)}%`);
  if (risks.length > 0) sentences.push(`Risk signals: ${risks.join(", ")}.`);

  if (data.data_confidence !== "HIGH") {
    sentences.push(`Data confidence is ${data.data_confidence.toLowerCase()} — treat analysis conservatively.`);
  }

  return sentences.join(" ");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a concise one-sentence analyst summary for a quick scan result.
 * Tries Anthropic Haiku first, falls back to Groq Llama, then template.
 */
export async function generateQuickScanSummary(data: QuickScanData): Promise<string> {
  const system =
    "You are a concise on-chain security analyst. Write one short sentence (under 30 words) explaining WHY this Solana token received its risk grade. Reference the most impactful scoring factor from the factors list. If grade is F, lead with the primary failure reason. Do not start with 'This token'. Never use qualifiers like 'appears to'.";

  const topFactors = [...(data.factors ?? [])]
    .sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact))
    .slice(0, 3);

  const factorLines = topFactors.length > 0
    ? `\n\nTop scoring factors:\n${topFactors.map(f => `- ${f.name}: ${f.value} (impact: ${f.impact}) — ${f.interpretation}`).join("\n")}`
    : "";

  const liq = data.liquidity_usd !== null
    ? `$${data.liquidity_usd.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
    : "unknown";
  const userMsg = `Risk grade: ${data.risk_grade}. Liquidity: ${liq}. Mint revoked: ${data.mint_authority_revoked}. Freeze revoked: ${data.freeze_authority_revoked}. Rug history: ${data.has_rug_history ?? false}. Top-10 holders: ${data.top_10_holder_pct !== null ? data.top_10_holder_pct.toFixed(1) + "%" : "unknown"}. Confidence: ${data.data_confidence}.${factorLines}`;

  const result = await callWithFallback("fast", 80, system, userMsg);
  return result || fallbackQuickSummary(data);
}

// ---------------------------------------------------------------------------
// Wallet risk types + generators
// ---------------------------------------------------------------------------

export interface WalletRiskData {
  classification?: "LOW_RISK" | "HIGH_RISK" | "UNKNOWN";
  activity?: {
    wallet_age_days: number | null;
    wallet_age_source?: "birdeye_first_funded" | "rpc_full" | "rpc_partial" | "failed";
    total_trades: number;
    trade_count_source?: "birdeye_pnl" | "helius_fetch";
    active_days_last_30d: number | null;
    last_active_hours_ago: number | null;
  };
  wallet_age_days: number | null;
  trading_style: string;
  win_rate_pct: number | null;
  sniper_score: number;
  rug_exit_rate_pct: number | null;
  funding_wallet_risk: string;
  risk_score: number;
  is_bot: boolean;
  pnl_estimate_30d_usdc: number | null;
  /** Realized PnL from Birdeye — passed explicitly so the LLM can reference it. */
  pnl_realized_usdc?: number | null;
  /** Total PnL (realized + unrealized) from Birdeye. */
  pnl_total_usdc?: number | null;
  copy_trading_worthiness?: string;
  behavior_style?: string;
  factors?: ScoringFactor[];
}

export function fallbackWalletRiskSummary(data: WalletRiskData): string {
  const cls = data.classification ?? "UNKNOWN";
  const age = data.activity?.wallet_age_days != null
    ? `${data.activity.wallet_age_days}d old`
    : data.wallet_age_days != null ? `${Math.round(data.wallet_age_days)}d old` : "age unknown";
  const trades = data.activity?.total_trades ?? 0;
  if (cls === "UNKNOWN") {
    return `Classified UNKNOWN — insufficient history (${trades} trades, ${age}); no strong malicious signals detected.`;
  }
  return `${cls === "HIGH_RISK" ? "High" : "Low"} counterparty risk (${age}, ${trades} trades).`;
}

export async function generateWalletRiskSummary(data: WalletRiskData): Promise<string> {
  const isHodler = data.trading_style === "hodler";

  const system = isHodler
    ? "You are a DeFi counterparty risk analyst. This wallet is a long-term holder with no sell transactions — win rate is inapplicable. Output exactly one sentence describing: (1) how long the wallet has held, (2) unrealized position size if known, (3) counterparty risk classification. Never say 'win rate unknown' for hodlers — instead say 'no exits recorded'. Never use 'strong', 'safe', or 'excellent'."
    : "You are a DeFi counterparty risk analyst. Output exactly one sentence assessing wallet risk. Reference the most impactful risk factor from the factors list when available. Never hedge or use qualifiers like 'appears to' or 'may be'. Be specific and direct. Never use 'strong', 'safe', or 'excellent'.";

  const topFactors = [...(data.factors ?? [])]
    .sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact))
    .slice(0, 3);

  const factorLines = topFactors.length > 0
    ? `\n\nTop risk factors:\n${topFactors.map(f => `- ${f.name}: ${f.value} (impact: ${f.impact}) — ${f.interpretation}`).join("\n")}`
    : "";

  const winRateLine = isHodler
    ? "Trading pattern: long-term holder — no sell transactions recorded, win rate not applicable."
    : `Win rate: ${data.win_rate_pct != null ? data.win_rate_pct.toFixed(0) + "%" : "unknown"}.`;

  const pnlLine = data.pnl_realized_usdc != null
    ? `Realized PnL: $${Math.round(data.pnl_realized_usdc).toLocaleString()}.`
    : data.pnl_estimate_30d_usdc != null
      ? `30d PnL estimate: $${Math.round(data.pnl_estimate_30d_usdc).toLocaleString()}.`
      : "PnL: unknown.";
  const totalPnlLine = data.pnl_total_usdc != null
    ? `Total PnL (realized + unrealized): $${Math.round(data.pnl_total_usdc).toLocaleString()}.`
    : "";
  const copyTradeLine = data.copy_trading_worthiness
    ? `Copy-trade worthiness: ${data.copy_trading_worthiness}.`
    : "";

  const userMsg = [
    `Wallet age: ${data.wallet_age_days != null ? Math.round(data.wallet_age_days) + " days" : "unknown"}.`,
    `Trading style: ${data.trading_style}.`,
    data.behavior_style ? `Behavior profile: ${data.behavior_style}.` : "",
    winRateLine,
    `Sniper score: ${data.sniper_score}/100.`,
    `Rug exit rate: ${data.rug_exit_rate_pct != null ? data.rug_exit_rate_pct.toFixed(0) + "%" : "not applicable (no exits)"}.`,
    `Funding risk: ${data.funding_wallet_risk}.`,
    `Risk score: ${data.risk_score}/100.`,
    `Is bot: ${data.is_bot}.`,
    pnlLine,
    totalPnlLine,
    copyTradeLine,
    factorLines,
  ].filter(Boolean).join(" ");

  const result = await callWithFallback("fast", 80, system, userMsg);
  return result || fallbackWalletRiskSummary(data);
}

// ---------------------------------------------------------------------------
// Market intel types + generators
// ---------------------------------------------------------------------------

export interface MarketIntelData {
  current_price_usd: number;
  price_change_1h_pct: number;
  price_change_24h_pct: number;
  volume_1h_usd: number;
  volume_24h_usd: number;
  buy_pressure: string;
  sell_pressure: string;
  large_txs_last_hour: number;
  signal: string;
  signal_score?: number;
  token_health?: string;
  pct_from_ath?: number | null;
  signal_subtype?: string;
  factors?: ScoringFactor[];
  name?: string | null;
  symbol?: string | null;
}

// Forbidden words that contradict ACTIVE token health or use hyperbolic language
const MARKET_SUMMARY_FORBIDDEN = [
  "eliminated", "destroyed", "failed project", "abandoned",
  "worthless", "untradeable", "dead", "rug", "rugged",
  "wiped out", "obliterated", "catastrophic", "devastating",
];

function validateMarketSummary(text: string, tokenHealth?: string): boolean {
  const lower = text.toLowerCase();
  // Always block forbidden words
  if (MARKET_SUMMARY_FORBIDDEN.some(w => lower.includes(w))) return false;
  // Extra check: ACTIVE tokens must not be described negatively in absolute terms
  if (tokenHealth === "ACTIVE") {
    if (["collapse", "crash", "plummet"].some(w => lower.includes(w))) return false;
  }
  return true;
}

export function fallbackMarketIntelSummary(data: MarketIntelData): string {
  const tokenId = data.symbol ?? data.name ?? "Token";
  const dir = data.signal === "BULLISH" ? "Bullish" : data.signal === "BEARISH" ? "Bearish" : "Neutral";
  const vol = data.volume_1h_usd > 0 ? `$${(data.volume_1h_usd / 1000).toFixed(0)}k 1h volume` : "volume unknown";
  const scorePart = data.signal_score != null ? ` (score ${data.signal_score > 0 ? "+" : ""}${data.signal_score})` : "";
  const healthPart = data.token_health ? `; token health ${data.token_health}` : "";
  return `${tokenId}: ${dir} signal${scorePart} — ${vol}, ${data.buy_pressure.toLowerCase()} buy pressure${healthPart}.`;
}

export async function generateMarketIntelSummary(data: MarketIntelData): Promise<string> {
  const tokenId = data.symbol ?? data.name ?? null;
  const tokenLabel = tokenId ? `$${tokenId}` : "this token";
  const system =
    `You are a Solana market analyst writing one short paragraph for AI trading agents about ${tokenLabel}. ` +
    `Always refer to the token as ${tokenLabel} — never as "SOLANA token" or "this token". ` +
    "You receive structured market data including token_health, signal, and factors[]. " +
    "Your summary MUST be consistent with the structured fields — never contradict them. " +
    "If token_health is ACTIVE, do not describe the token as rugged, dead, or worthless. " +
    "If token_health is DEAD or ILLIQUID, lead with that fact. " +
    "Reference the most impactful factor from the factors list. Be specific with numbers. " +
    "Never use 'strong', 'safe', or 'excellent'. Never hedge. Output only the paragraph.";

  const topFactors = [...(data.factors ?? [])]
    .sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact))
    .slice(0, 3);

  const factorLines = topFactors.length > 0
    ? `\n\nTop signal factors:\n${topFactors.map(f => `- ${f.name}: ${f.value} (impact: ${f.impact}) — ${f.interpretation}`).join("\n")}`
    : "";

  const athLine = data.pct_from_ath != null
    ? `Down ${Math.abs(data.pct_from_ath).toFixed(0)}% from ATH.`
    : "";

  const userMsg = [
    tokenId ? `Token: ${tokenId}.` : "",
    `Price: $${data.current_price_usd}.`,
    `1h change: ${data.price_change_1h_pct.toFixed(2)}%.`,
    `24h change: ${data.price_change_24h_pct.toFixed(2)}%.`,
    `1h volume: $${(data.volume_1h_usd / 1000).toFixed(0)}k.`,
    `24h volume: $${(data.volume_24h_usd / 1000).toFixed(0)}k.`,
    `Buy pressure: ${data.buy_pressure}. Sell pressure: ${data.sell_pressure}.`,
    `Large txs (>$10k) last hour: ${data.large_txs_last_hour}.`,
    `Signal: ${data.signal}.`,
    data.signal_subtype ? `Signal subtype: ${data.signal_subtype}.` : "",
    data.token_health ? `Token health: ${data.token_health}.` : "",
    athLine,
    factorLines,
  ].filter(Boolean).join(" ");

  let result = await callWithFallback("fast", 300, system, userMsg);

  // Post-generation validation: block forbidden language and health contradictions
  if (result && !validateMarketSummary(result, data.token_health)) {
    result = ""; // fall through to deterministic fallback
  }

  // Truncation check: if the LLM response doesn't end with a sentence-terminating
  // character, it was likely cut off by max_tokens — fall back to deterministic
  if (result && !/[.!?]$/.test(result.trim())) {
    result = ""; // fall through to deterministic fallback
  }

  return result || fallbackMarketIntelSummary(data);
}

// ---------------------------------------------------------------------------
// Deep dive generator
// ---------------------------------------------------------------------------

/**
 * Generate a 3–5 sentence analyst report for a deep dive result.
 * Tries Anthropic Sonnet first, falls back to Groq Mixtral, then template.
 */
export async function generateDeepDiveReport(data: DeepDiveData): Promise<string> {
  const tokenId = data.symbol ?? data.name ?? null;
  const tokenLabel = tokenId ? `$${tokenId}` : "this token";
  const system =
    `You are a professional on-chain security analyst. Write a 3–5 sentence risk report for ${tokenLabel}. ` +
    `Always refer to the token as ${tokenLabel} — never as "this token" or "the token". ` +
    "Use the scoring factors list as your primary evidence — explain which factors drove the score and how they combine. Connect related risks into patterns rather than listing fields independently. State the recommendation and the single strongest reason for it in the final sentence. Be specific, factual, and concise. Do not use bullet points.";

  const topFactors = [...(data.factors ?? [])]
    .sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact))
    .slice(0, 5);

  const factorLines = topFactors.length > 0
    ? `\n\nTop scoring factors:\n${topFactors.map(f => `- ${f.name}: ${f.value} (impact: ${f.impact}) — ${f.interpretation}`).join("\n")}`
    : "";

  const liq = data.liquidity_usd !== null
    ? `$${data.liquidity_usd.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
    : "unknown";
  const vol = data.volume_24h > 0
    ? `$${data.volume_24h.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
    : "minimal";

  const userMsg = [
    tokenId ? `Token: ${tokenId}.` : "",
    `Risk grade: ${data.risk_grade}. Recommendation: ${data.recommendation}.`,
    `Mint revoked: ${data.mint_authority_revoked}. Freeze revoked: ${data.freeze_authority_revoked}.`,
    `Rug history: ${data.has_rug_history}.`,
    `Liquidity: ${liq}. 24h volume: ${vol}. Momentum score: ${data.momentum_score}/100.`,
    `Pump.fun: ${data.pump_fun_launched}. Bundled launch: ${data.bundled_launch_detected}.`,
    `Top-10 holders: ${data.top_10_holder_pct !== null ? data.top_10_holder_pct.toFixed(1) + "%" : "unknown"}.`,
    `Data confidence: ${data.data_confidence}.`,
    data.historical_flags && data.historical_flags.length > 0
      ? `Historical flags: ${data.historical_flags.join(", ")}.`
      : "",
    factorLines,
  ].filter(Boolean).join(" ");

  const result = await callWithFallback("deep", 300, system, userMsg);
  return result || fallbackDeepReport(data);
}
