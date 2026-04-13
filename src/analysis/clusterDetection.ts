import { TxGraph, TxEdge } from "./walletGraph.js";

// Addresses that must never be used as clustering seeds
// A CEX or DEX as fee payer connects thousands of unrelated wallets
const EXCLUDED_CLUSTERING_SEEDS = new Set([
  // Known DEX programs
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",  // Raydium AMM
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",   // Orca Whirlpool
  "9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP", // Orca AMM
  // Burn addresses
  "1nc1nerator11111111111111111111111111111111",
  "11111111111111111111111111111111",
  // Add known CEX hot wallets here as they are identified
]);

export interface ClusterResult {
  cluster_id: string;                  // unique identifier for this cluster
  wallets: string[];                   // wallet addresses in this cluster
  confidence: number;                  // 0.0–1.0
  signals: ClusterSignal[];            // which signals contributed
  common_fee_payer: string | null;     // if fee payer pattern detected
  supply_pct_combined: number | null;  // combined supply % (deep dive only)
}

export interface ClusterSignal {
  type: "FEE_PAYER" | "FAN_OUT" | "TEMPORAL";
  strength: "STRONG" | "MEDIUM" | "WEAK";
  description: string;
}

export interface ClusterDetectionResult {
  clusters: ClusterResult[];
  total_clustered_wallets: number;
  largest_cluster_size: number;
  highest_confidence: number;
}

// Temporal window for co-occurrence detection (seconds)
const TEMPORAL_WINDOW_SECONDS = 300;  // 5 minutes

// Minimum edge count to consider a fee payer relationship significant
const MIN_FEE_PAYER_EDGES = 2;

// BFS confidence threshold — clusters below this are discarded
const MIN_CLUSTER_CONFIDENCE = 0.4;

export function detectClusters(
  graph: TxGraph,
  targetWallets: string[],      // wallets to analyse (top holders + dev)
  tokenCreationTime: number | null  // for temporal weighting
): ClusterDetectionResult {

  // Build connection matrix from three signals
  const connectionStrength = new Map<string, Map<string, number>>();

  function addConnection(a: string, b: string, weight: number): void {
    if (a === b) return;
    if (EXCLUDED_CLUSTERING_SEEDS.has(a) || EXCLUDED_CLUSTERING_SEEDS.has(b)) return;

    if (!connectionStrength.has(a)) connectionStrength.set(a, new Map());
    if (!connectionStrength.has(b)) connectionStrength.set(b, new Map());

    const existing_ab = connectionStrength.get(a)!.get(b) ?? 0;
    const existing_ba = connectionStrength.get(b)!.get(a) ?? 0;
    connectionStrength.get(a)!.set(b, existing_ab + weight);
    connectionStrength.get(b)!.set(a, existing_ba + weight);
  }

  // Signal 1: Fee payer patterns (weight: 0.8 — strongest signal)
  for (const [fee_payer, wallets] of graph.fee_payer_map.entries()) {
    if (EXCLUDED_CLUSTERING_SEEDS.has(fee_payer)) continue;
    const walletList = [...wallets].filter(w => targetWallets.includes(w));
    if (walletList.length < MIN_FEE_PAYER_EDGES) continue;

    // All wallets sharing this fee payer are connected to each other
    for (let i = 0; i < walletList.length; i++) {
      for (let j = i + 1; j < walletList.length; j++) {
        // Weight by temporal proximity to token launch if known
        let weight = 0.8;
        if (tokenCreationTime !== null) {
          const earliest_edge = graph.edges
            .filter(e =>
              (e.from === walletList[i] || e.to === walletList[i]) &&
              e.fee_payer === fee_payer
            )
            .sort((a, b) => a.block_time - b.block_time)[0];

          if (earliest_edge) {
            const hours_from_launch =
              (earliest_edge.block_time - tokenCreationTime) / 3600;
            // Boost weight if activity was within 1 hour of token launch
            if (hours_from_launch < 1) weight = 1.0;
            else if (hours_from_launch < 24) weight = 0.9;
          }
        }
        addConnection(walletList[i], walletList[j], weight);
      }
    }
  }

  // Signal 2: Fan-out/fan-in patterns (weight: 0.6)
  // One wallet distributes to many targets within TEMPORAL_WINDOW_SECONDS
  // then those targets converge back (sybil pattern)
  for (const sourceWallet of targetWallets) {
    const outEdges = graph.adjacency_out.get(sourceWallet) ?? [];

    // Group outgoing edges by time bucket (5-min windows)
    const timeBuckets = new Map<number, TxEdge[]>();
    for (const edge of outEdges) {
      const bucket = Math.floor(edge.block_time / TEMPORAL_WINDOW_SECONDS);
      if (!timeBuckets.has(bucket)) timeBuckets.set(bucket, []);
      timeBuckets.get(bucket)!.push(edge);
    }

    for (const [, bucketEdges] of timeBuckets.entries()) {
      // Fan-out: one source → multiple targets in same window
      const targets = [...new Set(bucketEdges.map(e => e.to))]
        .filter(t => targetWallets.includes(t) && t !== sourceWallet);

      if (targets.length >= 2) {
        // Check for fan-in back to the source within 24 hours
        for (const target of targets) {
          const hasReturn = (graph.adjacency_out.get(target) ?? [])
            .some(e =>
              e.to === sourceWallet &&
              Math.abs(e.block_time - bucketEdges[0].block_time) < 86400
            );
          if (hasReturn) {
            // Confirmed fan-out/fan-in — strong circular pattern
            for (let i = 0; i < targets.length; i++) {
              for (let j = i + 1; j < targets.length; j++) {
                addConnection(targets[i], targets[j], 0.6);
              }
            }
          }
        }
      }
    }
  }

  // Signal 3: Temporal co-occurrence (weight: 0.4)
  // Wallets transacting in coordinated bursts
  const targetEdges = graph.edges.filter(
    e => targetWallets.includes(e.from) || targetWallets.includes(e.to)
  );

  const timeBuckets = new Map<number, string[]>();
  for (const edge of targetEdges) {
    const bucket = Math.floor(edge.block_time / TEMPORAL_WINDOW_SECONDS);
    if (!timeBuckets.has(bucket)) timeBuckets.set(bucket, []);
    const walletsInEdge = [edge.from, edge.to].filter(w => targetWallets.includes(w));
    timeBuckets.get(bucket)!.push(...walletsInEdge);
  }

  for (const [, walletList] of timeBuckets.entries()) {
    const unique = [...new Set(walletList)];
    if (unique.length < 2) continue;
    // Multiple target wallets active in same 5-min window
    for (let i = 0; i < unique.length; i++) {
      for (let j = i + 1; j < unique.length; j++) {
        addConnection(unique[i], unique[j], 0.4);
      }
    }
  }

  // BFS to find connected components above confidence threshold
  const visited = new Set<string>();
  const clusters: ClusterResult[] = [];

  for (const startWallet of targetWallets) {
    if (visited.has(startWallet)) continue;

    const cluster: string[] = [];
    const queue = [startWallet];
    visited.add(startWallet);

    while (queue.length > 0) {
      const current = queue.shift()!;
      cluster.push(current);

      const connections = connectionStrength.get(current) ?? new Map();
      for (const [neighbor, strength] of connections.entries()) {
        if (!visited.has(neighbor) &&
            targetWallets.includes(neighbor) &&
            strength >= MIN_CLUSTER_CONFIDENCE) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }

    if (cluster.length < 2) continue;  // singleton — not a cluster

    // Compute cluster confidence from average connection strength
    let totalStrength = 0;
    let edgeCount = 0;
    for (let i = 0; i < cluster.length; i++) {
      for (let j = i + 1; j < cluster.length; j++) {
        const strength = connectionStrength.get(cluster[i])?.get(cluster[j]) ?? 0;
        if (strength > 0) { totalStrength += strength; edgeCount++; }
      }
    }
    const confidence = edgeCount > 0 ? Math.min(1, totalStrength / edgeCount) : 0;

    // Identify which signals contributed
    const signals: ClusterSignal[] = [];
    const sharedFeePayers = [...graph.fee_payer_map.entries()]
      .filter(([fp, wallets]) =>
        !EXCLUDED_CLUSTERING_SEEDS.has(fp) &&
        cluster.filter(w => wallets.has(w)).length >= 2
      );

    if (sharedFeePayers.length > 0) {
      signals.push({
        type: "FEE_PAYER",
        strength: "STRONG",
        description: `${cluster.length} wallets share common fee payer`,
      });
    }

    const commonFeePayer = sharedFeePayers.length > 0
      ? sharedFeePayers[0][0]
      : null;

    clusters.push({
      cluster_id: `cluster_${clusters.length + 1}`,
      wallets: cluster,
      confidence: Math.round(confidence * 100) / 100,
      signals,
      common_fee_payer: commonFeePayer,
      supply_pct_combined: null,  // populated by deep dive after holder data
    });
  }

  return {
    clusters,
    total_clustered_wallets: clusters.reduce((s, c) => s + c.wallets.length, 0),
    largest_cluster_size: clusters.length > 0
      ? Math.max(...clusters.map(c => c.wallets.length))
      : 0,
    highest_confidence: clusters.length > 0
      ? Math.max(...clusters.map(c => c.confidence))
      : 0,
  };
}
