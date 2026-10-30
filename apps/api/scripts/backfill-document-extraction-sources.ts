/**
 * Report documents whose current file has no extraction provenance and, with
 * --write, enqueue them through the canonical extraction-source owner.
 * Dry-run is the default and is the only mode intended for CI.
 */
import { and, eq, gt, isNull } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import {
  entities,
  entityVersions,
  extractedContent,
  fields,
  workspaces,
} from "@/api/db/schema";
import { enqueueDocumentProcessingRun } from "@/api/lib/document-processing-enqueue";
import { chooseExtractionSource } from "@/api/lib/extraction-runs/extraction-source-owner";
import type { NativeExtractionRunRequest } from "@/api/lib/search/process-extraction";
import { requestNativeExtractionRunsAsOwner } from "@/api/lib/search/process-extraction";

const WRITE_ARGUMENT = "--write";
// Matches requestNativeExtractionRuns' insert bound, so one page is one insert.
const ENTITY_PAGE_SIZE = 250;
const write = process.argv.includes(WRITE_ARGUMENT);

const report: {
  entityId: (typeof entities.$inferSelect)["id"];
  fieldId: (typeof fields.$inferSelect)["id"];
  organizationId: (typeof workspaces.$inferSelect)["organizationId"];
}[] = [];
let afterEntityId: (typeof entities.$inferSelect)["id"] | undefined;

while (true) {
  const entityPage = rootDb
    .select({
      entityId: entities.id,
      entityVersionId: entities.currentVersionId,
      organizationId: workspaces.organizationId,
      workspaceId: entities.workspaceId,
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
    .limit(ENTITY_PAGE_SIZE)
    .as("entity_page");
  // db-await-in-loop: keyset page read; each page resumes after the previous page's last entity
  const rows = await rootDb
    .select({
      entityId: entityPage.entityId,
      entityVersionId: entityPage.entityVersionId,
      fieldId: fields.id,
      content: fields.content,
      propertyId: fields.propertyId,
      organizationId: entityPage.organizationId,
      workspaceId: entityPage.workspaceId,
    })
    .from(entityPage)
    .leftJoin(entityVersions, eq(entityVersions.id, entityPage.entityVersionId))
    .leftJoin(fields, eq(fields.entityVersionId, entityVersions.id))
    .orderBy(entityPage.entityId, fields.id);

  if (rows.length === 0) {
    break;
  }

  const pageRequests: NativeExtractionRunRequest[] = [];

  for (const [reportEntityId, entityRows] of Map.groupBy(
    rows,
    ({ entityId }) => entityId,
  )) {
    const source = chooseExtractionSource(
      entityRows.flatMap((row) =>
        row.fieldId && row.content
          ? [
              {
                content: row.content,
                fieldId: row.fieldId,
                propertyId: row.propertyId ?? undefined,
              },
            ]
          : [],
      ),
    );
    const firstRow = entityRows.at(0);
    if (source?.fieldId && firstRow?.entityVersionId) {
      report.push({
        entityId: reportEntityId,
        fieldId: source.fieldId,
        organizationId: firstRow.organizationId,
      });
      pageRequests.push({
        entityId: reportEntityId,
        entityVersionId: firstRow.entityVersionId,
        fieldId: source.fieldId,
        fileField: source.content,
        organizationId: firstRow.organizationId,
        workspaceId: firstRow.workspaceId,
      });
    }
  }

  if (write && pageRequests.length > 0) {
    // db-await-in-loop: one bounded insert per page, capped by ENTITY_PAGE_SIZE
    const runIds = await requestNativeExtractionRunsAsOwner(pageRequests);
    await Promise.all(runIds.map(enqueueDocumentProcessingRun));
  }

  afterEntityId = rows.at(-1)?.entityId;
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
