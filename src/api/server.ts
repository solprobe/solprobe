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

  const result = await quickScan(address);
  return c.json(result);
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

  const result = await deepDive(address);
  return c.json(result);
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

  const result = await walletRisk(address);
  return c.json(result);
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

  const result = await marketIntel(address);
  return c.json(result);
});

app.get("/revenue/summary", (c) => {
  return c.json(getRevenueSummary());
});

app.get("/health", (c) => {
  const breakers = getBreakerStates();
  const anyOpen = Object.values(breakers).some((s) => s === "OPEN");
  return c.json({
    status: anyOpen ? "degraded" : "ok",
    uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
    ...getCacheStats(),
    circuit_breakers: breakers,
  });
});

const port = parseInt(process.env.PORT ?? "8000");

serve({ fetch: app.fetch, hostname: "0.0.0.0", port }, () => {
  console.log(`SolProbe listening on http://0.0.0.0:${port}`);
});
