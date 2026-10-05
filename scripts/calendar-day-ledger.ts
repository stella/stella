// Budget ledger of the `calendar-day` lint rules.
//
// scripts/calendar-day-ledger.json lists the sites that still read the UTC
// day as a user-facing day, or the wall clock in a scheduler task (mechanics:
// scripts/plugin-budget-ledger.ts).
//
//   bun scripts/calendar-day-ledger.ts --write        regenerate from the code
//   bun scripts/calendar-day-ledger.ts --base <ref>   CI: the ledger only shrinks
//   bun scripts/calendar-day-ledger.ts --self-test    the checks work

import { runPluginBudgetLedger } from "./plugin-budget-ledger.ts";

if (import.meta.main) {
  process.exit(
    runPluginBudgetLedger({
      plugin: "calendar-day",
      censusTargets: ["apps", ".oxlint-plugins/__fixtures__"],
      todoReason: "TODO: say why this site keeps its clock",
      remediation:
        "read the day through todayFor(zone) or decide on ctx.dueAt instead of budgeting a new site",
      args: process.argv.slice(2),
    }),
  );
}
