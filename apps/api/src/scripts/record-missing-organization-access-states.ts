/**
 * Record `self_managed_keys` for every organization that has no access state.
 *
 *   bun run src/scripts/record-missing-organization-access-states.ts
 *
 * Run once after the last deploy that still had FEATURE_ORG_ACCESS_STATE off
 * has fully rolled out, and before turning the flag on: an organization that
 * an older task created during that rollout otherwise has no row, and a
 * missing row is denied once the state is enforced. Existing rows are never
 * changed, so re-running is safe.
 */
import { runScriptWithErrorOutput } from "@stll/errors";

import { openMaintenanceDb } from "@/api/lib/db/maintenance-db";
import { recordMissingOrganizationAccessStates } from "@/api/lib/usage/organization-access-state";

await runScriptWithErrorOutput(async () => {
  const db = openMaintenanceDb({ readOnly: false });
  await db.transaction(
    async (tx) => await recordMissingOrganizationAccessStates(tx),
  );
  console.log("Every organization now has an access state.");
});
