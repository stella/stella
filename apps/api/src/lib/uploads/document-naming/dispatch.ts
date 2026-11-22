import { sql } from "drizzle-orm";

import type { RootDatabase } from "@/api/db/root";
import type { documentProcessingRuns } from "@/api/db/schema";
import { executedRows } from "@/api/lib/db/executed-rows";
import { NAMING_TEXT_MIN_CHARS } from "@/api/lib/uploads/document-naming/document-naming.logic";

// Kept apart from the naming job so the document processing worker does not load the model stack.
type CompletedRun = Pick<
  typeof documentProcessingRuns.$inferSelect,
  "id" | "organizationId" | "workspaceId" | "entityId" | "entityVersionId"
>;

/**
 * Create the naming run for a processing run that just gave a new document's
 * first version its text, when the matter opted in and the organization has a
 * pattern. Returns whether a run was created; a document gets one at most.
 */
export const dispatchDocumentNaming = async (
  db: Pick<RootDatabase, "execute">,
  run: CompletedRun,
): Promise<boolean> => {
  // audit: skip - worker bookkeeping; the rename it leads to is audited.
  const created = await db.execute<{ id: string }>(sql`
    INSERT INTO document_naming_runs (
      id, organization_id, workspace_id, entity_id,
      entity_version_id, source_name
    )
    SELECT ${run.id}, ${run.organizationId}, ${run.workspaceId},
      ${run.entityId}, ${run.entityVersionId}, e.name
    FROM entities e
    INNER JOIN entity_versions ev
      ON ev.id = e.current_version_id
      AND ev.entity_id = e.id
      AND ev.workspace_id = e.workspace_id
      AND ev.version_number = 1
    INNER JOIN workspaces w
      ON w.id = e.workspace_id
      AND w.organization_id = ${run.organizationId}
      AND w.document_naming_enabled
    INNER JOIN organization_settings os
      ON os.organization_id = w.organization_id
      AND os.document_name_pattern IS NOT NULL
    INNER JOIN extracted_content ec
      ON ec.entity_id = e.id
      AND ec.workspace_id = e.workspace_id
      AND ec.source_entity_version_id = ev.id
      AND ec.char_count >= ${NAMING_TEXT_MIN_CHARS}
    WHERE e.id = ${run.entityId}
      AND e.workspace_id = ${run.workspaceId}
      AND e.kind = 'document'
      AND e.current_version_id = ${run.entityVersionId}
    ON CONFLICT DO NOTHING
    RETURNING id
  `);
  return executedRows(created).length > 0;
};
