import { describe, it, expect } from "vitest";
import { buildTxGraph, type TxEdge } from "../../src/analysis/walletGraph.js";
import { computeFanSymmetry } from "../../src/analysis/graphMetrics.js";

const A = "AAAA1111111111111111111111111111111111111111";
const B = "BBBB2222222222222222222222222222222222222222";
const C = "CCCC3333333333333333333333333333333333333333";
const D = "DDDD4444444444444444444444444444444444444444";

const NOW = Math.floor(Date.now() / 1000);
const OLD = NOW - 7200;

function edge(from: string, to: string, lamports = 1_000_000, block_time = NOW, sig?: string): TxEdge {
  return {
    from, to, value_lamports: lamports, block_time, program: "TRANSFER",
    tx_signature: sig ?? `${from.slice(0,4)}-${to.slice(0,4)}-${block_time}`,
    fee_payer: from,
  };
}

// ── Perfect symmetry → wash indicator ────────────────────────────────────────

describe("computeFanSymmetry — perfect fan symmetry", () => {
  it("same wallets on both sides → symmetry_score >= 0.9 and wash_indicator=true", () => {
    // A sends to B and C; B and C both send back to A
    const g = buildTxGraph([
      edge(A, B, 1_000, NOW, "s1"), edge(A, C, 1_000, NOW, "s2"),
      edge(B, A, 1_000, NOW, "s3"), edge(C, A, 1_000, NOW, "s4"),
    ]);
    const r = computeFanSymmetry(g, A);
    expect(r.symmetry_score).toBeGreaterThanOrEqual(0.9);
    expect(r.wash_indicator).toBe(true);
  });

  it("perfect overlap with 3 wallets → symmetry_score = 1.0", () => {
    const g = buildTxGraph([
      edge(A, B, 1_000, NOW, "1"), edge(A, C, 1_000, NOW, "2"), edge(A, D, 1_000, NOW, "3"),
      edge(B, A, 1_000, NOW, "4"), edge(C, A, 1_000, NOW, "5"), edge(D, A, 1_000, NOW, "6"),
    ]);
    expect(computeFanSymmetry(g, A).symmetry_score).toBeCloseTo(1.0, 3);
  });
});

// ── Unidirectional flow → near-zero symmetry ──────────────────────────────────

describe("computeFanSymmetry — unidirectional flow", () => {
  it("pure sender (no incoming) → symmetry_score = 0 and wash_indicator=false", () => {
    const g = buildTxGraph([edge(A, B), edge(A, C)]);
    const r = computeFanSymmetry(g, A);
    expect(r.symmetry_score).toBe(0);
    expect(r.wash_indicator).toBe(false);
    expect(r.fan_out).toBe(2);
    expect(r.fan_in).toBe(0);
  });

  it("pure receiver (no outgoing) → symmetry_score = 0", () => {
    const g = buildTxGraph([edge(B, A), edge(C, A)]);
    const r = computeFanSymmetry(g, A);
    expect(r.symmetry_score).toBe(0);
    expect(r.fan_out).toBe(0);
    expect(r.fan_in).toBe(2);
  });
});

// ── wash_indicator threshold (strictly > 0.7) ─────────────────────────────────

describe("computeFanSymmetry — wash_indicator threshold", () => {
  it("score exactly 0.7 → wash_indicator=false (strict >)", () => {
    // fan_out=2, fan_in=2, overlap=1: count_sym=1, overlap_ratio=0.5 → 1*0.4 + 0.5*0.6 = 0.7
    const g = buildTxGraph([
      edge(A, B, 1_000, NOW, "s1"), edge(A, C, 1_000, NOW, "s2"),
      edge(B, A, 1_000, NOW, "s3"), edge(D, A, 1_000, NOW, "s4"),
    ]);
    const r = computeFanSymmetry(g, A);
    expect(r.symmetry_score).toBeCloseTo(0.7, 3);
    expect(r.wash_indicator).toBe(false);
  });

  it("score above 0.7 → wash_indicator=true", () => {
    // All 3 wallets overlap → score = 1.0
    const g = buildTxGraph([
      edge(A, B, 1_000, NOW, "1"), edge(A, C, 1_000, NOW, "2"), edge(A, D, 1_000, NOW, "3"),
      edge(B, A, 1_000, NOW, "4"), edge(C, A, 1_000, NOW, "5"), edge(D, A, 1_000, NOW, "6"),
    ]);
    expect(computeFanSymmetry(g, A).wash_indicator).toBe(true);
  });
});

// ── net_flow and time window ──────────────────────────────────────────────────

describe("computeFanSymmetry — net flow and time window", () => {
  it("net_flow is positive for net sender", () => {
    const g = buildTxGraph([edge(A, B, 10_000_000, NOW, "s1"), edge(C, A, 3_000_000, NOW, "s2")]);
    expect(computeFanSymmetry(g, A).net_flow_lamports).toBe(7_000_000);
  });

  it("time window excludes edges older than cutoff", () => {
    const g = buildTxGraph([edge(A, B, 1_000, NOW, "recent"), edge(A, C, 1_000, OLD, "old")]);
    const r = computeFanSymmetry(g, A, 3600);  // 1-hour window
    expect(r.fan_out).toBe(1);  // only B within window
  });

  it("without time window, all edges are included", () => {
    const g = buildTxGraph([edge(A, B, 1_000, NOW, "recent"), edge(A, C, 1_000, OLD, "old")]);
    expect(computeFanSymmetry(g, A).fan_out).toBe(2);
  });
});

// ── Empty / isolated wallet ───────────────────────────────────────────────────

describe("computeFanSymmetry — empty graph", () => {
  it("wallet not in graph → all zeros, wash_indicator=false", () => {
    const g = buildTxGraph([]);
    const r = computeFanSymmetry(g, A);
    expect(r.fan_out).toBe(0);
    expect(r.fan_in).toBe(0);
    expect(r.symmetry_score).toBe(0);
    expect(r.net_flow_lamports).toBe(0);
    expect(r.wash_indicator).toBe(false);
  });
});
