import { Result } from "better-result";
import { and, desc, eq } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import { reportExports } from "@/api/db/schema";
import type { SafeHandlerGenerator } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { createTimestampIdCursorCodec } from "@/api/lib/db-pagination";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { createCursorPage } from "@/api/lib/pagination";
import type { Page } from "@/api/lib/pagination";
import { brandPersistedReportExportId } from "@/api/lib/safe-id-boundaries";

import { resolvedReportResultFieldId } from "./result-field";

type ReportExportHistoryItem = Pick<
  typeof reportExports.$inferSelect,
  "id" | "mode" | "resultEntityId" | "resultFieldId" | "status"
> & {
  createdAt: string;
  downloadAvailable: boolean;
};

type ReportExportHistoryPage = Page<ReportExportHistoryItem>;

type ReportExportHistoryOptions = {
  cursor: string | undefined;
  limit: number;
  requestedBy: SafeId<"user">;
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
};

const reportExportCreatedAtCursor = createTimestampIdCursorCodec({
  column: reportExports.createdAt,
  brandId: brandPersistedReportExportId,
});

const parseReportExportCursor = (cursor: string | undefined) => {
  if (cursor === undefined) {
    return Result.ok(null);
  }

  const decoded = reportExportCreatedAtCursor.decode(cursor);
  if (decoded === null) {
    return Result.err(
      new HandlerError({ status: 400, message: "Invalid cursor" }),
    );
  }

  return Result.ok(decoded);
};

export const readReportExportHistory = async function* ({
  cursor,
  limit,
  requestedBy,
  safeDb,
  workspaceId,
}: ReportExportHistoryOptions): SafeHandlerGenerator<ReportExportHistoryPage> {
  const cursorResult = parseReportExportCursor(cursor);
  if (Result.isError(cursorResult)) {
    return Result.err(cursorResult.error);
  }

  const cursorCondition =
    cursorResult.value === null
      ? undefined
      : reportExportCreatedAtCursor.keysetAfter({
          cursor: cursorResult.value,
          direction: "descending",
          idColumn: reportExports.id,
        });

  const rows = yield* await safeDb((tx) =>
    tx
      .select({
        id: reportExports.id,
        status: reportExports.status,
        mode: reportExports.mode,
        resultEntityId: reportExports.resultEntityId,
        resultFieldId: resolvedReportResultFieldId.as(
          "resolved_result_field_id",
        ),
        resultS3Key: reportExports.resultS3Key,
        createdAt: reportExports.createdAt,
        createdAtCursor:
          reportExportCreatedAtCursor.cursorValue.as("created_at_cursor"),
      })
      .from(reportExports)
      .where(
        and(
          eq(reportExports.workspaceId, workspaceId),
          eq(reportExports.requestedBy, requestedBy),
          cursorCondition,
        ),
      )
      .orderBy(desc(reportExports.createdAt), desc(reportExports.id))
      .limit(limit + 1),
  );

  const page = createCursorPage({
    rows,
    limit,
    cursorForItem: (item) =>
      reportExportCreatedAtCursor.encode(item.createdAtCursor, item.id),
  });

  return Result.ok({
    ...page,
    items: page.items.map(
      ({
        id,
        status,
        mode,
        resultEntityId,
        resultFieldId,
        resultS3Key,
        createdAt,
      }) => ({
        id,
        status,
        mode,
        resultEntityId,
        resultFieldId,
        createdAt: createdAt.toISOString(),
        downloadAvailable:
          status === "completed" && mode === "download" && resultS3Key !== null,
      }),
    ),
  });
};
