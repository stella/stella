import { Result } from "better-result";
import { t } from "elysia";

import type { JustificationContent } from "@/api/db/schema";
import { env } from "@/api/env";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
// eslint-disable-next-line no-restricted-imports -- export boundary: brands field ids returned by queryEntities (server-validated, workspace-scoped) to re-hydrate their justifications from Postgres
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { queryEntities } from "@/api/lib/entities/query-entities";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { extractFormattingLocale } from "@/api/lib/locale";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import { secureDocumentResponse } from "@/api/lib/secure-document-response";
import { excludedEntityKindsForView } from "@/api/lib/views";
import { parseStoredViewLayout } from "@/api/lib/views-schema";
import { buildExportColumns } from "@/api/lib/views/export-columns";
import {
  buildCsvExport,
  buildDocxExport,
  buildExportTable,
  buildXlsxExport,
} from "@/api/lib/views/table-export";
import type { ExportLinkContext } from "@/api/lib/views/table-export";
import { DOCX_MIME_TYPE, XLSX_MIME_TYPE } from "@/api/mime-types";

// Postgres caps bound parameters per statement; chunk the justification
// lookup so an export at the row ceiling cannot overflow a single `IN (...)`.
const JUSTIFICATION_FIELD_ID_BATCH = 1000;

const chunkArray = <T>(items: T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
};

const config = {
  description:
    "Export one view's rows as a file in CSV, XLSX, or DOCX, using the " +
    "columns, filters, and ordering the view defines. Returns the file " +
    "bytes; views.list describes a view but never its rows.",
  permissions: { workspace: ["read"] },
  mcp: { type: "capability", reason: "workspace_schema" },
  access: "read",
  transport: {
    type: "file-response",
    response: {
      mediaTypes: ["text/csv; charset=utf-8", XLSX_MIME_TYPE, DOCX_MIME_TYPE],
    },
    alternative: {
      type: "none",
      reason:
        "no capability returns a view's rendered row set; views.list describes the view, not its rows",
    },
  },
  params: workspaceParams({ viewId: tSafeId("workspaceView") }),
  query: t.Object({
    format: t.Union([t.Literal("csv"), t.Literal("xlsx"), t.Literal("docx")]),
  }),
} satisfies HandlerConfig;

const exportTableView = createSafeHandler(
  config,
  async function* ({
    safeDb,
    workspaceId,
    user,
    session,
    request,
    recordAuditEvent,
    params: { viewId },
    query,
  }) {
    const view = yield* Result.await(
      safeDb((tx) =>
        tx.query.workspaceViews.findFirst({
          where: {
            id: { eq: viewId },
            workspaceId: { eq: workspaceId },
          },
          columns: {
            id: true,
            name: true,
            layout: true,
          },
        }),
      ),
    );

    if (!view) {
      return Result.err(
        new HandlerError({ status: 404, message: "View not found" }),
      );
    }

    const layout = parseStoredViewLayout(view.layout);
    if (layout.type !== "table") {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Only table views can be exported",
        }),
      );
    }

    const workspace = yield* Result.await(
      safeDb((tx) =>
        tx.query.workspaces.findFirst({
          where: { id: { eq: workspaceId } },
          columns: { name: true },
        }),
      ),
    );
    const properties = yield* Result.await(
      safeDb((tx) =>
        tx.query.properties.findMany({
          where: { workspaceId: { eq: workspaceId } },
          columns: {
            id: true,
            name: true,
            tool: true,
          },
          orderBy: { createdAt: "asc" },
          limit: LIMITS.propertiesCount,
        }),
      ),
    );

    const columns = buildExportColumns(layout, properties);
    const propertyColumns = columns.filter(
      (column) => column.type === "property",
    );
    // Verdict properties have no column of their own, but their field values
    // are merged into the paired ASK cell, so they must still be fetched.
    const loadedPropertyIds = new Set<string>();
    for (const column of propertyColumns) {
      loadedPropertyIds.add(column.propertyId);
      if (column.verdictPropertyId) {
        loadedPropertyIds.add(column.verdictPropertyId);
      }
    }
    const fieldIds = properties.flatMap((property) =>
      loadedPropertyIds.has(property.id) ? [property.id] : [],
    );

    // Export the same persisted table shape the user sees: visible
    // columns in saved order, saved filters/sorts, and visible field
    // values only. Purely visual client state such as column pixel
    // widths or content wrapping does not affect cell values.
    const queryResult = yield* Result.await(
      queryEntities({
        safeDb,
        workspaceId,
        currentUserId: user.id,
        currentOrganizationId: session.activeOrganizationId,
        filters: layout.filters,
        sorts: layout.sorts,
        limit: LIMITS.exportRowLimit,
        fieldMode: "visible",
        fieldIds,
        excludedKinds: excludedEntityKindsForView(layout.filters),
      }),
    );

    // Each annotated cell takes its note from one property's field
    // justification: the verdict's rationale for a merged position, otherwise
    // the AI extraction's own reasoning/citations.
    const commentPropertyIds = new Set<string>();
    for (const column of propertyColumns) {
      if (column.commentPropertyId) {
        commentPropertyIds.add(column.commentPropertyId);
      }
    }
    const commentFieldIds: SafeId<"field">[] = [];
    if (commentPropertyIds.size > 0) {
      for (const entity of queryResult.entities) {
        for (const field of entity.fields) {
          if (commentPropertyIds.has(field.propertyId)) {
            commentFieldIds.push(toSafeId<"field">(field.id));
          }
        }
      }
    }

    const justificationByFieldId = new Map<string, JustificationContent>();
    if (commentFieldIds.length > 0) {
      const justificationRows = yield* Result.await(
        safeDb(async (tx) => {
          const rows: { fieldId: string; content: JustificationContent }[] = [];
          for (const fieldIdBatch of chunkArray(
            commentFieldIds,
            JUSTIFICATION_FIELD_ID_BATCH,
          )) {
            // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- sequential reads on the same transaction connection (one in-flight query per tx); the batch caps each `IN (...)` below the bound-parameter limit
            const batchRows = await tx.query.justifications.findMany({
              where: {
                workspaceId: { eq: workspaceId },
                fieldId: { in: fieldIdBatch },
              },
              columns: { fieldId: true, content: true },
              limit: JUSTIFICATION_FIELD_ID_BATCH,
            });
            rows.push(...batchRows);
          }
          return rows;
        }),
      );
      for (const row of justificationRows) {
        justificationByFieldId.set(row.fieldId, row.content);
      }
    }

    const locale = extractFormattingLocale(request);
    const link: ExportLinkContext = {
      baseUrl: env.FRONTEND_URL.replace(/\/$/u, ""),
      workspaceId,
      viewId,
    };
    const table = buildExportTable(columns, queryResult.entities, locale, {
      link,
      justificationByFieldId,
    });
    const exportName = workspace?.name ?? view.name;
    let body: string | ArrayBuffer;
    let contentType: string;
    if (query.format === "csv") {
      body = buildCsvExport(table);
      contentType = "text/csv; charset=utf-8";
    } else if (query.format === "docx") {
      body = await buildDocxExport(table);
      contentType = DOCX_MIME_TYPE;
    } else {
      body = await buildXlsxExport({ ...table, worksheetName: exportName });
      contentType = XLSX_MIME_TYPE;
    }
    const filename = sanitizeFilename(`${exportName}.${query.format}`);

    yield* Result.await(
      safeDb(async (tx) => {
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.DOWNLOAD,
          resourceType: AUDIT_RESOURCE_TYPE.VIEW,
          resourceId: view.id,
          metadata: {
            format: query.format,
            rowCount: table.rows.length,
          },
        });
      }),
    );

    return Result.ok(
      secureDocumentResponse({
        body,
        contentType,
        disposition: "attachment",
        fileName: filename,
      }),
    );
  },
);

export default exportTableView;
