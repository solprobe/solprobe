import { describe, it, expect } from "vitest";
import { buildTxGraph, type TxEdge } from "../../src/analysis/walletGraph.js";
import { propagateTaint } from "../../src/analysis/taintTracker.js";

const SEED  = "SEED1111111111111111111111111111111111111111";
const HOP1  = "HOP11111111111111111111111111111111111111111";
const HOP2  = "HOP22222222222222222222222222222222222222222";
const HOP3  = "HOP33333333333333333333333333333333333333333";
const HOP4  = "HOP44444444444444444444444444444444444444444";
const CLEAN = "CLEN1111111111111111111111111111111111111111";
const T0 = 1_700_000_000;

function edge(from: string, to: string, sig?: string): TxEdge {
  return {
    from, to, value_lamports: 1_000_000, block_time: T0,
    program: "TRANSFER", tx_signature: sig ?? `${from.slice(0,4)}-${to.slice(0,4)}`,
    fee_payer: from,
  };
}

// ── Empty seeds ───────────────────────────────────────────────────────────────

describe("propagateTaint — empty seeds", () => {
  it("returns NONE with score=0 when seed list is empty", () => {
    const g = buildTxGraph([edge(SEED, HOP1)]);
    const r = propagateTaint(g, HOP1, []);
    expect(r.taint_score).toBe(0);
    expect(r.taint_level).toBe("NONE");
    expect(r.hops_from_seed).toBeNull();
    expect(r.closest_seed).toBeNull();
  });
});

// ── Direct connection (score >= 1.0 → CRITICAL) ───────────────────────────────

describe("propagateTaint — direct seed connection", () => {
  it("returns score=1.0 (CRITICAL) when target IS the seed", () => {
    const g = buildTxGraph([edge(SEED, HOP1)]);
    const r = propagateTaint(g, SEED, [SEED]);
    expect(r.taint_score).toBeGreaterThanOrEqual(1.0);
    expect(r.taint_level).toBe("CRITICAL");
    expect(r.hops_from_seed).toBe(0);
  });
});

// ── Hop decay (alpha = 0.6) ───────────────────────────────────────────────────

describe("propagateTaint — hop decay", () => {
  it("1 hop returns score ~0.6 → HIGH", () => {
    const g = buildTxGraph([edge(SEED, HOP1)]);
    const r = propagateTaint(g, HOP1, [SEED]);
    expect(r.taint_score).toBeCloseTo(0.6, 3);
    expect(r.taint_level).toBe("HIGH");
    expect(r.hops_from_seed).toBe(1);
  });

  it("2 hops returns score ~0.36 → MEDIUM", () => {
    const g = buildTxGraph([edge(SEED, HOP1), edge(HOP1, HOP2)]);
    const r = propagateTaint(g, HOP2, [SEED]);
    expect(r.taint_score).toBeCloseTo(0.36, 3);
    expect(r.taint_level).toBe("MEDIUM");
    expect(r.hops_from_seed).toBe(2);
  });

  it("3 hops returns score ~0.216 → LOW", () => {
    const g = buildTxGraph([
      edge(SEED, HOP1), edge(HOP1, HOP2), edge(HOP2, HOP3),
    ]);
    const r = propagateTaint(g, HOP3, [SEED]);
    expect(r.taint_score).toBeCloseTo(0.216, 3);
    expect(r.taint_level).toBe("LOW");
  });

  it("does NOT propagate beyond MAX_HOPS=3", () => {
    const g = buildTxGraph([
      edge(SEED, HOP1), edge(HOP1, HOP2), edge(HOP2, HOP3), edge(HOP3, HOP4),
    ]);
    const r = propagateTaint(g, HOP4, [SEED]);
    expect(r.taint_score).toBe(0);
    expect(r.taint_level).toBe("NONE");
  });
});

// ── MAX_NODES_VISITED limit ───────────────────────────────────────────────────

describe("propagateTaint — graph_limit_hit", () => {
  it("sets graph_limit_hit=true when MAX_NODES_VISITED is reached", () => {
    // Star graph with >500 nodes from SEED — guaranteed to hit the limit
    const edges: TxEdge[] = [];
    for (let i = 0; i < 600; i++) {
      const addr = `NODE${String(i).padStart(39, "0")}`;
      edges.push({
        from: SEED, to: addr, value_lamports: 1_000,
        block_time: T0, program: "TRANSFER",
        tx_signature: `sig${i}`, fee_payer: SEED,
      });
    }
    const g = buildTxGraph(edges);
    const r = propagateTaint(g, CLEAN, [SEED]);
    expect(r.graph_limit_hit).toBe(true);
  });

  it("graph_limit_hit=false for small graphs", () => {
    const g = buildTxGraph([edge(SEED, HOP1)]);
    expect(propagateTaint(g, HOP1, [SEED]).graph_limit_hit).toBe(false);
  });
});

// ── Unconnected wallet ────────────────────────────────────────────────────────

describe("propagateTaint — clean wallet", () => {
  it("returns NONE for a wallet with no path to any seed", () => {
    const g = buildTxGraph([edge(SEED, HOP1), edge(CLEAN, HOP2)]);
    const r = propagateTaint(g, CLEAN, [SEED]);
    expect(r.taint_score).toBe(0);
    expect(r.taint_level).toBe("NONE");
    expect(r.closest_seed).toBeNull();
  });
});
