import { describe, it, expect } from "vitest";
import { buildTxGraph, type TxEdge } from "../src/analysis/walletGraph.js";
import { propagateTaint, type TaintResult } from "../src/analysis/taintTracker.js";

// ── Address fixtures ──────────────────────────────────────────────────────────
const SEED  = "SEED1111111111111111111111111111111111111111";  // known bad actor
const SEED2 = "SEED2222222222222222222222222222222222222222";  // second bad actor
const HOP1  = "HOP11111111111111111111111111111111111111111";  // 1 hop from seed
const HOP2  = "HOP22222222222222222222222222222222222222222";  // 2 hops from seed
const HOP3  = "HOP33333333333333333333333333333333333333333";  // 3 hops from seed
const HOP4  = "HOP44444444444444444444444444444444444444444";  // 4 hops — beyond MAX_HOPS
const CLEAN = "CLEN1111111111111111111111111111111111111111";  // no connection

const T0 = 1_700_000_000;

function edge(from: string, to: string, sig?: string): TxEdge {
  return {
    from,
    to,
    value_lamports: 1_000_000,
    block_time: T0,
    program: "TRANSFER",
    tx_signature: sig ?? `${from.slice(0, 4)}-${to.slice(0, 4)}`,
    fee_payer: from,
  };
}

// ── Seed in graph ─────────────────────────────────────────────────────────────

describe("propagateTaint — seed handling", () => {
  it("returns NONE for empty seed list", () => {
    const g = buildTxGraph([edge(SEED, HOP1)]);
    const r = propagateTaint(g, HOP1, []);
    expect(r.taint_score).toBe(0);
    expect(r.taint_level).toBe("NONE");
    expect(r.hops_from_seed).toBeNull();
    expect(r.closest_seed).toBeNull();
  });

  it("returns NONE when seed is not in graph at all", () => {
    const g = buildTxGraph([edge(HOP1, HOP2)]);
    const r = propagateTaint(g, HOP1, [SEED]);
    expect(r.taint_score).toBe(0);
    expect(r.taint_level).toBe("NONE");
  });

  it("returns CRITICAL (score=1.0) when target IS the seed", () => {
    const g = buildTxGraph([edge(SEED, HOP1)]);
    const r = propagateTaint(g, SEED, [SEED]);
    expect(r.taint_score).toBe(1.0);
    expect(r.taint_level).toBe("CRITICAL");
    expect(r.hops_from_seed).toBe(0);
    expect(r.closest_seed).toBe(SEED);
  });
});

// ── Hop decay ─────────────────────────────────────────────────────────────────

describe("propagateTaint — decay per hop", () => {
  // SEED → HOP1: score = 1.0 * 0.6 = 0.6  → HIGH
  it("applies 0.6 decay at 1 hop → HIGH", () => {
    const g = buildTxGraph([edge(SEED, HOP1)]);
    const r = propagateTaint(g, HOP1, [SEED]);
    expect(r.taint_score).toBeCloseTo(0.6, 3);
    expect(r.taint_level).toBe("HIGH");
    expect(r.hops_from_seed).toBe(1);
    expect(r.closest_seed).toBe(SEED);
  });

  // SEED → HOP1 → HOP2: score = 0.6 * 0.6 = 0.36  → MEDIUM
  it("applies 0.6^2 decay at 2 hops → MEDIUM", () => {
    const g = buildTxGraph([edge(SEED, HOP1), edge(HOP1, HOP2)]);
    const r = propagateTaint(g, HOP2, [SEED]);
    expect(r.taint_score).toBeCloseTo(0.36, 3);
    expect(r.taint_level).toBe("MEDIUM");
    expect(r.hops_from_seed).toBe(2);
  });

  // SEED → HOP1 → HOP2 → HOP3: score = 0.6^3 = 0.216  → LOW
  it("applies 0.6^3 decay at 3 hops → LOW", () => {
    const g = buildTxGraph([
      edge(SEED, HOP1),
      edge(HOP1, HOP2),
      edge(HOP2, HOP3),
    ]);
    const r = propagateTaint(g, HOP3, [SEED]);
    expect(r.taint_score).toBeCloseTo(0.216, 3);
    expect(r.taint_level).toBe("LOW");
    expect(r.hops_from_seed).toBe(3);
  });

  // 4 hops — beyond MAX_HOPS=3, should not propagate
  it("does NOT propagate beyond MAX_HOPS=3 — 4-hop target gets NONE", () => {
    const g = buildTxGraph([
      edge(SEED, HOP1),
      edge(HOP1, HOP2),
      edge(HOP2, HOP3),
      edge(HOP3, HOP4),
    ]);
    const r = propagateTaint(g, HOP4, [SEED]);
    expect(r.taint_score).toBe(0);
    expect(r.taint_level).toBe("NONE");
  });
});

// ── Bidirectional propagation ─────────────────────────────────────────────────

describe("propagateTaint — bidirectional edges", () => {
  it("propagates taint via incoming edges (target receives, not just sends)", () => {
    // HOP1 → SEED (HOP1 sent to seed): taint should still flow seed→HOP1 via in-edge
    const g = buildTxGraph([edge(HOP1, SEED)]);
    const r = propagateTaint(g, HOP1, [SEED]);
    // SEED is in graph; from SEED's adjacency_in we see HOP1 — but propagation
    // goes from seed outward via adjacency_out and adjacency_in neighbors.
    // SEED's inEdges include HOP1 (HOP1→SEED), so HOP1 is a neighbor of SEED.
    expect(r.taint_score).toBeCloseTo(0.6, 3);
    expect(r.taint_level).toBe("HIGH");
  });
});

// ── Clean wallet ──────────────────────────────────────────────────────────────

describe("propagateTaint — unconnected wallet", () => {
  it("returns NONE for a wallet with no path to any seed", () => {
    const g = buildTxGraph([
      edge(SEED, HOP1),
      edge(CLEAN, HOP2),  // CLEAN is in a separate component
    ]);
    const r = propagateTaint(g, CLEAN, [SEED]);
    expect(r.taint_score).toBe(0);
    expect(r.taint_level).toBe("NONE");
    expect(r.closest_seed).toBeNull();
  });

  it("returns NONE for a wallet not in the graph at all", () => {
    const g = buildTxGraph([edge(SEED, HOP1)]);
    const r = propagateTaint(g, CLEAN, [SEED]);
    expect(r.taint_score).toBe(0);
    expect(r.taint_level).toBe("NONE");
  });
});

// ── Multiple seeds ────────────────────────────────────────────────────────────

describe("propagateTaint — multiple seeds", () => {
  it("takes the highest taint when two seeds both reach the target", () => {
    // SEED → HOP1 (score=0.6), SEED2 → HOP1 directly (score=0.6 also)
    // But SEED2 → HOP1 is 1 hop, same as SEED. Max stays 0.6.
    const g = buildTxGraph([
      edge(SEED,  HOP1, "s1"),
      edge(SEED2, HOP1, "s2"),
    ]);
    const r = propagateTaint(g, HOP1, [SEED, SEED2]);
    expect(r.taint_score).toBeCloseTo(0.6, 3);
  });

  it("selects the closer seed when two seeds have different hop counts", () => {
    // SEED → HOP1 → HOP2 (2 hops, score=0.36)
    // SEED2 → HOP2 (1 hop, score=0.6)  → SEED2 wins
    const g = buildTxGraph([
      edge(SEED,  HOP1, "s1"),
      edge(HOP1,  HOP2, "h1"),
      edge(SEED2, HOP2, "s2"),
    ]);
    const r = propagateTaint(g, HOP2, [SEED, SEED2]);
    expect(r.taint_score).toBeCloseTo(0.6, 3);
    expect(r.closest_seed).toBe(SEED2);
    expect(r.hops_from_seed).toBe(1);
  });
});

// ── TaintResult shape ─────────────────────────────────────────────────────────

describe("propagateTaint — result shape", () => {
  it("always returns all required fields", () => {
    const g = buildTxGraph([edge(SEED, HOP1)]);
    const r = propagateTaint(g, HOP1, [SEED]);
    expect(r).toHaveProperty("taint_score");
    expect(r).toHaveProperty("taint_level");
    expect(r).toHaveProperty("hops_from_seed");
    expect(r).toHaveProperty("closest_seed");
    expect(r).toHaveProperty("seeds_reachable");
    expect(r).toHaveProperty("graph_limit_hit");
    expect(r).toHaveProperty("meaning");
    expect(r).toHaveProperty("action_guidance");
  });

  it("taint_score is always 0.0–1.0", () => {
    const g = buildTxGraph([edge(SEED, HOP1)]);
    const r = propagateTaint(g, HOP1, [SEED]);
    expect(r.taint_score).toBeGreaterThanOrEqual(0);
    expect(r.taint_score).toBeLessThanOrEqual(1);
  });

  it("meaning and action_guidance are non-empty strings for all levels", () => {
    const levels: Array<TaintResult["taint_level"]> = ["NONE", "LOW", "MEDIUM", "HIGH", "CRITICAL"];
    // Test each level indirectly via known score thresholds
    const graphs = [
      { g: buildTxGraph([]), addr: CLEAN, seeds: [] },                             // NONE
      { g: buildTxGraph([edge(SEED, HOP1), edge(HOP1, HOP2), edge(HOP2, HOP3)]),  // LOW (3 hops)
        addr: HOP3, seeds: [SEED] },
      { g: buildTxGraph([edge(SEED, HOP1), edge(HOP1, HOP2)]),                    // MEDIUM (2 hops)
        addr: HOP2, seeds: [SEED] },
      { g: buildTxGraph([edge(SEED, HOP1)]),                                       // HIGH (1 hop)
        addr: HOP1, seeds: [SEED] },
      { g: buildTxGraph([edge(SEED, HOP1)]),                                       // CRITICAL (seed itself)
        addr: SEED, seeds: [SEED] },
    ];
    for (const { g, addr, seeds } of graphs) {
      const r = propagateTaint(g, addr, seeds);
      expect(typeof r.meaning).toBe("string");
      expect(r.meaning.length).toBeGreaterThan(0);
      expect(typeof r.action_guidance).toBe("string");
      expect(r.action_guidance.length).toBeGreaterThan(0);
    }
  });

  it("graph_limit_hit is false for small graphs", () => {
    const g = buildTxGraph([edge(SEED, HOP1)]);
    const r = propagateTaint(g, HOP1, [SEED]);
    expect(r.graph_limit_hit).toBe(false);
  });

  it("graph_limit_hit is true when MAX_NODES_VISITED is reached", () => {
    // Build a star graph with 600 leaf nodes all connected to SEED
    const edges: TxEdge[] = [];
    for (let i = 0; i < 600; i++) {
      const addr = `NODE${String(i).padStart(39, "0")}`;
      edges.push({
        from: SEED,
        to: addr,
        value_lamports: 1_000_000,
        block_time: T0,
        program: "TRANSFER",
        tx_signature: `sig${i}`,
        fee_payer: SEED,
      });
    }
    const g = buildTxGraph(edges);
    const r = propagateTaint(g, CLEAN, [SEED]);  // CLEAN not reachable but limit hit during BFS
    expect(r.graph_limit_hit).toBe(true);
  });
});

// ── Level thresholds ──────────────────────────────────────────────────────────

describe("propagateTaint — level thresholds", () => {
  it("score >= 1.0 → CRITICAL", () => {
    const g = buildTxGraph([edge(SEED, HOP1)]);
    expect(propagateTaint(g, SEED, [SEED]).taint_level).toBe("CRITICAL");
  });

  it("score 0.6–0.999 → HIGH", () => {
    const g = buildTxGraph([edge(SEED, HOP1)]);
    expect(propagateTaint(g, HOP1, [SEED]).taint_level).toBe("HIGH");
  });

  it("score 0.3–0.599 → MEDIUM", () => {
    const g = buildTxGraph([edge(SEED, HOP1), edge(HOP1, HOP2)]);
    expect(propagateTaint(g, HOP2, [SEED]).taint_level).toBe("MEDIUM");
  });

  it("score 0.001–0.299 → LOW", () => {
    const g = buildTxGraph([
      edge(SEED, HOP1),
      edge(HOP1, HOP2),
      edge(HOP2, HOP3),
    ]);
    expect(propagateTaint(g, HOP3, [SEED]).taint_level).toBe("LOW");
  });

  it("score 0 → NONE", () => {
    const g = buildTxGraph([edge(CLEAN, HOP1)]);
    expect(propagateTaint(g, CLEAN, [SEED]).taint_level).toBe("NONE");
  });
});
