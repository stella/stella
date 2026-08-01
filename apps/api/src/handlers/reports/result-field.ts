import { sql } from "drizzle-orm";

import {
  entities,
  entityVersions,
  fields,
  reportExports,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

/**
 * A report destination prefers the exact field recorded by a current worker.
 * Older workers and receipts have no field provenance, and a retained entity
 * can outlive deletion of its original field. Resolve those cases to the
 * entity's current file in the same bounded query. Both branches prove
 * workspace and entity ownership before exposing a field id.
 */
export const resolvedReportResultFieldId = sql<SafeId<"field"> | null>`
  COALESCE(
    (
      SELECT stored_field.id
      FROM ${fields} AS stored_field
      INNER JOIN ${entityVersions} AS stored_version
        ON stored_version.id = stored_field.entity_version_id
       AND stored_version.workspace_id = ${reportExports}.${reportExports.workspaceId}
      WHERE stored_field.id = ${reportExports}.${reportExports.resultFieldId}
        AND stored_field.workspace_id = ${reportExports}.${reportExports.workspaceId}
        AND stored_version.entity_id = ${reportExports}.${reportExports.resultEntityId}
      LIMIT 1
    ),
    (
      SELECT current_field.id
      FROM ${entities} AS result_entity
      INNER JOIN ${fields} AS current_field
        ON current_field.entity_version_id = result_entity.current_version_id
       AND current_field.workspace_id = ${reportExports}.${reportExports.workspaceId}
      WHERE result_entity.id = ${reportExports}.${reportExports.resultEntityId}
        AND result_entity.workspace_id = ${reportExports}.${reportExports.workspaceId}
        AND current_field.content->>'type' = 'file'
      ORDER BY current_field.id
      LIMIT 1
    )
  )
`;
