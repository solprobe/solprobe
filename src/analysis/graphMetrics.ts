import { TxGraph } from "./walletGraph.js";

export interface FanSymmetryResult {
  fan_out: number;           // unique wallets this address sends to
  fan_in: number;            // unique wallets this address receives from
  symmetry_score: number;    // 0.0–1.0 (1.0 = perfectly symmetric = wash trading)
  net_flow_lamports: number; // positive = net sender, negative = net receiver
  wash_indicator: boolean;   // true when symmetry_score > 0.7
}

export function computeFanSymmetry(
  graph: TxGraph,
  address: string,
  timeWindowSeconds?: number  // optional — restrict to window
): FanSymmetryResult {

  let outEdges = graph.adjacency_out.get(address) ?? [];
  let inEdges = graph.adjacency_in.get(address) ?? [];

  if (timeWindowSeconds !== undefined) {
    const cutoff = Date.now() / 1000 - timeWindowSeconds;
    outEdges = outEdges.filter(e => e.block_time >= cutoff);
    inEdges = inEdges.filter(e => e.block_time >= cutoff);
  }

  const uniqueTargets = new Set(outEdges.map(e => e.to));
  const uniqueSources = new Set(inEdges.map(e => e.from));
  const fan_out = uniqueTargets.size;
  const fan_in = uniqueSources.size;

  // Symmetry: how similar are fan-in and fan-out counts?
  // Also check address overlap — same wallets on both sides is stronger signal
  const overlap = [...uniqueTargets].filter(t => uniqueSources.has(t)).length;
  const max_fan = Math.max(fan_out, fan_in);

  // Pure count symmetry
  const count_symmetry = max_fan === 0 ? 0
    : 1 - Math.abs(fan_out - fan_in) / max_fan;

  // Address overlap symmetry — wallets appearing on both sides
  const overlap_ratio = max_fan === 0 ? 0 : overlap / max_fan;

  // Combined symmetry score — overlap weighted more heavily
  const symmetry_score = count_symmetry * 0.4 + overlap_ratio * 0.6;

  const net_flow =
    outEdges.reduce((s, e) => s + e.value_lamports, 0) -
    inEdges.reduce((s, e) => s + e.value_lamports, 0);

  return {
    fan_out,
    fan_in,
    symmetry_score: Math.round(symmetry_score * 1000) / 1000,
    net_flow_lamports: net_flow,
    wash_indicator: symmetry_score > 0.7,
  };
}
