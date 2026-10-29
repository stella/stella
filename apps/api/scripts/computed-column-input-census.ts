/**
 * Read-only inventory of computed columns that have no dependency inputs.
 *
 * Usage: bun apps/api/scripts/computed-column-input-census.ts
 */
import { sql } from "drizzle-orm";

import { runScriptWithErrorOutput } from "@stll/errors/script-error";

import { openMaintenanceDb } from "@/api/lib/db/maintenance-db";

type CensusRow = {
  organizationId: string;
  workspaceId: string;
  propertyId: string;
  propertyName: string;
  candidateFilePropertyIds: string[];
};

await runScriptWithErrorOutput(async () => {
  const db = openMaintenanceDb({ readOnly: true });
  const rows = await db.execute<CensusRow>(sql`
      select
        w.organization_id as "organizationId",
        p.workspace_id as "workspaceId",
        p.id as "propertyId",
        p.name as "propertyName",
        coalesce(
          array_agg(candidate.id order by candidate.id)
            filter (where candidate.id is not null),
          array[]::uuid[]
        ) as "candidateFilePropertyIds"
      from properties p
      inner join workspaces w on w.id = p.workspace_id
      left join property_dependencies dependency on dependency.property_id = p.id
      left join properties candidate
        on candidate.workspace_id = p.workspace_id
        and candidate.content->>'type' = 'file'
      where p.tool->>'type' in ('ai-model', 'playbook-verdict')
      group by w.organization_id, p.workspace_id, p.id, p.name
      having count(dependency.id) = 0
      order by w.organization_id, p.workspace_id, p.id
    `);

  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.organizationId, (counts.get(row.organizationId) ?? 0) + 1);
    const proposed =
      row.candidateFilePropertyIds.length === 1
        ? row.candidateFilePropertyIds.join("")
        : "none (owner would refuse: expected exactly one file column)";
    console.log(
      `${row.organizationId}\t${row.workspaceId}\t${row.propertyId}\t${row.propertyName}\twould wire: ${proposed}`,
    );
  }

  console.log("\nCounts by organization:");
  for (const [organizationId, count] of counts) {
    console.log(`${organizationId}\t${String(count)}`);
  }
  console.log(`\nTotal inputless computed columns: ${String(rows.length)}`);
});
