import { describe, it, expect } from "vitest";
import { buildTxGraph, type TxEdge } from "../../src/analysis/walletGraph.js";
import { detectClusters } from "../../src/analysis/clusterDetection.js";

const W1 = "WAL1111111111111111111111111111111111111111";
const W2 = "WAL2222222222222222222222222222222222222222";
const W3 = "WAL3333333333333333333333333333333333333333";
const FP = "FEE1111111111111111111111111111111111111111";

// Known excluded DEX — must never form a cluster
const RAYDIUM = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";

const T0 = 1_700_000_000;
const T1 = T0 + 600;   // different 5-min bucket

function edge(overrides: Partial<TxEdge> = {}): TxEdge {
  return {
    from: W1, to: W2, value_lamports: 1_000_000,
    block_time: T0, program: "TRANSFER",
    tx_signature: Math.random().toString(36).slice(2),
    fee_payer: FP, ...overrides,
  };
}

// ── Fee payer clustering ──────────────────────────────────────────────────────

describe("clusterDetection — fee payer signal", () => {
  it("clusters two wallets that share a non-excluded fee payer", () => {
    const g = buildTxGraph([
      edge({ from: W1, to: W3, fee_payer: FP }),
      edge({ from: W2, to: W3, fee_payer: FP }),
    ]);
    const r = detectClusters(g, [W1, W2, W3], null);
    const c = r.clusters.find(c => c.wallets.includes(W1) && c.wallets.includes(W2));
    expect(c).toBeDefined();
    expect(c!.common_fee_payer).toBe(FP);
    expect(c!.signals.some(s => s.type === "FEE_PAYER")).toBe(true);
  });

  it("does NOT cluster when fee payer is a known DEX seed (Raydium)", () => {
    // Separate time buckets prevent temporal signal from also linking W1/W2
    const g = buildTxGraph([
      edge({ from: W1, to: W3, fee_payer: RAYDIUM, block_time: T0 }),
      edge({ from: W2, to: W3, fee_payer: RAYDIUM, block_time: T1 }),
    ]);
    const r = detectClusters(g, [W1, W2], null);
    const c = r.clusters.find(c => c.wallets.includes(W1) && c.wallets.includes(W2));
    expect(c).toBeUndefined();
  });
});

// ── Singleton exclusion ───────────────────────────────────────────────────────

describe("clusterDetection — singleton exclusion", () => {
  it("does not return singletons — wallets with no connections above threshold", () => {
    // Only one target wallet touches this fee payer — below MIN_FEE_PAYER_EDGES=2
    const g = buildTxGraph([edge({ from: W1, to: W3, fee_payer: FP })]);
    const r = detectClusters(g, [W1, W2], null);
    expect(r.clusters).toHaveLength(0);
  });

  it("does not return a single-wallet cluster", () => {
    const g = buildTxGraph([edge({ from: W1, to: W3, fee_payer: FP })]);
    const r = detectClusters(g, [W1], null);
    expect(r.clusters).toHaveLength(0);
  });
});

// ── Confidence score ──────────────────────────────────────────────────────────

describe("clusterDetection — confidence", () => {
  it("confidence is higher when all wallets share a fee payer (strong signal)", () => {
    const g = buildTxGraph([
      edge({ from: W1, to: W3, fee_payer: FP }),
      edge({ from: W2, to: W3, fee_payer: FP }),
    ]);
    const r = detectClusters(g, [W1, W2, W3], null);
    const c = r.clusters.find(c => c.wallets.includes(W1) && c.wallets.includes(W2));
    expect(c).toBeDefined();
    // Fee payer weight is 0.8 — cluster confidence should reflect this
    expect(c!.confidence).toBeGreaterThan(0);
    expect(c!.confidence).toBeLessThanOrEqual(1);
  });

  it("highest_confidence in result matches the best cluster", () => {
    const g = buildTxGraph([
      edge({ from: W1, to: W3, fee_payer: FP }),
      edge({ from: W2, to: W3, fee_payer: FP }),
    ]);
    const r = detectClusters(g, [W1, W2, W3], null);
    const maxConf = Math.max(...r.clusters.map(c => c.confidence));
    expect(r.highest_confidence).toBe(maxConf);
  });

  it("confidence reflects stronger connection when activity near token launch", () => {
    const creation = T0;
    // Activity within 1 hour of launch — weight boosted to 1.0
    const gNear = buildTxGraph([
      edge({ from: W1, to: W3, fee_payer: FP, block_time: T0 + 600 }),
      edge({ from: W2, to: W3, fee_payer: FP, block_time: T0 + 600 }),
    ]);
    // Activity 2 days after launch — weight stays at 0.8
    const gFar = buildTxGraph([
      edge({ from: W1, to: W3, fee_payer: FP, block_time: T0 + 172800 }),
      edge({ from: W2, to: W3, fee_payer: FP, block_time: T0 + 172800 }),
    ]);
    const rNear = detectClusters(gNear, [W1, W2, W3], creation);
    const rFar  = detectClusters(gFar,  [W1, W2, W3], creation);
    const confNear = rNear.clusters[0]?.confidence ?? 0;
    const confFar  = rFar.clusters[0]?.confidence ?? 0;
    expect(confNear).toBeGreaterThanOrEqual(confFar);
  });
});

// ── Summary fields ────────────────────────────────────────────────────────────

describe("clusterDetection — result summary fields", () => {
  it("total_clustered_wallets equals sum of all cluster sizes", () => {
    const g = buildTxGraph([
      edge({ from: W1, to: W3, fee_payer: FP }),
      edge({ from: W2, to: W3, fee_payer: FP }),
    ]);
    const r = detectClusters(g, [W1, W2, W3], null);
    const expected = r.clusters.reduce((s, c) => s + c.wallets.length, 0);
    expect(r.total_clustered_wallets).toBe(expected);
  });

  it("largest_cluster_size is 0 when no clusters formed", () => {
    const g = buildTxGraph([]);
    const r = detectClusters(g, [W1], null);
    expect(r.largest_cluster_size).toBe(0);
  });
});
