/**
 * Antigravity CLI
 * 
 * Usage:
 *   npx opencode-antigravity-auth quota           # Simple 2-pool view
 *   npx opencode-antigravity-auth quota --full    # Full model breakdown
 *   npx opencode-antigravity-auth quota --json    # JSON output
 */

import { 
  fetchAllAccountQuotas, 
  generateQuotaTable, 
  generateQuotaJson,
  generateSimpleQuotaTable,
} from "./plugin/quota";

const args = process.argv.slice(2);
const command = args[0];

async function main() {
  if (command === "quota") {
    const isJson = args.includes("--json") || args.includes("-j");
    const isFull = args.includes("--full") || args.includes("-f");

    try {
      const results = await fetchAllAccountQuotas();

      if (isJson) {
        console.log(generateQuotaJson(results));
      } else if (isFull) {
        console.log(generateQuotaTable(results));
      } else {
        console.log(generateSimpleQuotaTable(results));
      }
    } catch (error) {
      console.error("Error fetching quotas:", error);
      process.exit(1);
    }
  } else {
    console.log(`opencode-antigravity-auth CLI

Commands:
  quota           Show account quota status (Claude + Gemini pools)
  quota --full    Show full model breakdown
  quota --json    Output as JSON

Usage:
  npx opencode-antigravity-auth quota
`);
  }
}

main();
