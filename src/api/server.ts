import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { isValidSolanaAddress } from "../validate.js";
import { quickScan } from "../scanner/quickScan.js";
import { deepDive } from "../scanner/deepDive.js";
import { walletRisk } from "../scanner/walletRisk.js";
import { marketIntel } from "../scanner/marketIntel.js";
import { getBreakerStates } from "../circuitBreaker.js";
import { getCacheStats } from "../cache.js";
import { revenueMiddleware, getRevenueSummary } from "../revenueTracker.js";
import { checkRateLimit } from "./rateLimiter.js";
import { getSourceStats } from "../sources/resolver.js";

// ---------------------------------------------------------------------------
// SLA enforcement helper
// ---------------------------------------------------------------------------

class SlaExceededError extends Error {}

async function withSlaDeadline<T>(fn: () => Promise<T>, deadlineMs: number): Promise<T> {
  return Promise.race([
    fn(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new SlaExceededError()), deadlineMs)
    ),
  ]);
}

const SLA_DEADLINE_MS = {
  quick:  4_500,
  deep:  28_000,
  wallet: 9_000,
  intel:  9_000,
} as const;

const app = new Hono();

// ── 1. Body size cap ────────────────────────────────────────────────────────
app.use("*", async (c, next) => {
  const contentLength = c.req.header("content-length");
  if (contentLength && parseInt(contentLength, 10) > 1024) {
    return c.json({ error: "PAYLOAD_TOO_LARGE" }, 413);
  }
  return next();
});

// ── 2. Rate limiter (scan / wallet / market only — /health stays open) ──────
app.use("/scan/*", async (c, next) => {
  const ip = c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? "unknown";
  if (!checkRateLimit(ip)) {
    return c.json({ error: "RATE_LIMITED", message: "Too many requests" }, 429);
  }
  return next();
});

app.use("/wallet/*", async (c, next) => {
  const ip = c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? "unknown";
  if (!checkRateLimit(ip)) {
    return c.json({ error: "RATE_LIMITED", message: "Too many requests" }, 429);
  }
  return next();
});

app.use("/market/*", async (c, next) => {
  const ip = c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? "unknown";
  if (!checkRateLimit(ip)) {
    return c.json({ error: "RATE_LIMITED", message: "Too many requests" }, 429);
  }
  return next();
});

// ── 3. Revenue middleware ────────────────────────────────────────────────────
app.use(revenueMiddleware);

const startTime = Date.now();

// ── Route handlers ───────────────────────────────────────────────────────────

app.post("/scan/quick", async (c) => {
  const body = await c.req.json().catch(() => null);
  const address = body?.token_address;

  if (
    !body ||
    address === undefined ||
    address === null ||
    typeof address !== "string" ||
    address.length === 0 ||
    address.length < 32 ||
    address.length > 44 ||
    !isValidSolanaAddress(address)
  ) {
    return c.json(
      {
        error: "INVALID_ADDRESS",
        message:
          "token_address must be a valid Solana base58 address (32–44 chars)",
        data_confidence: "LOW",
      },
      400
    );
  }

  try {
    const result = await withSlaDeadline(() => quickScan(address), SLA_DEADLINE_MS.quick);
    return c.json(result);
  } catch (err) {
    if (err instanceof SlaExceededError) {
      return c.json({ error: true, message: "SLA deadline exceeded", retry_suggested: true, data_confidence: "NONE" }, 503);
    }
    throw err;
  }
});

app.post("/scan/deep", async (c) => {
  const body = await c.req.json().catch(() => null);
  const address = body?.token_address;

  if (
    !body ||
    address === undefined ||
    address === null ||
    typeof address !== "string" ||
    address.length === 0 ||
    address.length < 32 ||
    address.length > 44 ||
    !isValidSolanaAddress(address)
  ) {
    return c.json(
      {
        error: "INVALID_ADDRESS",
        message:
          "token_address must be a valid Solana base58 address (32–44 chars)",
        data_confidence: "LOW",
      },
      400
    );
  }

  try {
    const result = await withSlaDeadline(() => deepDive(address), SLA_DEADLINE_MS.deep);
    return c.json(result);
  } catch (err) {
    if (err instanceof SlaExceededError) {
      return c.json({ error: true, message: "SLA deadline exceeded", retry_suggested: true, data_confidence: "NONE" }, 503);
    }
    throw err;
  }
});

app.post("/wallet/risk", async (c) => {
  const body = await c.req.json().catch(() => null);
  const address = body?.wallet_address;

  if (
    !body ||
    address === undefined ||
    address === null ||
    typeof address !== "string" ||
    address.length === 0 ||
    address.length < 32 ||
    address.length > 44 ||
    !isValidSolanaAddress(address)
  ) {
    return c.json(
      {
        error: "INVALID_ADDRESS",
        message:
          "wallet_address must be a valid Solana base58 address (32–44 chars)",
        data_confidence: "LOW",
      },
      400
    );
  }

  try {
    const result = await withSlaDeadline(() => walletRisk(address), SLA_DEADLINE_MS.wallet);
    return c.json(result);
  } catch (err) {
    if (err instanceof SlaExceededError) {
      return c.json({ error: true, message: "SLA deadline exceeded", retry_suggested: true, data_confidence: "NONE" }, 503);
    }
    throw err;
  }
});

app.post("/market/intel", async (c) => {
  const body = await c.req.json().catch(() => null);
  const address = body?.token_address;

  if (
    !body ||
    address === undefined ||
    address === null ||
    typeof address !== "string" ||
    address.length === 0 ||
    address.length < 32 ||
    address.length > 44 ||
    !isValidSolanaAddress(address)
  ) {
    return c.json(
      {
        error: "INVALID_ADDRESS",
        message:
          "token_address must be a valid Solana base58 address (32–44 chars)",
        data_confidence: "LOW",
      },
      400
    );
  }

  try {
    const result = await withSlaDeadline(() => marketIntel(address), SLA_DEADLINE_MS.intel);
    return c.json(result);
  } catch (err) {
    if (err instanceof SlaExceededError) {
      return c.json({ error: true, message: "SLA deadline exceeded", retry_suggested: true, data_confidence: "NONE" }, 503);
    }
    throw err;
  }
});

app.get("/revenue/summary", (c) => {
  return c.json(getRevenueSummary());
});

app.get("/health", (c) => {
  const breakers = getBreakerStates();
  const sourceStats = getSourceStats();
  const criticalDown = (["dexscreener", "helius_rpc"] as const).filter(
    (s) => breakers[s] === "OPEN"
  );
  return c.json({
    status: criticalDown.length > 0 ? "degraded" : "ok",
    uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
    ...getCacheStats(),
    degraded_sources: criticalDown,
    circuit_breakers: breakers,
    source_success_rates: Object.fromEntries(
      Object.entries(sourceStats).map(([k, v]) => [k, v.successRate])
    ),
  });
});

const port = parseInt(process.env.PORT ?? "8000");

// Warn at startup if both LLM providers are unconfigured — scans will fall back
// to deterministic templates rather than analyst prose.
if (!process.env.ANTHROPIC_API_KEY && !process.env.GROQ_API_KEY) {
  console.warn("[startup] WARNING: neither ANTHROPIC_API_KEY nor GROQ_API_KEY is set — LLM summaries will use template fallbacks");
}

serve({ fetch: app.fetch, hostname: "0.0.0.0", port }, () => {
  console.log(`SolProbe listening on http://0.0.0.0:${port}`);
});
