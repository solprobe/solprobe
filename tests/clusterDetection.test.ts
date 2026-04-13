import { describe, it, expect } from "vitest";
import { buildTxGraph, type TxEdge } from "../src/analysis/walletGraph.js";
import { detectClusters } from "../src/analysis/clusterDetection.js";

// ── Address fixtures ──────────────────────────────────────────────────────────
const W1 = "WAL1111111111111111111111111111111111111111";
const W2 = "WAL2222222222222222222222222222222222222222";
const W3 = "WAL3333333333333333333333333333333333333333";
const W4 = "WAL4444444444444444444444444444444444444444";
const W5 = "WAL5555555555555555555555555555555555555555";

const FP  = "FEE1111111111111111111111111111111111111111"; // custom fee payer
const FP2 = "FEE2222222222222222222222222222222222222222";

// Excluded DEX seed — must never form a cluster
const RAYDIUM = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";

// Temporal bucket = 300s. T0 and T0+600 are guaranteed to be in different buckets.
const T0  = 1_700_000_000;
const T1  = T0 + 600;   // next 5-min bucket
const T2  = T0 + 1200;  // two buckets away

function edge(overrides: Partial<TxEdge>): TxEdge {
  return {
    from: W1,
    to: W2,
    value_lamports: 1_000_000,
    block_time: T0,
    program: "TRANSFER",
    tx_signature: Math.random().toString(36).slice(2),
    fee_payer: FP,
    ...overrides,
  };
}

// ── Signal 1: Fee payer ───────────────────────────────────────────────────────

describe("Signal 1 — fee payer clustering", () => {
  it("clusters two wallets that share a non-excluded fee payer", () => {
    const edges = [
      edge({ from: W1, to: W3, fee_payer: FP, block_time: T0 }),
      edge({ from: W2, to: W3, fee_payer: FP, block_time: T0 }),
    ];
    const g = buildTxGraph(edges);
    const r = detectClusters(g, [W1, W2, W3], null);

    const c = r.clusters.find(c => c.wallets.includes(W1) && c.wallets.includes(W2));
    expect(c).toBeDefined();
    expect(c!.common_fee_payer).toBe(FP);
    expect(c!.signals.some(s => s.type === "FEE_PAYER")).toBe(true);
  });

  it("does NOT cluster when fee payer is a known DEX (Raydium) — wallets in separate time buckets", () => {
    // Separate buckets prevent temporal signal from also connecting W1/W2.
    // Only the fee payer signal could cluster them, but Raydium is excluded.
    const edges = [
      edge({ from: W1, to: W3, fee_payer: RAYDIUM, block_time: T0 }),
      edge({ from: W2, to: W3, fee_payer: RAYDIUM, block_time: T1 }),
    ];
    const g = buildTxGraph(edges);
    const r = detectClusters(g, [W1, W2], null);

    const c = r.clusters.find(c => c.wallets.includes(W1) && c.wallets.includes(W2));
    expect(c).toBeUndefined();
  });

  it("does NOT cluster when only one target wallet touches a fee payer (below MIN_FEE_PAYER_EDGES)", () => {
    const edges = [
      edge({ from: W1, to: W3, fee_payer: FP, block_time: T0 }),
    ];
    const g = buildTxGraph(edges);
    const r = detectClusters(g, [W1, W2], null);
    expect(r.clusters).toHaveLength(0);
  });

  it("boosts weight to 1.0 when activity is within 1 hour of token creation", () => {
    const creationTime = T0;
    const edges = [
      edge({ from: W1, to: W3, fee_payer: FP, block_time: T0 + 600 }),  // 10 min after launch
      edge({ from: W2, to: W3, fee_payer: FP, block_time: T0 + 600 }),
    ];
    const g = buildTxGraph(edges);
    const r = detectClusters(g, [W1, W2, W3], creationTime);

    const c = r.clusters.find(c => c.wallets.includes(W1) && c.wallets.includes(W2));
    expect(c).toBeDefined();
    // Weight boosted to 1.0 → confidence should be high
    expect(c!.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("uses weight 0.9 when activity is 1–24 hours after token creation", () => {
    const creationTime = T0;
    const edges = [
      edge({ from: W1, to: W3, fee_payer: FP, block_time: T0 + 7200 }),  // 2 hours after
      edge({ from: W2, to: W3, fee_payer: FP, block_time: T0 + 7200 }),
    ];
    const g = buildTxGraph(edges);
    const r = detectClusters(g, [W1, W2, W3], creationTime);

    const c = r.clusters.find(c => c.wallets.includes(W1) && c.wallets.includes(W2));
    expect(c).toBeDefined();
    expect(c!.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("clusters three wallets all sharing the same fee payer into one component", () => {
    const edges = [
      edge({ from: W1, to: W4, fee_payer: FP, block_time: T0 }),
      edge({ from: W2, to: W4, fee_payer: FP, block_time: T0 }),
      edge({ from: W3, to: W4, fee_payer: FP, block_time: T0 }),
    ];
    const g = buildTxGraph(edges);
    const r = detectClusters(g, [W1, W2, W3], null);

    expect(r.clusters).toHaveLength(1);
    expect(r.clusters[0].wallets).toHaveLength(3);
    expect(r.largest_cluster_size).toBe(3);
  });

  it("produces two separate clusters for two independent fee payer groups", () => {
    // Separate time buckets prevent temporal signal from bridging the two groups.
    const edges = [
      edge({ from: W1, to: W5, fee_payer: FP,  block_time: T0 }),
      edge({ from: W2, to: W5, fee_payer: FP,  block_time: T0 + 10 }),
      edge({ from: W3, to: W5, fee_payer: FP2, block_time: T1 }),
      edge({ from: W4, to: W5, fee_payer: FP2, block_time: T1 + 10 }),
    ];
    const g = buildTxGraph(edges);
    const r = detectClusters(g, [W1, W2, W3, W4], null);

    expect(r.clusters).toHaveLength(2);
    const ids1 = r.clusters[0].wallets;
    const ids2 = r.clusters[1].wallets;
    expect([...ids1, ...ids2].sort()).toEqual([W1, W2, W3, W4].sort());
  });
});

// ── Signal 2: Fan-out / fan-in ────────────────────────────────────────────────

describe("Signal 2 — fan-out/fan-in clustering", () => {
  it("clusters target wallets when a source fans out then receives returns within 24h", () => {
    const SOURCE = "SRC1111111111111111111111111111111111111111";
    const edges = [
      // SOURCE fans out to W1 and W2 in the same 5-min window
      edge({ from: SOURCE, to: W1, block_time: T0 + 10, fee_payer: "" }),
      edge({ from: SOURCE, to: W2, block_time: T0 + 20, fee_payer: "" }),
      // W1 returns to SOURCE within 24h
      edge({ from: W1, to: SOURCE, block_time: T0 + 3600, fee_payer: "" }),
    ];
    const g = buildTxGraph(edges);
    const r = detectClusters(g, [SOURCE, W1, W2], null);

    // W1 and W2 should be in the same cluster
    const c = r.clusters.find(c => c.wallets.includes(W1) && c.wallets.includes(W2));
    expect(c).toBeDefined();
  });

  it("does NOT cluster wallets when they only share a common intermediary at different times", () => {
    // SOURCE (not a targetWallet) sends to W1 and W2 in different buckets.
    // No temporal co-occurrence, no shared fee payer, no fan-out (SOURCE not target).
    const SOURCE = "SRC2222222222222222222222222222222222222222";
    const edges = [
      edge({ from: SOURCE, to: W1, block_time: T0,  fee_payer: "" }),
      edge({ from: SOURCE, to: W2, block_time: T1,  fee_payer: "" }),
    ];
    const g = buildTxGraph(edges);
    const r = detectClusters(g, [W1, W2], null); // SOURCE not in targetWallets

    const c = r.clusters.find(c => c.wallets.includes(W1) && c.wallets.includes(W2));
    expect(c).toBeUndefined();
  });

  it("does NOT cluster when fan-out source is a targetWallet but sends to targets in different buckets", () => {
    // SOURCE sends to W1 at T0, to W2 at T1 — they're in different buckets
    // so no fan-out (fan-out requires both targets in the same 5-min bucket).
    // No temporal W1–W2 connection either (different buckets).
    const SOURCE = "SRC3333333333333333333333333333333333333333";
    const edges = [
      edge({ from: SOURCE, to: W1, block_time: T0, fee_payer: "" }),
      edge({ from: SOURCE, to: W2, block_time: T1, fee_payer: "" }),
      // W1 returns within 24h of T0 — but only one target in that bucket so fan-out never fired
      edge({ from: W1, to: SOURCE, block_time: T0 + 3600, fee_payer: "" }),
    ];
    const g = buildTxGraph(edges);
    // Only W1 and W2 are targets — SOURCE is not
    const r = detectClusters(g, [W1, W2], null);

    const c = r.clusters.find(c => c.wallets.includes(W1) && c.wallets.includes(W2));
    expect(c).toBeUndefined();
  });
});

// ── Signal 3: Temporal co-occurrence ─────────────────────────────────────────

describe("Signal 3 — temporal co-occurrence clustering", () => {
  it("clusters wallets that transact in the same 5-min window", () => {
    // Temporal signal weight = 0.4, which equals MIN_CLUSTER_CONFIDENCE — boundary
    const edges = [
      edge({ from: W1, to: W3, block_time: T0 + 30,  fee_payer: "" }),
      edge({ from: W2, to: W3, block_time: T0 + 60,  fee_payer: "" }),
    ];
    const g = buildTxGraph(edges);
    const r = detectClusters(g, [W1, W2], null);

    const c = r.clusters.find(c => c.wallets.includes(W1) && c.wallets.includes(W2));
    expect(c).toBeDefined();
  });

  it("does NOT cluster wallets transacting in different 5-min windows", () => {
    const edges = [
      edge({ from: W1, to: W3, block_time: T0,  fee_payer: "" }),
      edge({ from: W2, to: W3, block_time: T1,  fee_payer: "" }), // next bucket
    ];
    const g = buildTxGraph(edges);
    const r = detectClusters(g, [W1, W2], null);

    const c = r.clusters.find(c => c.wallets.includes(W1) && c.wallets.includes(W2));
    expect(c).toBeUndefined();
  });

  it("accumulates strength across overlapping signals — fee payer + temporal together", () => {
    const edges = [
      edge({ from: W1, to: W3, fee_payer: FP, block_time: T0 }),
      edge({ from: W2, to: W3, fee_payer: FP, block_time: T0 + 10 }),
    ];
    const g = buildTxGraph(edges);
    const r = detectClusters(g, [W1, W2], null);

    const c = r.clusters.find(c => c.wallets.includes(W1) && c.wallets.includes(W2));
    expect(c).toBeDefined();
    // Combined weight (0.8 fee payer + 0.4 temporal) capped at 1.0
    expect(c!.confidence).toBe(1.0);
  });
});

// ── BFS connected components ──────────────────────────────────────────────────

describe("BFS — connected components", () => {
  it("merges transitively connected wallets into one cluster", () => {
    // W1-W2 share FP, W2-W3 share FP2 — transitive: W1 connects to W3 via W2
    const edges = [
      edge({ from: W1, to: W4, fee_payer: FP,  block_time: T0 }),
      edge({ from: W2, to: W4, fee_payer: FP,  block_time: T0 + 10 }),
      edge({ from: W2, to: W5, fee_payer: FP2, block_time: T1 }),
      edge({ from: W3, to: W5, fee_payer: FP2, block_time: T1 + 10 }),
    ];
    const g = buildTxGraph(edges);
    const r = detectClusters(g, [W1, W2, W3], null);

    expect(r.clusters).toHaveLength(1);
    expect(r.clusters[0].wallets).toHaveLength(3);
    expect(r.clusters[0].wallets).toEqual(expect.arrayContaining([W1, W2, W3]));
  });

  it("assigns unique cluster_ids starting from cluster_1", () => {
    // Two groups isolated in separate time buckets
    const edges = [
      edge({ from: W1, to: W5, fee_payer: FP,  block_time: T0 }),
      edge({ from: W2, to: W5, fee_payer: FP,  block_time: T0 + 10 }),
      edge({ from: W3, to: W5, fee_payer: FP2, block_time: T1 }),
      edge({ from: W4, to: W5, fee_payer: FP2, block_time: T1 + 10 }),
    ];
    const g = buildTxGraph(edges);
    const r = detectClusters(g, [W1, W2, W3, W4], null);

    const ids = r.clusters.map(c => c.cluster_id);
    expect(ids).toContain("cluster_1");
    expect(ids).toContain("cluster_2");
    expect(new Set(ids).size).toBe(ids.length); // all unique
  });

  it("does not include singletons (wallets with no connections above threshold)", () => {
    const g = buildTxGraph([]);
    const r = detectClusters(g, [W1, W2, W3], null);
    expect(r.clusters).toHaveLength(0);
  });
});

// ── Aggregate metrics ─────────────────────────────────────────────────────────

describe("ClusterDetectionResult aggregate metrics", () => {
  it("total_clustered_wallets sums all cluster wallet counts", () => {
    const edges = [
      edge({ from: W1, to: W5, fee_payer: FP,  block_time: T0 }),
      edge({ from: W2, to: W5, fee_payer: FP,  block_time: T0 + 10 }),
      edge({ from: W3, to: W5, fee_payer: FP2, block_time: T1 }),
      edge({ from: W4, to: W5, fee_payer: FP2, block_time: T1 + 10 }),
    ];
    const g = buildTxGraph(edges);
    const r = detectClusters(g, [W1, W2, W3, W4], null);

    expect(r.total_clustered_wallets).toBe(
      r.clusters.reduce((s, c) => s + c.wallets.length, 0)
    );
  });

  it("largest_cluster_size reflects the biggest cluster", () => {
    const edges = [
      edge({ from: W1, to: W5, fee_payer: FP, block_time: T0 }),
      edge({ from: W2, to: W5, fee_payer: FP, block_time: T0 + 10 }),
      edge({ from: W3, to: W5, fee_payer: FP, block_time: T0 + 20 }),
    ];
    const g = buildTxGraph(edges);
    const r = detectClusters(g, [W1, W2, W3], null);

    expect(r.largest_cluster_size).toBe(3);
  });

  it("highest_confidence is max across all clusters", () => {
    const edges = [
      edge({ from: W1, to: W5, fee_payer: FP, block_time: T0 }),
      edge({ from: W2, to: W5, fee_payer: FP, block_time: T0 + 10 }),
    ];
    const g = buildTxGraph(edges);
    const r = detectClusters(g, [W1, W2], null);

    expect(r.highest_confidence).toBe(Math.max(...r.clusters.map(c => c.confidence)));
  });

  it("returns zero metrics when no clusters detected", () => {
    const g = buildTxGraph([]);
    const r = detectClusters(g, [W1, W2], null);

    expect(r.clusters).toHaveLength(0);
    expect(r.total_clustered_wallets).toBe(0);
    expect(r.largest_cluster_size).toBe(0);
    expect(r.highest_confidence).toBe(0);
  });

  it("confidence is always in 0.0–1.0 range and rounded to 2 decimal places", () => {
    // Combined fee payer (0.8) + temporal (0.4) = 1.2, clamped to 1.0
    const edges = [
      edge({ from: W1, to: W5, fee_payer: FP, block_time: T0 }),
      edge({ from: W2, to: W5, fee_payer: FP, block_time: T0 + 10 }),
    ];
    const g = buildTxGraph(edges);
    const r = detectClusters(g, [W1, W2], null);

    for (const c of r.clusters) {
      expect(c.confidence).toBeGreaterThanOrEqual(0);
      expect(c.confidence).toBeLessThanOrEqual(1);
      expect(c.confidence).toBe(Math.round(c.confidence * 100) / 100);
    }
  });

  it("supply_pct_combined is always null (set by caller, not detectClusters)", () => {
    const edges = [
      edge({ from: W1, to: W5, fee_payer: FP, block_time: T0 }),
      edge({ from: W2, to: W5, fee_payer: FP, block_time: T0 + 10 }),
    ];
    const g = buildTxGraph(edges);
    const r = detectClusters(g, [W1, W2], null);

    for (const c of r.clusters) {
      expect(c.supply_pct_combined).toBeNull();
    }
  });
});

// ── Exclusion seeds ───────────────────────────────────────────────────────────

describe("EXCLUDED_CLUSTERING_SEEDS", () => {
  it("does not cluster wallets whose only shared fee payer is Orca Whirlpool", () => {
    const ORCA = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";
    // Separate buckets prevent temporal signal from also connecting W1/W2.
    const edges = [
      edge({ from: W1, to: W3, fee_payer: ORCA, block_time: T0 }),
      edge({ from: W2, to: W3, fee_payer: ORCA, block_time: T1 }),
    ];
    const g = buildTxGraph(edges);
    const r = detectClusters(g, [W1, W2], null);
    expect(r.clusters).toHaveLength(0);
  });

  it("does not cluster wallets whose only shared fee payer is the system program", () => {
    const SYS = "11111111111111111111111111111111";
    const edges = [
      edge({ from: W1, to: W3, fee_payer: SYS, block_time: T0 }),
      edge({ from: W2, to: W3, fee_payer: SYS, block_time: T1 }),
    ];
    const g = buildTxGraph(edges);
    const r = detectClusters(g, [W1, W2], null);
    expect(r.clusters).toHaveLength(0);
  });

  it("still clusters via non-excluded fee payer even when excluded one is also present", () => {
    const edges = [
      // Raydium (excluded) — same bucket, temporal would fire without the FP check
      edge({ from: W1, to: W3, fee_payer: RAYDIUM, block_time: T0 }),
      edge({ from: W2, to: W3, fee_payer: RAYDIUM, block_time: T1 }),
      // Custom fee payer (not excluded) — also in different buckets but FP signal fires
      edge({ from: W1, to: W4, fee_payer: FP, block_time: T2 }),
      edge({ from: W2, to: W4, fee_payer: FP, block_time: T2 + 10 }),
    ];
    const g = buildTxGraph(edges);
    const r = detectClusters(g, [W1, W2], null);

    const c = r.clusters.find(c => c.wallets.includes(W1) && c.wallets.includes(W2));
    expect(c).toBeDefined();
    expect(c!.common_fee_payer).toBe(FP);
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────────

describe("edge cases", () => {
  it("handles empty targetWallets without throwing", () => {
    const g = buildTxGraph([edge()]);
    expect(() => detectClusters(g, [], null)).not.toThrow();
    expect(detectClusters(g, [], null).clusters).toHaveLength(0);
  });

  it("handles single targetWallet (no pairs possible)", () => {
    const g = buildTxGraph([edge()]);
    const r = detectClusters(g, [W1], null);
    expect(r.clusters).toHaveLength(0);
  });

  it("handles empty graph with target wallets", () => {
    const g = buildTxGraph([]);
    const r = detectClusters(g, [W1, W2, W3], null);
    expect(r.clusters).toHaveLength(0);
  });

  it("does not cluster a wallet with itself (self-loop)", () => {
    const g = buildTxGraph([edge({ from: W1, to: W1, fee_payer: FP })]);
    const r = detectClusters(g, [W1], null);
    expect(r.clusters).toHaveLength(0);
  });

  it("handles null tokenCreationTime — falls back to base fee payer weight 0.8", () => {
    const edges = [
      edge({ from: W1, to: W3, fee_payer: FP, block_time: T0 }),
      edge({ from: W2, to: W3, fee_payer: FP, block_time: T0 }),
    ];
    const g = buildTxGraph(edges);
    const r = detectClusters(g, [W1, W2], null); // null creationTime

    const c = r.clusters.find(c => c.wallets.includes(W1) && c.wallets.includes(W2));
    expect(c).toBeDefined();
    expect(c!.confidence).toBeGreaterThanOrEqual(0.8);
  });
});
