/**
 * Report documents whose current file has no extraction provenance and, with
 * --write, enqueue them through the canonical extraction-source owner.
 * Dry-run is the default and is the only mode intended for CI.
 */
import { and, eq, gt, inArray, isNull } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import {
  entities,
  entityVersions,
  extractedContent,
  fields,
  workspaces,
} from "@/api/db/schema";
import { chooseExtractionSource } from "@/api/lib/extraction-source-owner";
import { processExtraction } from "@/api/lib/search/process-extraction";

const WRITE_ARGUMENT = "--write";
const ENTITY_PAGE_SIZE = 1000;
const write = process.argv.includes(WRITE_ARGUMENT);

const report: {
  entityId: (typeof entities.$inferSelect)["id"];
  fieldId: (typeof fields.$inferSelect)["id"];
  organizationId: (typeof workspaces.$inferSelect)["organizationId"];
}[] = [];
let afterEntityId: (typeof entities.$inferSelect)["id"] | undefined;

while (true) {
  const entityPage = await rootDb
    .select({
      entityId: entities.id,
      organizationId: workspaces.organizationId,
    })
    .from(entities)
    .innerJoin(workspaces, eq(workspaces.id, entities.workspaceId))
    .leftJoin(
      extractedContent,
      and(
        eq(extractedContent.entityId, entities.id),
        eq(extractedContent.workspaceId, entities.workspaceId),
      ),
    )
    .where(
      and(
        eq(entities.kind, "document"),
        isNull(extractedContent.entityId),
        afterEntityId ? gt(entities.id, afterEntityId) : undefined,
      ),
    )
    .orderBy(entities.id)
    .limit(ENTITY_PAGE_SIZE);

  if (entityPage.length === 0) {
    break;
  }

  const organizationByEntityId = new Map(
    entityPage.map(({ entityId, organizationId }) => [
      entityId,
      organizationId,
    ]),
  );
  const rows = await rootDb
    .select({
      entityId: entities.id,
      fieldId: fields.id,
      content: fields.content,
      propertyId: fields.propertyId,
    })
    .from(entities)
    .innerJoin(entityVersions, eq(entityVersions.id, entities.currentVersionId))
    .innerJoin(fields, eq(fields.entityVersionId, entityVersions.id))
    .where(
      inArray(
        entities.id,
        entityPage.map(({ entityId }) => entityId),
      ),
    )
    .orderBy(entities.id, fields.id);

  for (const [reportEntityId, entityRows] of Map.groupBy(
    rows,
    ({ entityId }) => entityId,
  )) {
    const source = chooseExtractionSource(entityRows);
    const organizationId = organizationByEntityId.get(reportEntityId);
    if (source && organizationId) {
      report.push({
        entityId: reportEntityId,
        fieldId: source.fieldId,
        organizationId,
      });
    }
  }

  for (const { entityId: pageEntityId } of entityPage) {
    afterEntityId = pageEntityId;
  }
}
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
