import { describe, it, expect, beforeEach } from "vitest";
import {
  buildTxGraph,
  heliusTxsToEdges,
  getCachedGraph,
  setCachedGraph,
  clearRequestCache,
  type TxEdge,
} from "../src/analysis/walletGraph.js";

const A = "AAA1111111111111111111111111111111111111111";
const B = "BBB2222222222222222222222222222222222222222";
const C = "CCC3333333333333333333333333333333333333333";
const FP = "FEE4444444444444444444444444444444444444444";

function edge(overrides: Partial<TxEdge> = {}): TxEdge {
  return {
    from: A,
    to: B,
    value_lamports: 1_000_000,
    block_time: 1_700_000_000,
    program: "TRANSFER",
    tx_signature: "sig1",
    fee_payer: FP,
    ...overrides,
  };
}

describe("buildTxGraph", () => {
  it("populates nodes from from, to, and fee_payer", () => {
    const g = buildTxGraph([edge()]);
    expect(g.nodes.has(A)).toBe(true);
    expect(g.nodes.has(B)).toBe(true);
    expect(g.nodes.has(FP)).toBe(true);
  });

  it("builds adjacency_out correctly", () => {
    const g = buildTxGraph([edge()]);
    expect(g.adjacency_out.get(A)).toHaveLength(1);
    expect(g.adjacency_out.get(A)![0].to).toBe(B);
  });

  it("builds adjacency_in correctly", () => {
    const g = buildTxGraph([edge()]);
    expect(g.adjacency_in.get(B)).toHaveLength(1);
    expect(g.adjacency_in.get(B)![0].from).toBe(A);
  });

  it("fee_payer_map groups wallets by shared fee payer", () => {
    const edges = [
      edge({ from: A, to: B, fee_payer: FP }),
      edge({ from: C, to: B, fee_payer: FP, tx_signature: "sig2" }),
    ];
    const g = buildTxGraph(edges);
    const group = g.fee_payer_map.get(FP)!;
    expect(group.has(A)).toBe(true);
    expect(group.has(B)).toBe(true);
    expect(group.has(C)).toBe(true);
  });

  it("does not add fee_payer entry when fee_payer equals from", () => {
    const g = buildTxGraph([edge({ fee_payer: A })]);
    // fee_payer === from → should NOT create a fee_payer_map entry for A
    expect(g.fee_payer_map.has(A)).toBe(false);
  });

  it("does not add fee_payer to fee_payer_map when fee_payer is empty string", () => {
    const g = buildTxGraph([edge({ fee_payer: "" })]);
    expect(g.fee_payer_map.size).toBe(0);
  });

  it("handles empty edge list", () => {
    const g = buildTxGraph([]);
    expect(g.nodes.size).toBe(0);
    expect(g.edges).toHaveLength(0);
    expect(g.adjacency_out.size).toBe(0);
    expect(g.adjacency_in.size).toBe(0);
    expect(g.fee_payer_map.size).toBe(0);
  });

  it("accumulates multiple edges from the same source", () => {
    const edges = [
      edge({ from: A, to: B, tx_signature: "sig1" }),
      edge({ from: A, to: C, tx_signature: "sig2" }),
    ];
    const g = buildTxGraph(edges);
    expect(g.adjacency_out.get(A)).toHaveLength(2);
  });

  it("preserves all edge fields", () => {
    const e = edge();
    const g = buildTxGraph([e]);
    expect(g.edges[0]).toEqual(e);
  });
});

describe("heliusTxsToEdges", () => {
  it("extracts native SOL transfers", () => {
    const txs = [{
      signature: "sig1",
      feePayer: FP,
      timestamp: 1_700_000_000,
      type: "TRANSFER",
      nativeTransfers: [{ fromUserAccount: A, toUserAccount: B, amount: 5_000_000 }],
      tokenTransfers: [],
    }];
    const edges = heliusTxsToEdges(txs, A);
    expect(edges).toHaveLength(1);
    expect(edges[0].from).toBe(A);
    expect(edges[0].to).toBe(B);
    expect(edges[0].value_lamports).toBe(5_000_000);
    expect(edges[0].fee_payer).toBe(FP);
    expect(edges[0].program).toBe("TRANSFER");
  });

  it("extracts token transfers with value_lamports === 0", () => {
    const txs = [{
      signature: "sig2",
      feePayer: FP,
      timestamp: 1_700_000_001,
      type: "TOKEN_TRANSFER",
      nativeTransfers: [],
      tokenTransfers: [{ fromUserAccount: A, toUserAccount: B, programId: "TokenkebQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" }],
    }];
    const edges = heliusTxsToEdges(txs, A);
    expect(edges).toHaveLength(1);
    expect(edges[0].value_lamports).toBe(0);
    expect(edges[0].program).toBe("TokenkebQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  });

  it("skips native transfers with missing accounts", () => {
    const txs = [{
      signature: "sig3",
      feePayer: FP,
      timestamp: 1_700_000_002,
      nativeTransfers: [{ fromUserAccount: null, toUserAccount: B, amount: 1000 }],
      tokenTransfers: [],
    }];
    const edges = heliusTxsToEdges(txs, A);
    expect(edges).toHaveLength(0);
  });

  it("skips token transfers with missing accounts", () => {
    const txs = [{
      signature: "sig4",
      feePayer: FP,
      timestamp: 1_700_000_003,
      nativeTransfers: [],
      tokenTransfers: [{ fromUserAccount: A, toUserAccount: null }],
    }];
    const edges = heliusTxsToEdges(txs, A);
    expect(edges).toHaveLength(0);
  });

  it("falls back to fee_payer='' when feePayer missing", () => {
    const txs = [{
      signature: "sig5",
      timestamp: 1_700_000_004,
      nativeTransfers: [{ fromUserAccount: A, toUserAccount: B, amount: 1000 }],
      tokenTransfers: [],
    }];
    const edges = heliusTxsToEdges(txs, A);
    expect(edges[0].fee_payer).toBe("");
  });

  it("falls back to block_time=0 when timestamp missing", () => {
    const txs = [{
      signature: "sig6",
      feePayer: FP,
      nativeTransfers: [{ fromUserAccount: A, toUserAccount: B, amount: 1000 }],
      tokenTransfers: [],
    }];
    const edges = heliusTxsToEdges(txs, A);
    expect(edges[0].block_time).toBe(0);
  });

  it("handles transactions with both native and token transfers", () => {
    const txs = [{
      signature: "sig7",
      feePayer: FP,
      timestamp: 1_700_000_005,
      type: "SWAP",
      nativeTransfers: [{ fromUserAccount: A, toUserAccount: B, amount: 1000 }],
      tokenTransfers: [{ fromUserAccount: B, toUserAccount: A, programId: "TOKEN" }],
    }];
    const edges = heliusTxsToEdges(txs, A);
    expect(edges).toHaveLength(2);
  });

  it("returns empty array for transactions with no transfers", () => {
    const txs = [{
      signature: "sig8",
      feePayer: FP,
      timestamp: 1_700_000_006,
      nativeTransfers: [],
      tokenTransfers: [],
    }];
    expect(heliusTxsToEdges(txs, A)).toHaveLength(0);
  });

  it("returns empty array for empty transaction list", () => {
    expect(heliusTxsToEdges([], A)).toHaveLength(0);
  });
});

describe("request-scoped graph cache", () => {
  beforeEach(() => clearRequestCache());

  it("returns null for a key that was never set", () => {
    expect(getCachedGraph("missing")).toBeNull();
  });

  it("stores and retrieves a graph", () => {
    const g = buildTxGraph([edge()]);
    setCachedGraph("wallet:A", g);
    expect(getCachedGraph("wallet:A")).toBe(g);
  });

  it("clearRequestCache removes all entries", () => {
    const g = buildTxGraph([edge()]);
    setCachedGraph("wallet:A", g);
    setCachedGraph("wallet:B", g);
    clearRequestCache();
    expect(getCachedGraph("wallet:A")).toBeNull();
    expect(getCachedGraph("wallet:B")).toBeNull();
  });

  it("different keys are independent", () => {
    const g1 = buildTxGraph([edge({ tx_signature: "sig1" })]);
    const g2 = buildTxGraph([edge({ tx_signature: "sig2" })]);
    setCachedGraph("key1", g1);
    setCachedGraph("key2", g2);
    expect(getCachedGraph("key1")).toBe(g1);
    expect(getCachedGraph("key2")).toBe(g2);
  });
});
