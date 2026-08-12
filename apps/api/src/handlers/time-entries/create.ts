import { Result } from "better-result";
import { eq, sql } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import { abortableTx } from "@/api/db/safe-db";
import type { SafeDb } from "@/api/db/safe-db";
import { TIME_ENTRY_SOURCE, timeEntries } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { UNPRICED_TIME_ENTRY_CURRENCY } from "@/api/lib/billing-constants";
import { resolveRate } from "@/api/lib/billing-rates";
import {
  getTimeEntryDateValidationError,
  roundToBillingIncrement,
} from "@/api/lib/billing-time";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { cents } from "@/api/lib/money";
import { formatTodayInTimeZone } from "@/api/lib/timezone";

const createTimeEntryBodySchema = t.Object({
  workItemId: t.Optional(
    t.Nullable(
      tSafeId("entity", {
        description:
          "Optional document, folder, or task that provides context for the work",
      }),
    ),
  ),
  dateWorked: t.String({
    format: "date",
    description: "Date the work was done (ISO YYYY-MM-DD)",
  }),
  timezoneId: t.String({
    minLength: 1,
    maxLength: 64,
    description:
      "IANA time zone the dateWorked is interpreted in (e.g. Europe/Prague)",
  }),
  durationMinutes: t.Integer({
    minimum: 1,
    description: "Minutes worked (whole minutes)",
  }),
  narrative: t.String({
    minLength: 1,
    maxLength: 10_000,
    description: "Description of the work",
  }),
  billable: t.Optional(
    t.Boolean({ description: "Whether the entry is billable to the client" }),
  ),
  taskCode: t.Optional(
    t.Nullable(
      t.String({
        maxLength: 20,
        description: "UTBMS/LEDES task code; pass null to clear",
      }),
    ),
  ),
  activityCode: t.Optional(
    t.Nullable(
      t.String({
        maxLength: 20,
        description: "UTBMS/LEDES activity code; pass null to clear",
      }),
    ),
  ),
});

export type CreateTimeEntryHandlerProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  recordAuditEvent: AuditRecorder;
  body: Static<typeof createTimeEntryBodySchema>;
};

// Shared time-entry creation logic reused by the HTTP handler and the
// `save_time_entry` MCP tool, so both run the same validation, advisory-lock
// limit check, and audit event.
export const createTimeEntryHandler = async function* ({
  safeDb,
  organizationId,
  workspaceId,
  userId,
  recordAuditEvent,
  body,
}: CreateTimeEntryHandlerProps) {
  const todayStr = yield* formatTodayInTimeZone({
    timezoneId: body.timezoneId,
  });
  const dateValidationError = getTimeEntryDateValidationError({
    dateWorked: body.dateWorked,
    today: todayStr,
  });
  if (dateValidationError) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: dateValidationError,
      }),
    );
  }

  const workItemId = body.workItemId ?? null;

  if (workItemId) {
    const workItem = yield* Result.await(
      safeDb((tx) =>
        tx.query.entities.findFirst({
          where: {
            id: { eq: workItemId },
            workspaceId: { eq: workspaceId },
          },
          columns: { id: true },
        }),
      ),
    );

    if (!workItem) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Work item not found in this matter",
        }),
      );
    }
  }

  const resolvedRate = yield* resolveRate({
    safeDb,
    workspaceId,
    userId,
    dateWorked: body.dateWorked,
  });
  const billable = body.billable ?? true;
  if (billable && !resolvedRate) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Billable time entries need an effective rate",
      }),
    );
  }
  const rateAtEntry = resolvedRate?.hourlyRate ?? 0;
  const currency = resolvedRate?.currency ?? UNPRICED_TIME_ENTRY_CURRENCY;

  const billedMinutes = roundToBillingIncrement(body.durationMinutes);

  const txResult = yield* Result.await(
    abortableTx(safeDb, async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${workspaceId}))`,
      );
      const count = await tx.$count(
        timeEntries,
        eq(timeEntries.workspaceId, workspaceId),
      );

      if (count >= LIMITS.timeEntriesPerWorkspace) {
        throw new HandlerError({
          status: 400,
          message: "Time entries limit reached for this workspace",
        });
      }

      const [entry] = await tx
        .insert(timeEntries)
        .values({
          organizationId,
          workspaceId,
          userId,
          workItemId,
          dateWorked: body.dateWorked,
          timezoneId: body.timezoneId,
          durationMinutes: body.durationMinutes,
          billedMinutes,
          rateAtEntry: cents(rateAtEntry),
          currency,
          narrative: body.narrative,
          billable,
          taskCode: body.taskCode ?? null,
          activityCode: body.activityCode ?? null,
          source: TIME_ENTRY_SOURCE.MANUAL,
        })
        .returning({ id: timeEntries.id });

      if (!entry) {
        throw new HandlerError({
          status: 500,
          message: "Failed to create time entry",
        });
      }

      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.CREATE,
        resourceType: AUDIT_RESOURCE_TYPE.TIME_ENTRY,
        resourceId: entry.id,
        changes: {
          created: {
            old: null,
            new: {
              workItemId,
              dateWorked: body.dateWorked,
              durationMinutes: body.durationMinutes,
              billedMinutes,
              rateAtEntry: cents(rateAtEntry),
              currency,
              billable,
              source: TIME_ENTRY_SOURCE.MANUAL,
            },
          },
        },
      });

      return { id: entry.id };
    }),
  );

  return Result.ok({ id: txResult.id });
};

const createTimeEntry = createSafeHandler(
  {
    description:
      "Create a time entry in the current matter. dateWorked, timezoneId, " +
      "durationMinutes, and narrative are required; workItemId is optional. " +
      "The timekeeper's effective matter rate is resolved server-side. " +
      "durations are whole minutes. Returns the time entry ID.",
    permissions: { timeEntry: ["create"] },
    mcp: { type: "tool", name: "save_time_entry" },
    body: createTimeEntryBodySchema,
  },
  async function* ({
    safeDb,
    session,
    workspaceId,
    user,
    body,
    recordAuditEvent,
  }) {
    return yield* createTimeEntryHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      workspaceId,
      userId: user.id,
      recordAuditEvent,
      body,
    });
  },
);

export default createTimeEntry;
