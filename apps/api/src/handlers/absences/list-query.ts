import { Result } from "better-result";
import { and, asc, eq, sql } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import { Temporal } from "@stll/time";

import type { SafeDb } from "@/api/db/safe-db";
import { absences } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { tPaginationCursor, tPaginationLimit } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
  isDateOnlyPaginationCursorPart,
  isUuidPaginationCursorPart,
} from "@/api/lib/pagination";
import type {
  UnprojectedColumns,
  UnbackedProjectionKeys,
} from "@/api/lib/projection-totality";
import { brandPersistedAbsenceId } from "@/api/lib/safe-id-boundaries";

const absenceColumns = {
  id: absences.id,
  userId: absences.userId,
  kind: absences.kind,
  startDate: absences.startDate,
  endDate: absences.endDate,
  timezoneId: absences.timezoneId,
  coverage: absences.coverage,
  halfDaySegment: absences.halfDaySegment,
  status: absences.status,
  approverUserId: absences.approverUserId,
  decidedAt: absences.decidedAt,
  decisionComment: absences.decisionComment,
  version: absences.version,
  createdAt: absences.createdAt,
  updatedAt: absences.updatedAt,
};
// The active organization scopes the route; it is not a caller-owned field.
const ABSENCE_LIST_OMITTED = ["organizationId"] as const;
type MissingAbsenceListColumn = UnprojectedColumns<
  typeof absences.$inferSelect,
  typeof absenceColumns,
  (typeof ABSENCE_LIST_OMITTED)[number]
>;
type ExtraAbsenceListColumn = UnbackedProjectionKeys<
  typeof absences.$inferSelect,
  typeof absenceColumns,
  (typeof ABSENCE_LIST_OMITTED)[number]
>;
true satisfies MissingAbsenceListColumn extends never ? true : never;
true satisfies ExtraAbsenceListColumn extends never ? true : never;

export const absenceListQuerySchema = t.Object({
  cursor: t.Optional(tPaginationCursor()),
  limit: t.Optional(tPaginationLimit(LIMITS.timeEntriesPageSizeMax)),
});
type ListAbsencePageOptions = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  selection:
    | { type: "mine"; userId: SafeId<"user"> }
    | { type: "approval_queue" };
  query: Static<typeof absenceListQuerySchema>;
};
export const listAbsencePage = async ({
  safeDb,
  organizationId,
  selection,
  query,
}: ListAbsencePageOptions) =>
  await Result.gen(async function* () {
    const parts = query.cursor ? decodePaginationCursor(query.cursor) : null;
    const date = parts?.at(0);
    const id = parts?.at(1);
    if (
      query.cursor &&
      (!isDateOnlyPaginationCursorPart(date) || !isUuidPaginationCursorPart(id))
    ) {
      return yield* Result.err(
        new HandlerError({
          status: 400,
          code: "invalid_cursor",
          message: "Invalid absence cursor",
          hint: "Restart the absence list without a cursor.",
        }),
      );
    }
    const cursor =
      isDateOnlyPaginationCursorPart(date) && isUuidPaginationCursorPart(id)
        ? { date, id: brandPersistedAbsenceId(id) }
        : null;
    const limit = query.limit ?? LIMITS.timeEntriesPageSizeDefault;
    const rows = yield* Result.await(
      safeDb(
        async (tx) =>
          await tx
            .select(absenceColumns)
            .from(absences)
            .where(
              and(
                eq(absences.organizationId, organizationId),
                selection.type === "mine"
                  ? eq(absences.userId, selection.userId)
                  : eq(absences.status, "requested"),
                cursor
                  ? sql`(${absences.startDate}, ${absences.id}) > (${cursor.date}::date, ${cursor.id}::uuid)`
                  : undefined,
              ),
            )
            .orderBy(asc(absences.startDate), asc(absences.id))
            .limit(limit + 1),
      ),
    );
    const page = createCursorPage({
      rows,
      limit,
      cursorForItem: ({ startDate, id: rowId }) =>
        encodePaginationCursor([startDate, rowId]),
    });
    return Result.ok({
      ...page,
      items: page.items.map((entry) => ({
        id: entry.id,
        userId: entry.userId,
        kind: entry.kind,
        startDate: entry.startDate,
        endDate: entry.endDate,
        timezoneId: entry.timezoneId,
        coverage: entry.coverage,
        halfDaySegment: entry.halfDaySegment,
        status: entry.status,
        approverUserId: entry.approverUserId,
        decisionComment: entry.decisionComment,
        version: entry.version,
        createdAt: entry.createdAt.toISOString(),
        updatedAt: entry.updatedAt.toISOString(),
        decidedAt: entry.decidedAt?.toISOString() ?? null,
        days:
          Temporal.PlainDate.from(entry.endDate).since(
            Temporal.PlainDate.from(entry.startDate),
            { largestUnit: "day" },
          ).days * (entry.coverage === "half" ? 0.5 : 1),
      })),
    });
  });
