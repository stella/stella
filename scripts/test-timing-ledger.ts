// Budget ledger of the `test-timing` lint rules.
//
// scripts/test-timing-ledger.json lists the test sites that still wait on the
// clock instead of on the work they exercise (mechanics:
// scripts/plugin-budget-ledger.ts).
//
//   bun scripts/test-timing-ledger.ts --write        regenerate from the code
//   bun scripts/test-timing-ledger.ts --base <ref>   CI: the ledger only shrinks
//   bun scripts/test-timing-ledger.ts --self-test    the checks work

import path from "node:path";

import { relocateLedgerEntries } from "./ledger-membership.ts";
import { runPluginBudgetLedger } from "./plugin-budget-ledger.ts";

if (import.meta.main) {
  process.exit(
    runPluginBudgetLedger({
      plugin: "test-timing",
      censusTargets: ["apps", "packages", "scripts"],
      todoReason: "TODO: say why this test waits on the clock",
      remediation:
        "await the work's own completion signal or drive fake timers instead of budgeting a new site",
      normalizeBaseEntries: (options) =>
        relocateLedgerEntries({
          ...options,
          repoRoot: path.resolve(import.meta.dir, ".."),
          pathIndex: 1,
        }),
      args: process.argv.slice(2),
    }),
  );
}
