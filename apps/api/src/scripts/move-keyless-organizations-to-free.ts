/**
 * Move blanket-backfilled organizations without an organization model key to
 * the free floor.
 *
 *   bun run src/scripts/move-keyless-organizations-to-free.ts [--apply]
 *
 * Run after `record-missing-organization-access-states`, once the active free
 * policy is seeded, immediately before turning on FEATURE_ORG_ACCESS_STATE.
 * The default is a read-only dry run; `--apply` performs one transactional
 * set-based update.
 */
import { panic } from "better-result";

import { runScriptWithErrorOutput } from "@stll/errors/script-error";

import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import { openMaintenanceDb } from "@/api/lib/db/maintenance-db";
import {
  applyKeylessOrganizationMoves,
  classifyKeylessOrganizationMoves,
} from "@/api/scripts/move-keyless-organizations-to-free.logic";

const args = process.argv.slice(2);
const apply = args.length === 1 && args.at(0) === "--apply";
if (args.length > (apply ? 1 : 0)) {
  panic("Usage: move-keyless-organizations-to-free.ts [--apply]");
}

const db = openMaintenanceDb({ readOnly: !apply });
await runScriptWithErrorOutput(async () => {
  const results = await withAggregateTransaction(db, async (tx) =>
    apply
      ? await applyKeylessOrganizationMoves(tx, { now: new Date() })
      : await classifyKeylessOrganizationMoves(tx),
  );

  for (const result of results) {
    console.log(JSON.stringify(result));
  }
  const counts = new Map<string, number>();
  for (const { outcome } of results) {
    counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
  }
  const totals = Object.fromEntries(counts);
  console.log(JSON.stringify({ totals }));
});
