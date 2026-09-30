import { rootDb } from "@/api/db/root";
import {
  actionCostReportQuery,
  MAX_ACTION_COST_REPORT_KINDS,
} from "@/api/lib/action-costs/report-query";
import { brandPersistedOrganizationId } from "@/api/lib/safe-id-boundaries";

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
  process.stderr.write(`${query.error.message}\n`);
  process.exit(1);
}
const rows = await rootDb.execute(query.value);
if (rows.length > MAX_ACTION_COST_REPORT_KINDS) {
  process.stderr.write("Too many action kinds; narrow the report period.\n");
  process.exit(1);
}
process.stdout.write(`${JSON.stringify(rows)}\n`);
process.exit(0);
