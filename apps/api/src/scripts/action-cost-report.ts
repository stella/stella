import { printError } from "@stll/errors";
import { runScriptWithErrorOutput } from "@stll/errors/script-error";

import { openMaintenanceDb } from "@/api/lib/db/maintenance-db";
import { brandPersistedOrganizationId } from "@/api/lib/safe-id-boundaries";
import {
  actionCostReportQuery,
  MAX_ACTION_COST_REPORT_KINDS,
} from "@/api/lib/usage/action-costs/report-query";

const [organizationId, start, end] = process.argv.slice(2);
if (!organizationId || !start || !end) {
  process.stderr.write(
    "Usage: action-cost-report <organization-id> <start-ISO> <end-ISO>\n",
  );
  process.exit(1);
}
const query = actionCostReportQuery({
  organizationId: brandPersistedOrganizationId(organizationId),
  start: new Date(start),
  end: new Date(end),
});
if (query.isErr()) {
  printError(query.error);
  process.exit(1);
}
const db = openMaintenanceDb({ readOnly: true });
await runScriptWithErrorOutput(async () => {
  const rows = await db.execute(query.value);
  if (rows.length > MAX_ACTION_COST_REPORT_KINDS) {
    process.stderr.write("Too many action kinds; narrow the report period.\n");
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify(rows)}\n`);
  process.exit(0);
});
