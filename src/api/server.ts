import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { isValidSolanaAddress } from "../validate.js";
import { quickScan } from "../scanner/quickScan.js";
import { deepDive } from "../scanner/deepDive.js";
import { walletRisk } from "../scanner/walletRisk.js";
import { marketIntel } from "../scanner/marketIntel.js";
import { getBreakerStates } from "../circuitBreaker.js";
import { getCacheStats } from "../cache.js";

const app = new Hono();
const startTime = Date.now();

app.post("/scan/quick", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "INVALID_ADDRESS", data_confidence: "LOW" }, 400);
  }

  const address = body?.token_address;
  if (typeof address !== "string" || !isValidSolanaAddress(address)) {
    return c.json({ error: "INVALID_ADDRESS", data_confidence: "LOW" }, 400);
  }

  const result = await quickScan(address);
  return c.json(result);
});

app.post("/scan/deep", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "INVALID_ADDRESS", data_confidence: "LOW" }, 400);
  }

  const address = body?.token_address;
  if (typeof address !== "string" || !isValidSolanaAddress(address)) {
    return c.json({ error: "INVALID_ADDRESS", data_confidence: "LOW" }, 400);
  }

  const result = await deepDive(address);
  return c.json(result);
});

app.post("/wallet/risk", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "INVALID_ADDRESS", data_confidence: "LOW" }, 400);
  }

  const address = body?.wallet_address;
  if (typeof address !== "string" || !isValidSolanaAddress(address)) {
    return c.json({ error: "INVALID_ADDRESS", data_confidence: "LOW" }, 400);
  }

  const result = await walletRisk(address);
  return c.json(result);
});

app.post("/market/intel", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "INVALID_ADDRESS", data_confidence: "LOW" }, 400);
  }

  const address = body?.token_address;
  if (typeof address !== "string" || !isValidSolanaAddress(address)) {
    return c.json({ error: "INVALID_ADDRESS", data_confidence: "LOW" }, 400);
  }

  const result = await marketIntel(address);
  return c.json(result);
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
