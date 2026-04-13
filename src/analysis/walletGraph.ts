// Core graph data structures and builder for wallet transaction graphs.
// Used by clusterDetection.ts, taintTracker.ts, and graphMetrics.ts.

export interface TxEdge {
  from: string;          // source wallet address
  to: string;            // destination wallet address
  value_lamports: number;
  block_time: number;    // Unix timestamp
  program: string;       // program ID that processed this tx
  tx_signature: string;
  fee_payer: string;     // explicit fee payer — key clustering signal
}

export interface TxGraph {
  nodes: Set<string>;                        // all wallet addresses
  edges: TxEdge[];
  adjacency_out: Map<string, TxEdge[]>;     // from → edges
  adjacency_in: Map<string, TxEdge[]>;      // to → edges
  fee_payer_map: Map<string, Set<string>>;  // fee_payer → wallets it paid for
}

export function buildTxGraph(edges: TxEdge[]): TxGraph {
  const nodes = new Set<string>();
  const adjacency_out = new Map<string, TxEdge[]>();
  const adjacency_in = new Map<string, TxEdge[]>();
  const fee_payer_map = new Map<string, Set<string>>();

  for (const edge of edges) {
    nodes.add(edge.from);
    nodes.add(edge.to);
    if (edge.fee_payer) nodes.add(edge.fee_payer);

    // Build adjacency lists
    if (!adjacency_out.has(edge.from)) adjacency_out.set(edge.from, []);
    adjacency_out.get(edge.from)!.push(edge);

    if (!adjacency_in.has(edge.to)) adjacency_in.set(edge.to, []);
    adjacency_in.get(edge.to)!.push(edge);

    // Build fee payer map — the primary clustering signal
    if (edge.fee_payer && edge.fee_payer !== edge.from) {
      if (!fee_payer_map.has(edge.fee_payer)) {
        fee_payer_map.set(edge.fee_payer, new Set());
      }
      fee_payer_map.get(edge.fee_payer)!.add(edge.from);
      fee_payer_map.get(edge.fee_payer)!.add(edge.to);
    }
  }

  return { nodes, edges, adjacency_out, adjacency_in, fee_payer_map };
}

// ---------------------------------------------------------------------------
// Helius parsed transaction → TxEdge converter
// ---------------------------------------------------------------------------

export function heliusTxsToEdges(
  transactions: any[],  // Helius parsed transaction format
  walletAddress: string
): TxEdge[] {
  const edges: TxEdge[] = [];

  for (const tx of transactions) {
    const fee_payer = tx.feePayer ?? tx.fee_payer ?? "";
    const timestamp = tx.timestamp ?? tx.blockTime ?? 0;

    // Native SOL transfers
    for (const transfer of (tx.nativeTransfers ?? [])) {
      if (!transfer.fromUserAccount || !transfer.toUserAccount) continue;
      edges.push({
        from: transfer.fromUserAccount,
        to: transfer.toUserAccount,
        value_lamports: transfer.amount ?? 0,
        block_time: timestamp,
        program: tx.type ?? "TRANSFER",
        tx_signature: tx.signature,
        fee_payer,
      });
    }

    // Token transfers (include as edges with program = token program)
    for (const transfer of (tx.tokenTransfers ?? [])) {
      if (!transfer.fromUserAccount || !transfer.toUserAccount) continue;
      edges.push({
        from: transfer.fromUserAccount,
        to: transfer.toUserAccount,
        value_lamports: 0,  // token transfer — no lamport value
        block_time: timestamp,
        program: transfer.programId ?? "TOKEN",
        tx_signature: tx.signature,
        fee_payer,
      });
    }
  }

  return edges;
}

// ---------------------------------------------------------------------------
// Request-scoped graph cache
// Avoids rebuilding the same graph multiple times within one scan invocation.
// Never persists between calls — cleared at the end of each scanner run.
// ---------------------------------------------------------------------------

const requestGraphCache = new Map<string, TxGraph>();

export function getCachedGraph(key: string): TxGraph | null {
  return requestGraphCache.get(key) ?? null;
}

export function setCachedGraph(key: string, graph: TxGraph): void {
  requestGraphCache.set(key, graph);
}

export function clearRequestCache(): void {
  requestGraphCache.clear();
}
