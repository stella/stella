import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { member, user } from "@/api/db/auth-schema";
import { timeEntries } from "@/api/db/schema";
import {
  timeEntryContextColumns,
  timeEntryReadColumns,
} from "@/api/handlers/time-entries/time-entry-columns";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import { canManageTimeEntry } from "@/api/lib/billing/time-entry-authorization";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const readTimeEntryByIdParamsSchema = workspaceParams({
  id: tSafeId("timeEntry"),
});

const readTimeEntryById = createSafeHandler(
  {
    description:
      "Read one time entry in a matter by id, with its minutes, rate, " +
      "currency, narratives, billing status, source, task and activity " +
      "codes, timer timestamps, and the timekeeper's name. A caller without " +
      "time-entry approval access can only read their own entries; another " +
      "user's entry is reported as not found.",
    permissions: { timeEntry: ["read"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    featureAccess: { featureId: "time-billing", type: "required" },
    mcp: { type: "covered", by: "list_time_entries" },
    access: "read",
    params: readTimeEntryByIdParamsSchema,
  },
  async function* ({
    memberRole,
    safeDb,
    session,
    user: currentUser,
    workspaceId,
    params,
  }) {
    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({ ...timeEntryReadColumns, ...timeEntryContextColumns })
          .from(timeEntries)
          .where(
            and(
              eq(timeEntries.id, params.id),
              eq(timeEntries.workspaceId, workspaceId),
            ),
          ),
      ),
    );
    const row = rows.at(0);

    if (!row) {
      return Result.err(
        new HandlerError({ status: 404, message: "Time entry not found" }),
      );
    }

    if (
      !canManageTimeEntry({
        memberRole,
        currentUserId: currentUser.id,
        entryUserId: row.userId,
      })
    ) {
      return Result.err(
        new HandlerError({ status: 404, message: "Time entry not found" }),
      );
    }

    let userName: string | null = null;
    const rowUserId = row.userId;
    if (rowUserId) {
      const [u] = yield* Result.await(
        safeDb((tx) =>
          tx
            .select({ name: user.name })
            .from(member)
            .innerJoin(user, eq(member.userId, user.id))
            .where(
              and(
                eq(member.userId, rowUserId),
                eq(member.organizationId, session.activeOrganizationId),
              ),
            ),
        ),
      );
      userName = u?.name ?? null;
    }

    return Result.ok({
      ...row,
      userName,
      approvedAt: row.approvedAt?.toISOString() ?? null,
      returnedAt: row.returnedAt?.toISOString() ?? null,
      timerStartedAt: row.timerStartedAt?.toISOString() ?? null,
      timerStoppedAt: row.timerStoppedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt?.toISOString() ?? null,
    });
  },
);

export default readTimeEntryById;
