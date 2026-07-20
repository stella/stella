import { Result } from "better-result";
import { eq, sql } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import type { SafeDb } from "@/api/db/safe-db";
import { TIME_ENTRY_SOURCE, timeEntries } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { cents } from "@/api/lib/money";
import { formatTodayInTimeZone } from "@/api/lib/timezone";

const createTimeEntryBodySchema = t.Object({
  matterId: tSafeId("entity", {
    description:
      "Entity the time is logged against (document, folder, or task).",
  }),
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
  rateAtEntry: t.Integer({
    minimum: 0,
    description: "Hourly rate in integer minor currency units (e.g. cents)",
  }),
  currency: t.String({
    minLength: 3,
    maxLength: 3,
    description: "3-letter ISO currency code",
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
  const dateWorked = new Date(`${body.dateWorked}T00:00:00`);
  const today = new Date(`${todayStr}T00:00:00`);

  if (dateWorked > today) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Date worked cannot be in the future",
      }),
    );
  }

  const maxAgeCutoff = new Date(today);
  maxAgeCutoff.setDate(maxAgeCutoff.getDate() - LIMITS.timeEntryMaxAgeDays);
  if (dateWorked < maxAgeCutoff) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: `Date worked cannot be more than ${LIMITS.timeEntryMaxAgeDays} days ago`,
      }),
    );
  }

  const matter = yield* Result.await(
    safeDb((tx) =>
      tx.query.entities.findFirst({
        where: {
          id: { eq: body.matterId },
          workspaceId: { eq: workspaceId },
        },
        columns: { id: true },
      }),
    ),
  );

  if (!matter) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Matter not found in this workspace",
      }),
    );
  }

  const billedMinutes = roundToIncrement(body.durationMinutes);

  const txResult = yield* Result.await(
    safeDb(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${workspaceId}))`,
      );
      const count = await tx.$count(
        timeEntries,
        eq(timeEntries.workspaceId, workspaceId),
      );

      if (count >= LIMITS.timeEntriesPerWorkspace) {
        return {
          ok: false as const,
          status: 400 as const,
          message: "Time entries limit reached for this workspace",
        };
      }

      const [entry] = await tx
        .insert(timeEntries)
        .values({
          organizationId,
          workspaceId,
          userId,
          matterId: body.matterId,
          dateWorked: body.dateWorked,
          timezoneId: body.timezoneId,
          durationMinutes: body.durationMinutes,
          billedMinutes,
          rateAtEntry: cents(body.rateAtEntry),
          currency: body.currency,
          narrative: body.narrative,
          billable: body.billable ?? true,
          taskCode: body.taskCode ?? null,
          activityCode: body.activityCode ?? null,
          source: TIME_ENTRY_SOURCE.MANUAL,
        })
        .returning({ id: timeEntries.id });

      if (!entry) {
        return {
          ok: false as const,
          status: 500 as const,
          message: "Failed to create time entry",
        };
      }

      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.CREATE,
        resourceType: AUDIT_RESOURCE_TYPE.TIME_ENTRY,
        resourceId: entry.id,
        changes: {
          created: {
            old: null,
            new: {
              matterId: body.matterId,
              dateWorked: body.dateWorked,
              durationMinutes: body.durationMinutes,
              billedMinutes,
              rateAtEntry: cents(body.rateAtEntry),
              currency: body.currency,
              billable: body.billable ?? true,
              source: TIME_ENTRY_SOURCE.MANUAL,
            },
          },
        },
      });

      return { ok: true as const, id: entry.id };
    }),
  );

  if (!txResult.ok) {
    return Result.err(
      new HandlerError({
        status: txResult.status,
        message: txResult.message,
      }),
    );
  }

  return Result.ok({ id: txResult.id });
};

const createTimeEntry = createSafeHandler(
  {
    description:
      "Create a time entry (matterId, dateWorked, timezoneId, " +
      "durationMinutes, rateAtEntry, currency, and narrative all required). " +
      "Rates and amounts are integer minor currency units (e.g. cents); " +
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

export const roundToIncrement = (minutes: number): number => {
  const inc = LIMITS.billingIncrementMinutes;
  return Math.ceil(minutes / inc) * inc;
};
