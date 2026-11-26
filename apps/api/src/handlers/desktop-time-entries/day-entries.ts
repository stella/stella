import { panic, Result } from "better-result";
import { and, asc, eq } from "drizzle-orm";

import { TIME_ENTRY_ACTIVITY_GROUP } from "@stll/api-contract";
import {
  DESKTOP_DAY_ENTRIES_LIMIT,
  DESKTOP_DAY_ENTRIES_TOO_MANY_CODE,
  desktopDayEntriesQuerySchema,
  desktopDayEntriesResponseSchema,
} from "@stll/api-contract/desktop-time-entries";

import { timeEntries, workspaces } from "@/api/db/schema";
import {
  ACCOUNT_ACCESS,
  createSafeBoundedPublicHandler,
  safePublicHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";
import {
  ownTimeEntriesScope,
  timeEntryMatterJoin,
} from "@/api/lib/billing/own-time-entries";
import { authorizeDesktopAccount } from "@/api/lib/business-registries/desktop/auth";
import { readBounded } from "@/api/lib/db/read-bounded";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { hasMemberPermission } from "@/api/lib/permission-authorization";

import { authorizeDesktopTimeEntries } from "./authorize";

/**
 * The member's own client time on one work date, so a review on one computer
 * can say what is already recorded on a matter from another computer or the
 * web. It reads entries as they stand and returns no time of day.
 */
export const createDesktopDayEntriesEndpoint = (
  authorizeAccount: typeof authorizeDesktopAccount = authorizeDesktopAccount,
) =>
  createSafeBoundedPublicHandler(
    {
      contract: "patch",
      accountAccess: ACCOUNT_ACCESS.sandbox,
      mcp: { type: "internal", reason: "auth_plumbing" },
      cache: { kind: "none" },
      query: desktopDayEntriesQuerySchema,
      response: safePublicHandlerResponseSchemasWithStatusText(
        desktopDayEntriesResponseSchema,
      ),
    },
    async function* ({ request, query: { date } }) {
      const account = yield* Result.await(
        authorizeDesktopTimeEntries(request, authorizeAccount),
      );
      if (!hasMemberPermission(account.memberRole, { timeEntry: ["read"] })) {
        return Result.err(
          new HandlerError({
            status: 403,
            message: "Time entries are not readable",
          }),
        );
      }
      const read = yield* Result.await(
        account.safeDb(async (tx) =>
          readBounded(
            tx
              .select({
                id: timeEntries.id,
                matterId: workspaces.id,
                durationMinutes: timeEntries.durationMinutes,
              })
              .from(timeEntries)
              .innerJoin(workspaces, timeEntryMatterJoin())
              .where(
                and(
                  ownTimeEntriesScope({
                    organizationId: account.organizationId,
                    userId: account.userId,
                    date,
                    endDate: date,
                  }),
                  eq(
                    timeEntries.activityGroup,
                    TIME_ENTRY_ACTIVITY_GROUP.CLIENT,
                  ),
                ),
              )
              .orderBy(asc(timeEntries.id)),
            DESKTOP_DAY_ENTRIES_LIMIT,
          ),
        ),
      );
      switch (read.type) {
        case "overflow":
          return Result.err(
            new HandlerError({
              status: 422,
              code: DESKTOP_DAY_ENTRIES_TOO_MANY_CODE,
              message: `More than ${read.cap} time entries on this date`,
            }),
          );
        case "complete":
          return Result.ok({
            entries: read.rows.map(({ id, matterId, durationMinutes }) => ({
              id: String(id),
              matterId: String(matterId),
              durationMinutes,
            })),
          });
        default:
          read satisfies never;
          return panic("Unknown bounded read result");
      }
    },
  );

export default createDesktopDayEntriesEndpoint();
