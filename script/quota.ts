#!/usr/bin/env npx tsx

/**
 * Antigravity Quota CLI
 * 
 * Displays quota information for all configured Antigravity accounts.
 * 
 * Usage:
 *   npx tsx script/quota.ts           # Simple 2-pool view (Claude + Gemini)
 *   npx tsx script/quota.ts --full    # Full model breakdown
 *   npx tsx script/quota.ts --json    # Output as JSON
 */

import { 
  fetchAllAccountQuotas, 
  generateQuotaTable, 
  generateQuotaJson,
  generateSimpleQuotaTable,
} from "../src/plugin/quota";

async function main() {
  const args = process.argv.slice(2);
  const isJson = args.includes("--json") || args.includes("-j");
  const isFull = args.includes("--full") || args.includes("-f");

  try {
    const results = await fetchAllAccountQuotas();

    if (isJson) {
      console.log(generateQuotaJson(results));
    } else if (isFull) {
      console.log(generateQuotaTable(results));
    } else {
      // Default: simple 2-pool view
      console.log(generateSimpleQuotaTable(results));
    }
  } catch (error) {
    console.error("Error fetching quotas:", error);
    process.exit(1);
  }
}

main();
