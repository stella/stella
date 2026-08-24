/**
 * Download one review run as an issues table: a row per finding with the
 * draft's position, the precedent's position, the impact for the reviewed
 * side, the recommendation and the proposed wording. Synchronous like the
 * view export: a run holds at most a few dozen findings.
 */

import { Result } from "better-result";
import { and, asc, eq } from "drizzle-orm";
import { t } from "elysia";

import {
  documentReviewFindings,
  documentReviewRuns,
  entities,
} from "@/api/db/schema";
import {
  buildCsvExport,
  buildXlsxExport,
} from "@/api/handlers/views/table-export";
import type { ExportTableInput } from "@/api/handlers/views/table-export";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import {
  buildIssuesTableRows,
  describeIssuesTableBasis,
  ISSUES_TABLE_COLUMNS,
  renderIssuesTableDocx,
} from "@/api/lib/document-review/issues-table";
import { DOCUMENT_REVIEW_FINDINGS_PER_RUN_MAX } from "@/api/lib/document-review/run-contract";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import { secureDocumentResponse } from "@/api/lib/secure-document-response";
import { DOCX_MIME_TYPE, XLSX_MIME_TYPE } from "@/api/mime-types";

const ISSUES_TABLE_FORMATS = ["xlsx", "docx", "csv"] as const;
type IssuesTableFormat = (typeof ISSUES_TABLE_FORMATS)[number];

const CONTENT_TYPE = {
  xlsx: XLSX_MIME_TYPE,
  docx: DOCX_MIME_TYPE,
  csv: "text/csv; charset=utf-8",
} as const satisfies Record<IssuesTableFormat, string>;

const FILE_SUFFIX = " - review issues";
const WORKSHEET_NAME = "Issues";

// Document names usually keep their upload extension; the export gets its own.
const withoutExtension = (name: string): string => {
  const lastDot = name.lastIndexOf(".");
  return lastDot <= 0 ? name : name.slice(0, lastDot);
};

const config = {
  description:
    "Download a document review run as an issues table (XLSX, DOCX or CSV).",
  permissions: { workspace: ["read"] },
  access: "read",
  mcp: { type: "internal", reason: "document_processing" },
  params: workspaceParams({ runId: tSafeId("documentReviewRun") }),
  query: t.Object({ format: t.UnionEnum([...ISSUES_TABLE_FORMATS]) }),
} satisfies HandlerConfig;

const exportDocumentReviewRun = createSafeHandler(
  config,
  async function* ({ params, query, recordAuditEvent, safeDb, workspaceId }) {
    const runs = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            id: documentReviewRuns.id,
            basis: documentReviewRuns.basis,
            targetName: entities.name,
          })
          .from(documentReviewRuns)
          .innerJoin(entities, eq(entities.id, documentReviewRuns.entityId))
          .where(
            and(
              eq(documentReviewRuns.id, params.runId),
              eq(documentReviewRuns.workspaceId, workspaceId),
            ),
          )
          .limit(1),
      ),
    );
    const run = runs.at(0);
    if (run === undefined) {
      return Result.err(
        new HandlerError({ status: 404, message: "Review run not found" }),
      );
    }

    const findings = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            topicTitle: documentReviewFindings.topicTitle,
            payload: documentReviewFindings.payload,
            decision: documentReviewFindings.decision,
          })
          .from(documentReviewFindings)
          .where(
            and(
              eq(documentReviewFindings.runId, params.runId),
              eq(documentReviewFindings.workspaceId, workspaceId),
            ),
          )
          .orderBy(
            asc(documentReviewFindings.checkKind),
            asc(documentReviewFindings.createdAt),
            asc(documentReviewFindings.id),
          )
          .limit(DOCUMENT_REVIEW_FINDINGS_PER_RUN_MAX),
      ),
    );

    const rows = buildIssuesTableRows({ basis: run.basis, findings });
    const exportName = `${withoutExtension(run.targetName)}${FILE_SUFFIX}`;
    const table: ExportTableInput = {
      columns: ISSUES_TABLE_COLUMNS.map(({ header }) => ({ header })),
      rows: rows.map((row) =>
        ISSUES_TABLE_COLUMNS.map(({ key }) => ({
          type: "text" as const,
          value: row[key],
          style: "default" as const,
        })),
      ),
    };

    let body: string | ArrayBuffer;
    switch (query.format) {
      case "csv":
        body = buildCsvExport(table);
        break;
      case "xlsx":
        body = await buildXlsxExport({
          ...table,
          worksheetName: WORKSHEET_NAME,
        });
        break;
      case "docx":
        body = await renderIssuesTableDocx({
          title: exportName,
          basisLine: describeIssuesTableBasis(run.basis),
          rows,
        });
        break;
      default:
        return query.format satisfies never;
    }

    yield* Result.await(
      safeDb(async (tx) => {
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.DOWNLOAD,
          resourceType: AUDIT_RESOURCE_TYPE.DOCUMENT_REVIEW_RUN,
          resourceId: run.id,
          metadata: { format: query.format, rowCount: rows.length },
        });
      }),
    );

    return Result.ok(
      secureDocumentResponse({
        body,
        contentType: CONTENT_TYPE[query.format],
        disposition: "attachment",
        fileName: sanitizeFilename(`${exportName}.${query.format}`),
      }),
    );
  },
);

export default exportDocumentReviewRun;
