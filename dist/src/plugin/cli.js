import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
/**
 * Prompts the user for a project ID via stdin/stdout.
 */
export async function promptProjectId() {
    const rl = createInterface({ input, output });
    try {
        const answer = await rl.question("Project ID (leave blank to use your default project): ");
        return answer.trim();
    }
    finally {
        rl.close();
    }
}
/**
 * Prompts user whether they want to add another OAuth account.
 */
export async function promptAddAnotherAccount(currentCount) {
    const rl = createInterface({ input, output });
    try {
        const answer = await rl.question(`Add another account? (${currentCount} added) (y/n): `);
        const normalized = answer.trim().toLowerCase();
        return normalized === "y" || normalized === "yes";
    }
    finally {
        rl.close();
    }
}
/**
 * Prompts user to choose login mode when accounts already exist.
 * Returns "add" to append new accounts, "fresh" to clear and start over.
 */
export async function promptLoginMode(existingAccounts) {
    const rl = createInterface({ input, output });
    try {
        console.log(`\n${existingAccounts.length} account(s) saved:`);
        for (const acc of existingAccounts) {
            const label = acc.email || `Account ${acc.index + 1}`;
            console.log(`  ${acc.index + 1}. ${label}`);
        }
        console.log("");
        while (true) {
            const answer = await rl.question("(a)dd new account(s) or (f)resh start? [a/f]: ");
            const normalized = answer.trim().toLowerCase();
            if (normalized === "a" || normalized === "add") {
                return "add";
            }
            if (normalized === "f" || normalized === "fresh") {
                return "fresh";
            }
            console.log("Please enter 'a' to add accounts or 'f' to start fresh.");
        }
    }
    finally {
        rl.close();
    }
}
//# sourceMappingURL=cli.js.map