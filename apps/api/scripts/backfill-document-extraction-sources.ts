/**
 * Report documents whose current file has no extraction provenance and, with
 * --write, enqueue them through the canonical extraction-source owner.
 * Dry-run is the default and is the only mode intended for CI.
 */
import { and, eq, isNull } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import { entities, entityVersions, fields, workspaces } from "@/api/db/schema";
import { chooseExtractionSource } from "@/api/lib/extraction-source-owner";
import { processExtraction } from "@/api/lib/search/process-extraction";

const WRITE_ARGUMENT = "--write";
const write = process.argv.includes(WRITE_ARGUMENT);

const rows = await rootDb
  .select({
    entityId: entities.id,
    fieldId: fields.id,
    organizationId: workspaces.organizationId,
    content: fields.content,
    propertyId: fields.propertyId,
  })
  .from(entities)
  .innerJoin(workspaces, eq(workspaces.id, entities.workspaceId))
  .innerJoin(entityVersions, eq(entityVersions.id, entities.currentVersionId))
  .innerJoin(fields, eq(fields.entityVersionId, entityVersions.id))
  .where(and(eq(entities.kind, "document"), isNull(entities.extractedContent)))
  .orderBy(entities.id, fields.id)
  .limit(10_000);

const grouped = Map.groupBy(rows, ({ entityId }) => entityId);
const report = [...grouped.entries()].flatMap(([entityId, entityRows]) => {
  const source = chooseExtractionSource(entityRows);
  if (!source) {
    return [];
  }
  return [
    {
      entityId,
      fieldId: source.fieldId,
      organizationId: source.organizationId,
    },
  ];
});
const counts = Map.groupBy(report, ({ organizationId }) => organizationId);

console.log(write ? "WRITE MODE" : "DRY RUN");
console.table(
  [...counts.entries()].map(([organizationId, documents]) => ({
    organizationId,
    documents: documents.length,
  })),
);
console.table(report);

if (write) {
  for (const { entityId } of report) {
    await processExtraction(entityId);
  }
}
