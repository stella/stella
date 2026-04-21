import { Result } from "better-result";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { t } from "elysia";

import {
  BILLING_STATUS,
  TIME_ENTRY_SOURCE,
  timeEntries,
} from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { tUuid } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

const timerStartBodySchema = t.Object({
  matterId: tUuid,
  timezoneId: t.String({ minLength: 1, maxLength: 64 }),
  rateAtEntry: t.Integer({ minimum: 0 }),
  currency: t.String({ minLength: 3, maxLength: 3 }),
  narrative: t.Optional(t.String({ maxLength: 10_000 })),
});

const timerStart = createSafeHandler(
  {
    permissions: { timeEntry: ["create"] },
    body: timerStartBodySchema,
  },
  async function* ({ safeDb, session, workspaceId, user, body }) {
    // Check active timer limit
    const activeTimerCount = yield* Result.await(
      safeDb((tx) =>
        tx.$count(
          timeEntries,
          and(
            eq(timeEntries.userId, user.id),
            isNotNull(timeEntries.timerStartedAt),
            eq(timeEntries.source, TIME_ENTRY_SOURCE.TIMER),
            eq(timeEntries.status, BILLING_STATUS.DRAFT),
          ),
        ),
      ),
    );

    if (activeTimerCount >= LIMITS.activeTimersPerUser) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "You already have an active timer. Stop it first.",
        }),
      );
    }

    // Validate matter exists in workspace
    const matter = yield* Result.await(
      safeDb((tx) =>
        tx.query.entities.findFirst({
          where: { id: body.matterId, workspaceId: { eq: workspaceId } },
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

    const now = new Date();
    // en-CA locale formats dates as YYYY-MM-DD (ISO 8601)
    const todayStr = new Intl.DateTimeFormat("en-CA", {
      timeZone: body.timezoneId,
    }).format(now);

    // Advisory lock + count + insert in one transaction to
    // prevent TOCTOU on the workspace time entry limit.
    const txResult = yield* Result.await(
      safeDb(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${workspaceId}))`,
        );
        const totalEntries = await tx.$count(
          timeEntries,
          eq(timeEntries.workspaceId, workspaceId),
        );

        if (totalEntries >= LIMITS.timeEntriesPerWorkspace) {
          return null;
        }

        const [entry] = await tx
          .insert(timeEntries)
          .values({
            organizationId: session.activeOrganizationId,
            workspaceId,
            userId: user.id,
            matterId: body.matterId,
            dateWorked: todayStr,
            timezoneId: body.timezoneId,
            durationMinutes: 0,
            billedMinutes: 0,
            rateAtEntry: body.rateAtEntry,
            currency: body.currency,
            narrative: body.narrative ?? "",
            source: TIME_ENTRY_SOURCE.TIMER,
            status: BILLING_STATUS.DRAFT,
            timerStartedAt: now,
          })
          .returning({
            id: timeEntries.id,
            timerStartedAt: timeEntries.timerStartedAt,
          });

        return entry;
      }),
    );

    if (!txResult) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Time entries limit reached for this workspace",
        }),
      );
    }

    return Result.ok({
      id: txResult.id,
      timerStartedAt: txResult.timerStartedAt?.toISOString(),
    });
  },
);

export default timerStart;
