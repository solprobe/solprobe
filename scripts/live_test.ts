/**
 * Live end-to-end test against real APIs.
 * Usage: npx tsx scripts/live_test.ts [address]
 * Default address: BONK
 */
import { quickScan } from "../src/scanner/quickScan.js";
import { deepDive } from "../src/scanner/deepDive.js";

const address = process.argv[2] ?? "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

(async () => {
  console.log(`\n=== quickScan: ${address} ===`);
  const qStart = Date.now();
  const quick = await quickScan(address);
  console.log(JSON.stringify(quick, null, 2));
  console.log(`Elapsed: ${Date.now() - qStart}ms\n`);

  console.log(`=== deepDive: ${address} ===`);
  const dStart = Date.now();
  const deep = await deepDive(address);
  console.log(JSON.stringify(deep, null, 2));
  console.log(`Elapsed: ${Date.now() - dStart}ms`);
})();
