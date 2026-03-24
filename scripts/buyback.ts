import {
  createPublicClient,
  createWalletClient,
  http,
  formatUnits,
} from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { appendFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = join(__dirname, "../logs");
const LOG_FILE = join(LOG_DIR, "buyback.log");

mkdirSync(LOG_DIR, { recursive: true });

// ── Config ──────────────────────────────────────────────────────────────────

const DRY_RUN = process.env.DRY_RUN !== "false"; // default: dry-run
const INTERVAL_MINUTES = parseInt(
  process.env.BUYBACK_INTERVAL_MINUTES ?? "60",
  10
);
const THRESHOLD_USDC = parseFloat(
  process.env.BUYBACK_THRESHOLD_USDC ?? "5.0"
);
const AGENT_WALLET_PRIVATE_KEY = process.env
  .AGENT_WALLET_PRIVATE_KEY as `0x${string}` | undefined;
const SPROBE_TOKEN_ADDRESS = process.env
  .SPROBE_TOKEN_ADDRESS as `0x${string}` | undefined;

// USDC on Base mainnet
const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const USDC_DECIMALS = 6;

// Token burn destination
const DEAD_ADDRESS =
  "0x000000000000000000000000000000000000dEaD" as const;

// Minimal ERC-20 ABI (balanceOf + transfer)
const ERC20_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "transfer",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

// ── Logging ─────────────────────────────────────────────────────────────────

function log(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  appendFileSync(LOG_FILE, line + "\n");
}

// ── Core ─────────────────────────────────────────────────────────────────────

async function checkAndBuyback(): Promise<void> {
  if (!AGENT_WALLET_PRIVATE_KEY) {
    log("WARN: AGENT_WALLET_PRIVATE_KEY not set — skipping cycle");
    return;
  }

  const account = privateKeyToAccount(AGENT_WALLET_PRIVATE_KEY);
  const publicClient = createPublicClient({ chain: base, transport: http() });

  // Read USDC balance on Base
  const rawBalance = await publicClient.readContract({
    address: USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [account.address],
  });

  const balanceUsdc = parseFloat(formatUnits(rawBalance, USDC_DECIMALS));
  log(
    `Wallet ${account.address} USDC balance: $${balanceUsdc.toFixed(4)} (threshold: $${THRESHOLD_USDC})`
  );

  if (balanceUsdc < THRESHOLD_USDC) {
    log("Below threshold — no buyback this cycle");
    return;
  }

  if (!SPROBE_TOKEN_ADDRESS) {
    log(
      "WARN: SPROBE_TOKEN_ADDRESS not set — set it after token launch before going live"
    );
    return;
  }

  // 30% of revenue flows to buyback & burn per the token economics split
  const buyAmountUsdc = balanceUsdc * 0.3;

  log(
    `Threshold met. Buyback: $${buyAmountUsdc.toFixed(4)} USDC → SPROBE → burn to ${DEAD_ADDRESS}`
  );

  if (DRY_RUN) {
    log("DRY_RUN=true — no transaction sent (set DRY_RUN=false to go live)");
    return;
  }

  // ── Live mode ────────────────────────────────────────────────────────────
  // TODO: Integrate a DEX router (e.g. Uniswap v3 on Base) to swap USDC → SPROBE,
  // then call transfer(DEAD_ADDRESS, balance) on the SPROBE contract to burn.
  // Implement this after SPROBE is deployed and liquidity is live.
  const _walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(),
  });
  log(
    "WARN: Live DEX swap not yet implemented. Set DRY_RUN=true until DEX integration is complete."
  );
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log(
    `SolProbe buyback daemon starting — DRY_RUN=${DRY_RUN}, interval=${INTERVAL_MINUTES}m, threshold=$${THRESHOLD_USDC}`
  );

  // Run immediately on startup, then on the configured interval
  try {
    await checkAndBuyback();
  } catch (err) {
    log(`ERROR on startup: ${String(err)}`);
  }

  setInterval(async () => {
    try {
      await checkAndBuyback();
    } catch (err) {
      log(`ERROR: ${String(err)}`);
    }
  }, INTERVAL_MINUTES * 60 * 1000);
}

main().catch((err) => {
  log(`FATAL: ${String(err)}`);
  process.exit(1);
});
