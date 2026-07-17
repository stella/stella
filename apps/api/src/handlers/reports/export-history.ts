import { Result } from "better-result";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import { reportExports } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import {
  parsePgTimestampCursorValue,
  pgTimestampCursorBoundary,
  pgTimestampCursorValue,
} from "@/api/lib/db-pagination";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
  isUuidPaginationCursorPart,
} from "@/api/lib/pagination";
import { brandPersistedReportExportId } from "@/api/lib/safe-id-boundaries";

type ReportExportHistoryOptions = {
  cursor: string | undefined;
  limit: number;
  requestedBy: SafeId<"user">;
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
};

const reportExportCreatedAtCursor = pgTimestampCursorValue(
  reportExports.createdAt,
);

const parseReportExportCursor = (cursor: string | undefined) => {
  if (cursor === undefined) {
    return Result.ok(null);
  }

  const parts = decodePaginationCursor(cursor);
  const createdAt = parsePgTimestampCursorValue(parts?.at(0));
  const id = parts?.at(1);
  if (
    parts?.length !== 2 ||
    createdAt === null ||
    !isUuidPaginationCursorPart(id)
  ) {
    return Result.err(
      new HandlerError({ status: 400, message: "Invalid cursor" }),
    );
  }

  return Result.ok({
    createdAt,
    id: brandPersistedReportExportId(id),
  });
};

export const readReportExportHistory = async function* ({
  cursor,
  limit,
  requestedBy,
  safeDb,
  workspaceId,
}: ReportExportHistoryOptions) {
  const cursorResult = parseReportExportCursor(cursor);
  if (Result.isError(cursorResult)) {
    return Result.err(cursorResult.error);
  }

  const cursorCondition =
    cursorResult.value === null
      ? undefined
      : or(
          lt(
            reportExports.createdAt,
            pgTimestampCursorBoundary(cursorResult.value.createdAt),
          ),
          and(
            eq(
              reportExports.createdAt,
              pgTimestampCursorBoundary(cursorResult.value.createdAt),
            ),
            sql`${reportExports.id} < ${cursorResult.value.id}`,
          ),
        );

  const rows = yield* await safeDb((tx) =>
    tx
      .select({
        id: reportExports.id,
        status: reportExports.status,
        mode: reportExports.mode,
        resultEntityId: reportExports.resultEntityId,
        createdAt: reportExports.createdAt,
        createdAtCursor: reportExportCreatedAtCursor.as("created_at_cursor"),
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
      encodePaginationCursor([item.createdAtCursor, item.id]),
  });

  return Result.ok({
    ...page,
    items: page.items.map(
      ({ id, status, mode, resultEntityId, createdAt }) => ({
        id,
        status,
        mode,
        resultEntityId,
        createdAt: createdAt.toISOString(),
      }),
    ),
  });
};
