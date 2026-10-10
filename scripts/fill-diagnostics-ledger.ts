// Budget ledger of the `fill-diagnostics` lint rules.
//
// scripts/fill-diagnostics-ledger.json lists the sites that still run a fill
// without its completion decision, decide on one diagnostic kind, write a
// fill status literal, carry a diagnostic channel beside the record, or write
// a fill row past the recorder (mechanics: scripts/plugin-budget-ledger.ts).
//
//   bun scripts/fill-diagnostics-ledger.ts --write        regenerate from the code
//   bun scripts/fill-diagnostics-ledger.ts --base <ref>   CI: the ledger only shrinks
//   bun scripts/fill-diagnostics-ledger.ts --self-test    the checks work

import { runPluginBudgetLedger } from "./plugin-budget-ledger.ts";

if (import.meta.main) {
  process.exit(
    runPluginBudgetLedger({
      plugin: "fill-diagnostics",
      censusTargets: ["apps/api/src", "apps/web/src", "packages"],
      todoReason: "TODO: say why this site stays off the completion decision",
      remediation:
        "read the fill's status from decideTemplateFillCompletion instead of budgeting a new site",
      args: process.argv.slice(2),
    }),
  );
}
