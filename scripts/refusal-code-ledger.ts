// Budget ledger of the `refusal-code` lint rule.
//
// scripts/refusal-code-ledger.json lists the client refusals (4xx
// HandlerErrors other than 401 and 403) that still carry no `code`, so clients
// cannot say why they were refused (mechanics: scripts/plugin-budget-ledger.ts).
//
//   bun scripts/refusal-code-ledger.ts --write        regenerate from the code
//   bun scripts/refusal-code-ledger.ts --base <ref>   CI: the ledger only shrinks
//   bun scripts/refusal-code-ledger.ts --self-test    the checks work

import { runPluginBudgetLedger } from "./plugin-budget-ledger.ts";

if (import.meta.main) {
  process.exit(
    runPluginBudgetLedger({
      plugin: "refusal-code",
      censusTargets: ["apps/api/src", ".oxlint-plugins/__fixtures__"],
      todoReason: "TODO: say why this refusal carries no code",
      remediation:
        "give the HandlerError a stable code instead of budgeting a new codeless refusal",
      args: process.argv.slice(2),
    }),
  );
}
