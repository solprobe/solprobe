import { describe, it, expect } from "vitest";
import { buildTxGraph, type TxEdge } from "../src/analysis/walletGraph.js";
import { computeFanSymmetry } from "../src/analysis/graphMetrics.js";

// ── Address fixtures ──────────────────────────────────────────────────────────
const A = "AAAA1111111111111111111111111111111111111111";
const B = "BBBB2222222222222222222222222222222222222222";
const C = "CCCC3333333333333333333333333333333333333333";
const D = "DDDD4444444444444444444444444444444444444444";

const NOW = Math.floor(Date.now() / 1000);
const OLD = NOW - 7200;  // 2 hours ago — outside a 3600s window

function edge(from: string, to: string, lamports = 1_000_000, block_time = NOW, sig?: string): TxEdge {
  return {
    from,
    to,
    value_lamports: lamports,
    block_time,
    program: "TRANSFER",
    tx_signature: sig ?? `${from.slice(0, 4)}-${to.slice(0, 4)}-${block_time}`,
    fee_payer: from,
  };
}

// ── Empty / isolated wallet ───────────────────────────────────────────────────

describe("computeFanSymmetry — empty graph", () => {
  it("returns all zeros for a wallet with no edges", () => {
    const g = buildTxGraph([]);
    const r = computeFanSymmetry(g, A);
    expect(r.fan_out).toBe(0);
    expect(r.fan_in).toBe(0);
    expect(r.symmetry_score).toBe(0);
    expect(r.net_flow_lamports).toBe(0);
    expect(r.wash_indicator).toBe(false);
  });

  it("returns all zeros for a wallet not in the graph", () => {
    const g = buildTxGraph([edge(B, C)]);
    const r = computeFanSymmetry(g, A);
    expect(r.fan_out).toBe(0);
    expect(r.fan_in).toBe(0);
    expect(r.symmetry_score).toBe(0);
  });
});

// ── Pure sender / pure receiver ───────────────────────────────────────────────

describe("computeFanSymmetry — one-directional", () => {
  it("pure sender: fan_out > 0, fan_in = 0, net_flow positive", () => {
    const g = buildTxGraph([edge(A, B, 5_000_000), edge(A, C, 3_000_000)]);
    const r = computeFanSymmetry(g, A);
    expect(r.fan_out).toBe(2);
    expect(r.fan_in).toBe(0);
    expect(r.net_flow_lamports).toBe(8_000_000);
    // count_symmetry = 1 - |2-0|/2 = 0; overlap_ratio = 0; total = 0
    expect(r.symmetry_score).toBe(0);
    expect(r.wash_indicator).toBe(false);
  });

  it("pure receiver: fan_in > 0, fan_out = 0, net_flow negative", () => {
    const g = buildTxGraph([edge(B, A, 5_000_000), edge(C, A, 3_000_000)]);
    const r = computeFanSymmetry(g, A);
    expect(r.fan_out).toBe(0);
    expect(r.fan_in).toBe(2);
    expect(r.net_flow_lamports).toBe(-8_000_000);
    expect(r.symmetry_score).toBe(0);
    expect(r.wash_indicator).toBe(false);
  });
});

// ── Fan count symmetry ────────────────────────────────────────────────────────

describe("computeFanSymmetry — count symmetry (no overlap)", () => {
  it("equal fan counts with no address overlap → count_symmetry=1, overlap=0 → score=0.4", () => {
    // A sends to B, C receives from D — no B/D overlap
    const g = buildTxGraph([
      edge(A, B, 1_000_000, NOW, "s1"),
      edge(D, A, 1_000_000, NOW, "s2"),
    ]);
    const r = computeFanSymmetry(g, A);
    expect(r.fan_out).toBe(1);
    expect(r.fan_in).toBe(1);
    // count_symmetry = 1 - |1-1|/1 = 1; overlap = 0 (B ≠ D); overlap_ratio = 0
    // score = 1*0.4 + 0*0.6 = 0.4
    expect(r.symmetry_score).toBeCloseTo(0.4, 3);
    expect(r.wash_indicator).toBe(false);
  });

  it("3 unique targets, 1 unique source → asymmetric", () => {
    const g = buildTxGraph([
      edge(A, B, 1_000_000, NOW, "s1"),
      edge(A, C, 1_000_000, NOW, "s2"),
      edge(A, D, 1_000_000, NOW, "s3"),
      edge(B, A, 1_000_000, NOW, "s4"),
    ]);
    const r = computeFanSymmetry(g, A);
    expect(r.fan_out).toBe(3);
    expect(r.fan_in).toBe(1);
    // count_symmetry = 1 - |3-1|/3 = 1 - 2/3 = 0.333
    // overlap: B is in both targets and sources → overlap=1, max_fan=3, overlap_ratio=0.333
    // score = 0.333*0.4 + 0.333*0.6 = 0.333
    expect(r.symmetry_score).toBeCloseTo(0.333, 2);
  });
});

// ── Address overlap (wash trading signal) ─────────────────────────────────────

describe("computeFanSymmetry — address overlap", () => {
  it("perfect overlap (same wallets on both sides) → wash_indicator=true", () => {
    // A sends to B and C; B and C also send back to A
    const g = buildTxGraph([
      edge(A, B, 1_000_000, NOW, "s1"),
      edge(A, C, 1_000_000, NOW, "s2"),
      edge(B, A, 1_000_000, NOW, "s3"),
      edge(C, A, 1_000_000, NOW, "s4"),
    ]);
    const r = computeFanSymmetry(g, A);
    expect(r.fan_out).toBe(2);
    expect(r.fan_in).toBe(2);
    // count_symmetry = 1 - |2-2|/2 = 1; overlap = 2 (B,C both sides); overlap_ratio = 2/2 = 1
    // score = 1*0.4 + 1*0.6 = 1.0
    expect(r.symmetry_score).toBeCloseTo(1.0, 3);
    expect(r.wash_indicator).toBe(true);
  });

  it("partial overlap → intermediate score", () => {
    // A sends to B, C; receives from B, D — B is on both sides, C/D are not
    const g = buildTxGraph([
      edge(A, B, 1_000_000, NOW, "s1"),
      edge(A, C, 1_000_000, NOW, "s2"),
      edge(B, A, 1_000_000, NOW, "s3"),
      edge(D, A, 1_000_000, NOW, "s4"),
    ]);
    const r = computeFanSymmetry(g, A);
    expect(r.fan_out).toBe(2);
    expect(r.fan_in).toBe(2);
    // count_symmetry = 1; overlap = 1 (only B); max_fan=2; overlap_ratio = 0.5
    // score = 1*0.4 + 0.5*0.6 = 0.7
    expect(r.symmetry_score).toBeCloseTo(0.7, 3);
    // 0.7 is NOT > 0.7 — boundary check
    expect(r.wash_indicator).toBe(false);
  });

  it("overlap ratio just above 0.7 threshold → wash_indicator=true", () => {
    // 3 wallets on each side, all 3 overlapping: count_sym=1, overlap_ratio=1 → score=1.0
    const g = buildTxGraph([
      edge(A, B, 1_000, NOW, "1"), edge(A, C, 1_000, NOW, "2"), edge(A, D, 1_000, NOW, "3"),
      edge(B, A, 1_000, NOW, "4"), edge(C, A, 1_000, NOW, "5"), edge(D, A, 1_000, NOW, "6"),
    ]);
    const r = computeFanSymmetry(g, A);
    expect(r.wash_indicator).toBe(true);
    expect(r.symmetry_score).toBeCloseTo(1.0, 3);
  });
});

// ── net_flow_lamports ─────────────────────────────────────────────────────────

describe("computeFanSymmetry — net flow", () => {
  it("net_flow is sum(out) - sum(in)", () => {
    const g = buildTxGraph([
      edge(A, B, 10_000_000, NOW, "s1"),
      edge(C, A,  3_000_000, NOW, "s2"),
    ]);
    const r = computeFanSymmetry(g, A);
    expect(r.net_flow_lamports).toBe(7_000_000);
  });

  it("net_flow is zero when in equals out", () => {
    const g = buildTxGraph([
      edge(A, B, 5_000_000, NOW, "s1"),
      edge(C, A, 5_000_000, NOW, "s2"),
    ]);
    expect(computeFanSymmetry(g, A).net_flow_lamports).toBe(0);
  });

  it("net_flow counts all edges to same target (not deduplicated)", () => {
    // Two separate edges A→B (different sigs) — both counted in net flow
    const g = buildTxGraph([
      edge(A, B, 2_000_000, NOW, "s1"),
      edge(A, B, 3_000_000, NOW, "s2"),
    ]);
    const r = computeFanSymmetry(g, A);
    expect(r.net_flow_lamports).toBe(5_000_000);
    // But fan_out deduplicates — only 1 unique target
    expect(r.fan_out).toBe(1);
  });
});

// ── Time window filtering ─────────────────────────────────────────────────────

describe("computeFanSymmetry — timeWindowSeconds", () => {
  it("excludes edges older than the window", () => {
    const g = buildTxGraph([
      edge(A, B, 1_000_000, NOW, "recent"),
      edge(A, C, 1_000_000, OLD, "old"),   // 2 hours ago
    ]);
    // 1-hour window — OLD edge excluded
    const r = computeFanSymmetry(g, A, 3600);
    expect(r.fan_out).toBe(1);  // only B
    expect(r.net_flow_lamports).toBe(1_000_000);
  });

  it("includes all edges when window is large enough", () => {
    const g = buildTxGraph([
      edge(A, B, 1_000_000, NOW, "recent"),
      edge(A, C, 1_000_000, OLD, "old"),
    ]);
    const r = computeFanSymmetry(g, A, 86400);  // 24-hour window
    expect(r.fan_out).toBe(2);
  });

  it("returns zero when all edges are outside the window", () => {
    const g = buildTxGraph([edge(A, B, 1_000_000, OLD, "old")]);
    const r = computeFanSymmetry(g, A, 3600);
    expect(r.fan_out).toBe(0);
    expect(r.symmetry_score).toBe(0);
    expect(r.net_flow_lamports).toBe(0);
  });

  it("no window argument uses all edges regardless of age", () => {
    const g = buildTxGraph([edge(A, B, 1_000_000, OLD, "old")]);
    const r = computeFanSymmetry(g, A);
    expect(r.fan_out).toBe(1);
  });
});

// ── Result shape ──────────────────────────────────────────────────────────────

describe("computeFanSymmetry — result shape", () => {
  it("symmetry_score is always 0.0–1.0", () => {
    const g = buildTxGraph([
      edge(A, B, 1_000_000, NOW, "s1"),
      edge(B, A, 1_000_000, NOW, "s2"),
    ]);
    const r = computeFanSymmetry(g, A);
    expect(r.symmetry_score).toBeGreaterThanOrEqual(0);
    expect(r.symmetry_score).toBeLessThanOrEqual(1);
  });

  it("symmetry_score is rounded to 3 decimal places", () => {
    const g = buildTxGraph([
      edge(A, B, 1_000, NOW, "s1"),
      edge(A, C, 1_000, NOW, "s2"),
      edge(A, D, 1_000, NOW, "s3"),
      edge(B, A, 1_000, NOW, "s4"),
    ]);
    const r = computeFanSymmetry(g, A);
    const decimals = (r.symmetry_score.toString().split(".")[1] ?? "").length;
    expect(decimals).toBeLessThanOrEqual(3);
  });

  it("wash_indicator is strictly > 0.7 (not >= 0.7)", () => {
    // score = 0.7 exactly → NOT wash
    const g = buildTxGraph([
      edge(A, B, 1_000, NOW, "s1"),
      edge(A, C, 1_000, NOW, "s2"),
      edge(B, A, 1_000, NOW, "s3"),
      edge(D, A, 1_000, NOW, "s4"),
    ]);
    const r = computeFanSymmetry(g, A);
    expect(r.symmetry_score).toBeCloseTo(0.7, 3);
    expect(r.wash_indicator).toBe(false);
  });
});
