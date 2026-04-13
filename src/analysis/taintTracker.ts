import { TxGraph } from "./walletGraph.js";

// Decay factor per hop — 0.6 means 3 hops = 0.216 taint score
// Calibrated for Solana's high TPS (lower than Ethereum equivalents)
const DECAY_ALPHA = 0.6;

// Hard limits to stay within SLA
const MAX_HOPS = 3;
const MAX_NODES_VISITED = 500;

export interface TaintResult {
  taint_score: number;       // 0.0–1.0 (1.0 = direct connection to bad actor)
  taint_level: "NONE" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  hops_from_seed: number | null;  // shortest path to any seed
  closest_seed: string | null;    // nearest bad actor address
  seeds_reachable: number;        // how many bad actor seeds can reach this wallet
  graph_limit_hit: boolean;       // true if MAX_NODES_VISITED was hit
  meaning: string;
  action_guidance: string;
}

export function propagateTaint(
  graph: TxGraph,
  targetAddress: string,
  seedAddresses: string[]   // known rug deployers, exploit wallets
): TaintResult {

  if (seedAddresses.length === 0) {
    return buildTaintResult(0, null, null, 0, false);
  }

  // BFS from each seed, propagating taint with decay
  // We build a reverse BFS — start from seeds, see if we reach target
  const taintScores = new Map<string, number>();  // address → max taint reaching it
  const hopsFromSeed = new Map<string, number>();
  const closestSeed = new Map<string, string>();

  const queue: Array<{ address: string; taint: number; hops: number; seed: string }> = [];
  let nodesVisited = 0;
  let graphLimitHit = false;

  // Initialize queue with all seeds at full taint
  for (const seed of seedAddresses) {
    if (graph.nodes.has(seed)) {
      queue.push({ address: seed, taint: 1.0, hops: 0, seed });
      taintScores.set(seed, 1.0);
      hopsFromSeed.set(seed, 0);
      closestSeed.set(seed, seed);
    }
  }

  while (queue.length > 0 && nodesVisited < MAX_NODES_VISITED) {
    const { address, taint, hops, seed } = queue.shift()!;
    nodesVisited++;

    if (hops >= MAX_HOPS) continue;

    // Propagate to all wallets this address has transacted with
    const outEdges = graph.adjacency_out.get(address) ?? [];
    const inEdges = graph.adjacency_in.get(address) ?? [];
    const neighbors = [
      ...outEdges.map(e => e.to),
      ...inEdges.map(e => e.from),
    ];

    for (const neighbor of neighbors) {
      const decayedTaint = taint * DECAY_ALPHA;
      const existingTaint = taintScores.get(neighbor) ?? 0;

      if (decayedTaint > existingTaint) {
        taintScores.set(neighbor, decayedTaint);
        hopsFromSeed.set(neighbor, hops + 1);
        closestSeed.set(neighbor, seed);
        queue.push({
          address: neighbor,
          taint: decayedTaint,
          hops: hops + 1,
          seed,
        });
      }
    }
  }

  if (nodesVisited >= MAX_NODES_VISITED) graphLimitHit = true;

  const targetTaint = taintScores.get(targetAddress) ?? 0;
  const targetHops = hopsFromSeed.get(targetAddress) ?? null;
  const targetSeed = closestSeed.get(targetAddress) ?? null;

  // Count distinct seeds that can reach the target
  const seedsReachable = seedAddresses.filter(s => {
    // A seed reaches target if target's closest_seed chain leads back to it
    // Simpler: count seeds that are themselves in closestSeed values for target
    return closestSeed.get(targetAddress) === s;
  }).length;

  return buildTaintResult(
    targetTaint,
    targetHops,
    targetSeed,
    seedsReachable,
    graphLimitHit
  );
}

function buildTaintResult(
  score: number,
  hops: number | null,
  seed: string | null,
  seeds_reachable: number,
  graph_limit_hit: boolean
): TaintResult {

  const rounded = Math.round(score * 1000) / 1000;

  const level: TaintResult["taint_level"] =
    rounded >= 1.0 ? "CRITICAL"
    : rounded >= 0.6 ? "HIGH"
    : rounded >= 0.3 ? "MEDIUM"
    : rounded > 0   ? "LOW"
    : "NONE";

  const TAINT_STATIC: Record<string, { meaning: string; action_guidance: string }> = {
    CRITICAL: {
      meaning: "Direct connection to a known rug deployer or exploit wallet.",
      action_guidance: "Do not interact. This wallet is directly linked to confirmed bad actors.",
    },
    HIGH: {
      meaning: "Strong indirect connection to known bad actors within 1–2 hops.",
      action_guidance: "High counterparty risk. Treat as potentially controlled by or coordinating with bad actors.",
    },
    MEDIUM: {
      meaning: "Moderate indirect connection to known bad actors within 2–3 hops.",
      action_guidance: "Elevated caution warranted. Verify wallet independently before significant interaction.",
    },
    LOW: {
      meaning: "Weak indirect connection to known bad actors at the edge of the propagation graph.",
      action_guidance: "Low taint signal. Background contamination rather than direct risk.",
    },
    NONE: {
      meaning: "No detectable connection to known rug deployers or exploit wallets in the analysed graph.",
      action_guidance: "No taint risk detected within the analysed hop limit.",
    },
  };

  return {
    taint_score: rounded,
    taint_level: level,
    hops_from_seed: hops,
    closest_seed: seed,
    seeds_reachable,
    graph_limit_hit,
    meaning: TAINT_STATIC[level].meaning,
    action_guidance: TAINT_STATIC[level].action_guidance,
  };
}
