/**
 * Download a list's chronology as a table (DOCX or CSV): one row per fact on
 * the list in the order it happened, with the document it first comes from
 * and the claims that cite it with the verdict reviewers see now. Read
 * through the verification graph, so the file says what the Graph view and
 * Chronology say, and refused rather than cut when the list is larger than
 * one export reads.
 */

import { panic, Result } from "better-result";
import { and, eq } from "drizzle-orm";
import * as v from "valibot";

import { legalLists } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { resourceIdSchema, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIST_VERIFICATION_FEATURE_ID } from "@/api/lib/feature-access/registry";
import {
  CHRONOLOGY_COLUMNS,
  readVerificationChronology,
} from "@/api/lib/lists/verification/chronology-export";
import { VERIFICATION_LIMITS } from "@/api/lib/lists/verification/contract";
import { recordVerificationReads } from "@/api/lib/lists/verification/read-audit";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import { secureDocumentResponse } from "@/api/lib/secure-document-response";
import {
  buildCsvExport,
  buildDocxExport,
  sanitizeSpreadsheetCell,
} from "@/api/lib/views/table-export";
import type { ExportTableInput } from "@/api/lib/views/table-export";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

const CHRONOLOGY_FORMATS = ["docx", "csv"] as const;
type ChronologyFormat = (typeof CHRONOLOGY_FORMATS)[number];

const CONTENT_TYPE = {
  docx: DOCX_MIME_TYPE,
  csv: "text/csv; charset=utf-8",
} as const satisfies Record<ChronologyFormat, string>;

const FILE_SUFFIX = " - chronology";

const config = {
  contract: "patch",
  featureAccess: { featureId: LIST_VERIFICATION_FEATURE_ID, type: "required" },
  contentDelivery: { type: "audited" },
  description:
    "Download the chronology of one list as a table (DOCX or CSV): a row " +
    "per fact on the list in the order it happened (the date as precisely " +
    "as it is known: day, month or year; undated facts last), the fact, " +
    "the document it first comes from with its page, and the claims of the " +
    "verified documents that cite it with the verdict as reviewers see it " +
    "now. Refused, never cut, when the list holds more facts or verified " +
    "documents than one export reads.",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "read",
  // A file for people to download: agents read the same facts, sources and
  // citing claims as JSON through lists.verifications.graph.get.
  mcp: { type: "internal", reason: "document_processing" },
  params: workspaceParams({}),
  query: v.object({
    listId: resourceIdSchema("legalList"),
    format: v.picklist(CHRONOLOGY_FORMATS),
  }),
} satisfies WorkspaceHandlerConfig;

const exportVerificationChronology = createSafeHandler(
  config,
  async function* ({
    query: { listId, format },
    safeDb,
    session,
    user,
    workspaceId,
    recordAuditEvent,
  }) {
    const outcome = yield* Result.await(
      safeDb(async (tx) => {
        const list = (
          await tx
            .select({ name: legalLists.name })
            .from(legalLists)
            .where(
              and(
                eq(legalLists.id, listId),
                eq(legalLists.workspaceId, workspaceId),
              ),
            )
            .limit(1)
        ).at(0);
        if (list === undefined) {
          return { type: "list-not-found" } as const;
        }
        const read = await readVerificationChronology({
          tx,
          workspaceId,
          listId,
        });
        if (read.type !== "read") {
          return read;
        }
        // The file delivers the claims of these runs, as the graph does, so
        // each is audited as read; the download itself is audited too.
        await recordVerificationReads({
          tx,
          runs: read.runs,
          organizationId: session.activeOrganizationId,
          workspaceId,
          userId: user.id,
          recordAuditEvent,
        });
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.DOWNLOAD,
          resourceType: AUDIT_RESOURCE_TYPE.LEGAL_LIST,
          resourceId: listId,
          metadata: {
            operation: "verification_chronology_exported",
            format,
            rowCount: read.rows.length,
          },
        });
        return { ...read, listName: list.name };
      }),
    );

    switch (outcome.type) {
      case "list-not-found": {
        return Result.err(
          new HandlerError({
            status: 404,
            code: "list_not_found",
            message: "List not found",
          }),
        );
      }
      case "too-large": {
        return Result.err(
          new HandlerError({
            status: 413,
            code: "chronology_too_large",
            message:
              outcome.bound === "facts"
                ? `The list holds more than ${String(VERIFICATION_LIMITS.GRAPH_FACTS_MAX)} facts, more than one chronology export reads.`
                : `The list's verified documents number more than ${String(VERIFICATION_LIMITS.CHRONOLOGY_EXPORT_DOCUMENTS_MAX)} or hold more than ${String(VERIFICATION_LIMITS.CHRONOLOGY_EXPORT_CLAIMS_MAX)} claims, more than one chronology export reads.`,
          }),
        );
      }
      case "read": {
        const table: ExportTableInput = {
          columns: CHRONOLOGY_COLUMNS.map(({ header }) => ({ header })),
          rows: outcome.rows.map((row) =>
            CHRONOLOGY_COLUMNS.map(({ key }) => ({
              type: "text" as const,
              value: sanitizeSpreadsheetCell(row[key]),
              style: "default" as const,
            })),
          ),
        };
        const body =
          format === "csv"
            ? buildCsvExport(table)
            : await buildDocxExport(table);
        return Result.ok(
          secureDocumentResponse({
            body,
            contentType: CONTENT_TYPE[format],
            disposition: "attachment",
            fileName: sanitizeFilename(
              `${outcome.listName}${FILE_SUFFIX}.${format}`,
            ),
          }),
        );
      }
      default: {
        outcome satisfies never;
        return panic(`Unhandled outcome: ${String(outcome)}`);
      }
    }
  },
);

export default exportVerificationChronology;
