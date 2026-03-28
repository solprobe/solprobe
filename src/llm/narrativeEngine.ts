// ---------------------------------------------------------------------------
// LLM Narrative Engine
// Generates analyst-quality summaries with a two-provider cascade:
//   1. Anthropic (Haiku / Sonnet) — primary
//   2. Groq (Llama / Mixtral)    — fallback
// Both public functions are fully fault-tolerant — they always return a
// string, even when all API keys are absent or every call fails.
// ---------------------------------------------------------------------------

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
  is_honeypot: boolean;
  mint_authority_revoked: boolean;
  freeze_authority_revoked: boolean;
  top_10_holder_pct: number | null;
  liquidity_usd: number | null;
  risk_grade: string;
  data_confidence: string;
  has_rug_history?: boolean;
  authority_exempt?: boolean;
  authority_exempt_reason?: string | null;
}

export interface DeepDiveData {
  risk_grade: string;
  is_honeypot: boolean;
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
  rugcheck_risk_score?: number | null;
  insider_flags?: boolean;
  authority_exempt?: boolean;
  authority_exempt_reason?: string | null;
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
  if (data.is_honeypot) flags.push("honeypot detected");
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
  if (data.is_honeypot) risks.push("honeypot pattern");
  if (data.has_rug_history) risks.push("prior rug");
  if (data.pump_fun_launched) risks.push("pump.fun launch");
  if (data.bundled_launch_detected) risks.push("bundled launch");
  if (data.insider_flags) risks.push("insider activity");
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
    "You are a concise on-chain security analyst. Write one short sentence (under 30 words) summarising the risk profile of this Solana token. Be direct and specific — mention the most important risk signal. Do not start with 'This token'.";

  const liq = data.liquidity_usd !== null
    ? `$${data.liquidity_usd.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
    : "unknown";
  const userMsg = `Risk grade: ${data.risk_grade}. Liquidity: ${liq}. Mint revoked: ${data.mint_authority_revoked}. Freeze revoked: ${data.freeze_authority_revoked}. Honeypot: ${data.is_honeypot}. Rug history: ${data.has_rug_history ?? false}. Top-10 holders: ${data.top_10_holder_pct !== null ? data.top_10_holder_pct.toFixed(1) + "%" : "unknown"}. Confidence: ${data.data_confidence}.`;

  const result = await callWithFallback("fast", 80, system, userMsg);
  return result || fallbackQuickSummary(data);
}

// ---------------------------------------------------------------------------
// Wallet risk types + generators
// ---------------------------------------------------------------------------

export interface WalletRiskData {
  wallet_age_days: number | null;
  trading_style: string;
  win_rate_pct: number | null;
  sniper_score: number;
  rug_exit_rate_pct: number | null;
  funding_wallet_risk: string;
  risk_score: number;
  is_bot: boolean;
  pnl_estimate_30d_usdc: number | null;
}

export function fallbackWalletRiskSummary(data: WalletRiskData): string {
  const style = data.trading_style;
  const risk = data.risk_score > 70 ? "high" : data.risk_score > 40 ? "moderate" : "low";
  const age = data.wallet_age_days != null ? `${Math.round(data.wallet_age_days)}d old` : "age unknown";
  return `${style.charAt(0).toUpperCase() + style.slice(1)} wallet (${age}) — ${risk} counterparty risk score ${data.risk_score}/100.`;
}

export async function generateWalletRiskSummary(data: WalletRiskData): Promise<string> {
  const system =
    "You are a DeFi counterparty risk analyst. Output exactly one sentence assessing wallet risk. Never hedge or use qualifiers like 'appears to' or 'may be'. Be specific and direct.";

  const userMsg = [
    `Wallet age: ${data.wallet_age_days != null ? Math.round(data.wallet_age_days) + " days" : "unknown"}.`,
    `Trading style: ${data.trading_style}.`,
    `Win rate: ${data.win_rate_pct != null ? data.win_rate_pct.toFixed(0) + "%" : "unknown"}.`,
    `Sniper score: ${data.sniper_score}/100.`,
    `Rug exit rate: ${data.rug_exit_rate_pct != null ? data.rug_exit_rate_pct.toFixed(0) + "%" : "unknown"}.`,
    `Funding risk: ${data.funding_wallet_risk}.`,
    `Risk score: ${data.risk_score}/100.`,
    `Is bot: ${data.is_bot}.`,
    `30d PnL estimate: ${data.pnl_estimate_30d_usdc != null ? "$" + data.pnl_estimate_30d_usdc.toFixed(0) : "unknown"}.`,
  ].join(" ");

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
}

export function fallbackMarketIntelSummary(data: MarketIntelData): string {
  const dir = data.signal === "BULLISH" ? "Bullish" : data.signal === "BEARISH" ? "Bearish" : "Neutral";
  const vol = data.volume_1h_usd > 0 ? `$${(data.volume_1h_usd / 1000).toFixed(0)}k 1h volume` : "volume unknown";
  return `${dir} signal — ${vol}, ${data.buy_pressure.toLowerCase()} buy pressure.`;
}

export async function generateMarketIntelSummary(data: MarketIntelData): Promise<string> {
  const system =
    "You are a crypto market analyst. Output exactly one sentence summarising market conditions and their implication for a trade. Never hedge. Be specific with numbers.";

  const userMsg = [
    `Price: $${data.current_price_usd}.`,
    `1h change: ${data.price_change_1h_pct.toFixed(2)}%.`,
    `24h change: ${data.price_change_24h_pct.toFixed(2)}%.`,
    `1h volume: $${(data.volume_1h_usd / 1000).toFixed(0)}k.`,
    `24h volume: $${(data.volume_24h_usd / 1000).toFixed(0)}k.`,
    `Buy pressure: ${data.buy_pressure}. Sell pressure: ${data.sell_pressure}.`,
    `Large txs (>$10k) last hour: ${data.large_txs_last_hour}.`,
    `Signal: ${data.signal}.`,
  ].join(" ");

  const result = await callWithFallback("fast", 80, system, userMsg);
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
  const system =
    "You are a professional on-chain security analyst. Write a 3–5 sentence risk report for this Solana token. Cover: authority status, liquidity/volume health, key risk signals, and your recommendation. Be specific, factual, and concise. Do not use bullet points.";

  const liq = data.liquidity_usd !== null
    ? `$${data.liquidity_usd.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
    : "unknown";
  const vol = data.volume_24h > 0
    ? `$${data.volume_24h.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
    : "minimal";

  const userMsg = [
    `Risk grade: ${data.risk_grade}. Recommendation: ${data.recommendation}.`,
    `Mint revoked: ${data.mint_authority_revoked}. Freeze revoked: ${data.freeze_authority_revoked}.`,
    `Honeypot: ${data.is_honeypot}. Rug history: ${data.has_rug_history}.`,
    `Liquidity: ${liq}. 24h volume: ${vol}. Momentum score: ${data.momentum_score}/100.`,
    `Pump.fun: ${data.pump_fun_launched}. Bundled launch: ${data.bundled_launch_detected}. Insider flags: ${data.insider_flags ?? false}.`,
    `Top-10 holders: ${data.top_10_holder_pct !== null ? data.top_10_holder_pct.toFixed(1) + "%" : "unknown"}.`,
    `RugCheck score: ${data.rugcheck_risk_score ?? "n/a"}. Data confidence: ${data.data_confidence}.`,
  ].join(" ");

  const result = await callWithFallback("deep", 300, system, userMsg);
  return result || fallbackDeepReport(data);
}
