import { describe, it, expect } from "vitest";
import {
  buildTxGraph,
  heliusTxsToEdges,
  type TxEdge,
} from "../../src/analysis/walletGraph.js";

const A  = "AAAA1111111111111111111111111111111111111111";
const B  = "BBBB2222222222222222222222222222222222222222";
const C  = "CCCC3333333333333333333333333333333333333333";
const FP = "FEEE4444444444444444444444444444444444444444";

function edge(overrides: Partial<TxEdge> = {}): TxEdge {
  return {
    from: A, to: B, value_lamports: 1_000_000,
    block_time: 1_700_000_000, program: "TRANSFER",
    tx_signature: "sig1", fee_payer: FP, ...overrides,
  };
}

// ── buildTxGraph ──────────────────────────────────────────────────────────────

describe("buildTxGraph — adjacency maps", () => {
  it("populates adjacency_out for the from address", () => {
    const g = buildTxGraph([edge()]);
    expect(g.adjacency_out.get(A)).toHaveLength(1);
    expect(g.adjacency_out.get(A)![0].to).toBe(B);
  });

  it("populates adjacency_in for the to address", () => {
    const g = buildTxGraph([edge()]);
    expect(g.adjacency_in.get(B)).toHaveLength(1);
    expect(g.adjacency_in.get(B)![0].from).toBe(A);
  });

  it("accumulates multiple edges from the same source", () => {
    const g = buildTxGraph([
      edge({ to: B, tx_signature: "s1" }),
      edge({ to: C, tx_signature: "s2" }),
    ]);
    expect(g.adjacency_out.get(A)).toHaveLength(2);
  });

  it("handles empty edge list — all maps empty", () => {
    const g = buildTxGraph([]);
    expect(g.nodes.size).toBe(0);
    expect(g.edges).toHaveLength(0);
    expect(g.adjacency_out.size).toBe(0);
    expect(g.adjacency_in.size).toBe(0);
  });

  it("includes all three addresses (from, to, fee_payer) in nodes", () => {
    const g = buildTxGraph([edge()]);
    expect(g.nodes.has(A)).toBe(true);
    expect(g.nodes.has(B)).toBe(true);
    expect(g.nodes.has(FP)).toBe(true);
  });
});

// ── fee_payer_map ─────────────────────────────────────────────────────────────

describe("buildTxGraph — fee_payer_map", () => {
  it("groups wallets by shared fee payer", () => {
    const g = buildTxGraph([
      edge({ from: A, to: B, fee_payer: FP }),
      edge({ from: C, to: B, fee_payer: FP, tx_signature: "s2" }),
    ]);
    const group = g.fee_payer_map.get(FP)!;
    expect(group.has(A)).toBe(true);
    expect(group.has(B)).toBe(true);
    expect(group.has(C)).toBe(true);
  });

  it("does not create an entry when fee_payer equals from (self-pay)", () => {
    const g = buildTxGraph([edge({ fee_payer: A })]);
    expect(g.fee_payer_map.has(A)).toBe(false);
  });

  it("does not create an entry for empty fee_payer string", () => {
    const g = buildTxGraph([edge({ fee_payer: "" })]);
    expect(g.fee_payer_map.size).toBe(0);
  });
});

// ── heliusTxsToEdges ──────────────────────────────────────────────────────────

describe("heliusTxsToEdges — Helius transaction format mapping", () => {
  it("maps native SOL transfers to edges", () => {
    const txs = [{
      signature: "sig1", feePayer: FP, timestamp: 1_700_000_000, type: "TRANSFER",
      nativeTransfers: [{ fromUserAccount: A, toUserAccount: B, amount: 5_000_000 }],
      tokenTransfers: [],
    }];
    const edges = heliusTxsToEdges(txs, A);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ from: A, to: B, value_lamports: 5_000_000, fee_payer: FP });
  });

  it("maps token transfers with value_lamports=0", () => {
    const txs = [{
      signature: "sig2", feePayer: FP, timestamp: 1_700_000_001, type: "TOKEN_TRANSFER",
      nativeTransfers: [],
      tokenTransfers: [{ fromUserAccount: A, toUserAccount: B, programId: "TOKEN123" }],
    }];
    const edges = heliusTxsToEdges(txs, A);
    expect(edges).toHaveLength(1);
    expect(edges[0].value_lamports).toBe(0);
    expect(edges[0].program).toBe("TOKEN123");
  });

  it("skips native transfers with null accounts", () => {
    const txs = [{
      signature: "sig3", feePayer: FP, timestamp: 1_700_000_002,
      nativeTransfers: [{ fromUserAccount: null, toUserAccount: B, amount: 1000 }],
      tokenTransfers: [],
    }];
    expect(heliusTxsToEdges(txs, A)).toHaveLength(0);
  });

  it("skips token transfers with null accounts", () => {
    const txs = [{
      signature: "sig4", feePayer: FP, timestamp: 1_700_000_003,
      nativeTransfers: [],
      tokenTransfers: [{ fromUserAccount: A, toUserAccount: null }],
    }];
    expect(heliusTxsToEdges(txs, A)).toHaveLength(0);
  });

  it("falls back to fee_payer='' when feePayer missing", () => {
    const txs = [{
      signature: "sig5", timestamp: 1_700_000_004,
      nativeTransfers: [{ fromUserAccount: A, toUserAccount: B, amount: 1000 }],
      tokenTransfers: [],
    }];
    expect(heliusTxsToEdges(txs, A)[0].fee_payer).toBe("");
  });

  it("falls back to block_time=0 when timestamp missing", () => {
    const txs = [{
      signature: "sig6", feePayer: FP,
      nativeTransfers: [{ fromUserAccount: A, toUserAccount: B, amount: 1000 }],
      tokenTransfers: [],
    }];
    expect(heliusTxsToEdges(txs, A)[0].block_time).toBe(0);
  });

  it("returns empty array for empty transaction list", () => {
    expect(heliusTxsToEdges([], A)).toHaveLength(0);
  });
});
