import { panic, Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import type { SafeDb } from "@/api/db/safe-db";
import {
  TIME_ENTRY_SOURCE,
  TIME_ENTRY_SUGGESTION_STATUS,
  timeEntrySuggestions,
} from "@/api/db/schema";
import { loadTimeSuggestions } from "@/api/handlers/time-entries/suggestions/load";
import {
  timeSuggestionDateSchema,
  timeSuggestionFingerprintSchema,
  timeSuggestionTimezoneSchema,
} from "@/api/handlers/time-entries/suggestions/schemas";
import {
  insertPreparedTimeEntry,
  lockTimeEntryCapacity,
  prepareTimeEntryInsert,
} from "@/api/handlers/time-entries/time-entry-insert";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const SUGGESTION_UNAVAILABLE_HINT =
  "The suggestion was already accepted or dismissed, or the day's activity " +
  "regrouped it. Call time-entries.suggestions.list for the day again and " +
  "use a fingerprint from that response.";

const acceptDecisionSchema = t.Object({
  type: t.Literal("accept"),
  durationMinutes: t.Integer({
    minimum: 1,
    description:
      "Minutes to record; the suggestion's engaged minutes unless edited",
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
      t.String({ maxLength: 20, description: "UTBMS/LEDES task code" }),
    ),
  ),
  activityCode: t.Optional(
    t.Nullable(
      t.String({ maxLength: 20, description: "UTBMS/LEDES activity code" }),
    ),
  ),
});

const dismissDecisionSchema = t.Object({
  type: t.Literal("dismiss"),
});

const createTimeSuggestionDecisionBodySchema = t.Object({
  fingerprint: timeSuggestionFingerprintSchema,
  date: timeSuggestionDateSchema,
  timezoneId: timeSuggestionTimezoneSchema,
  decision: t.Union([acceptDecisionSchema, dismissDecisionSchema], {
    description:
      "`accept` records a time entry from the suggestion; `dismiss` hides it for good",
  }),
});

type DecisionBody = Static<typeof createTimeSuggestionDecisionBodySchema>;

type DecisionContext = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  recordAuditEvent: AuditRecorder;
  body: DecisionBody;
};

const acceptSuggestion = async function* ({
  safeDb,
  organizationId,
  workspaceId,
  userId,
  recordAuditEvent,
  body,
}: DecisionContext & {
  body: DecisionBody & { decision: Static<typeof acceptDecisionSchema> };
}) {
  const loaded = yield* loadTimeSuggestions({
    safeDb,
    organizationId,
    workspaceId,
    userId,
    date: body.date,
    timezoneId: body.timezoneId,
  });
  const cluster = loaded.pending.find(
    (candidate) => candidate.fingerprint === body.fingerprint,
  );
  if (!cluster) {
    return yield* Result.err(
      new HandlerError({
        status: 409,
        message: "Suggestion is no longer pending",
        hint: SUGGESTION_UNAVAILABLE_HINT,
      }),
    );
  }

  const prepared = yield* prepareTimeEntryInsert({
    safeDb,
    workspaceId,
    userId,
    body: {
      dateWorked: body.date,
      timezoneId: body.timezoneId,
      durationMinutes: body.decision.durationMinutes,
      narrative: body.decision.narrative,
      billable: body.decision.billable,
      taskCode: body.decision.taskCode,
      activityCode: body.decision.activityCode,
    },
  });

  const outcome = yield* Result.await(
    safeDb(async (tx) => {
      // audit: skip — insertPreparedTimeEntry records the created entry in
      // this transaction; the decision row is the timekeeper's private state.
      const capacity = await lockTimeEntryCapacity(tx, workspaceId);
      if (capacity.isErr()) {
        return capacity;
      }
      // Decisions on one suggestion are serialised on an advisory lock taken
      // after the matter lock, so the read below is race-free and every
      // rejection happens before the first write. The unique
      // (workspace, user, fingerprint) index stays as the backstop.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`${workspaceId}:${userId}:${body.fingerprint}`}))`,
      );
      const [existing] = await tx
        .select({ id: timeEntrySuggestions.id })
        .from(timeEntrySuggestions)
        .where(
          and(
            eq(timeEntrySuggestions.workspaceId, workspaceId),
            eq(timeEntrySuggestions.userId, userId),
            eq(timeEntrySuggestions.fingerprint, body.fingerprint),
          ),
        );
      if (existing) {
        return Result.err(
          new HandlerError({
            status: 409,
            message: "Suggestion is no longer pending",
            hint: SUGGESTION_UNAVAILABLE_HINT,
          }),
        );
      }
      const created = await insertPreparedTimeEntry({
        tx,
        organizationId,
        workspaceId,
        userId,
        source: TIME_ENTRY_SOURCE.SUGGESTED,
        prepared,
        recordAuditEvent,
      });
      await tx.insert(timeEntrySuggestions).values({
        organizationId,
        workspaceId,
        userId,
        dateWorked: body.date,
        fingerprint: body.fingerprint,
        status: TIME_ENTRY_SUGGESTION_STATUS.ACCEPTED,
        timeEntryId: created.id,
        evidence: cluster.evidence,
      });
      return Result.ok(created);
    }),
  );
  const entry = yield* outcome;

  return {
    fingerprint: body.fingerprint,
    status: TIME_ENTRY_SUGGESTION_STATUS.ACCEPTED,
    timeEntryId: entry.id,
  };
};

const dismissSuggestion = async function* ({
  safeDb,
  organizationId,
  workspaceId,
  userId,
  body,
}: DecisionContext) {
  const loaded = yield* loadTimeSuggestions({
    safeDb,
    organizationId,
    workspaceId,
    userId,
    date: body.date,
    timezoneId: body.timezoneId,
  });
  const pending = loaded.pending.some(
    (candidate) => candidate.fingerprint === body.fingerprint,
  );
  const stored = yield* Result.await(
    safeDb(async (tx) => {
      // audit: skip — a dismissed suggestion is the timekeeper's private
      // state; no matter data changes and nothing is billed.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`${workspaceId}:${userId}:${body.fingerprint}`}))`,
      );
      // A decision already on file wins, so a repeated dismiss (or a dismiss
      // after an accept) reports the stored state instead of failing.
      const [existing] = await tx
        .select({
          status: timeEntrySuggestions.status,
          timeEntryId: timeEntrySuggestions.timeEntryId,
        })
        .from(timeEntrySuggestions)
        .where(
          and(
            eq(timeEntrySuggestions.workspaceId, workspaceId),
            eq(timeEntrySuggestions.userId, userId),
            eq(timeEntrySuggestions.fingerprint, body.fingerprint),
          ),
        );
      if (existing) {
        return Result.ok(existing);
      }
      // Only a fingerprint the day actually produced may be dismissed; the
      // table holds decisions, never caller-invented rows.
      if (!pending) {
        return Result.err(
          new HandlerError({
            status: 409,
            message: "Suggestion is no longer pending",
            hint: SUGGESTION_UNAVAILABLE_HINT,
          }),
        );
      }
      await tx.insert(timeEntrySuggestions).values({
        organizationId,
        workspaceId,
        userId,
        dateWorked: body.date,
        fingerprint: body.fingerprint,
        status: TIME_ENTRY_SUGGESTION_STATUS.DISMISSED,
      });
      return Result.ok({
        status: TIME_ENTRY_SUGGESTION_STATUS.DISMISSED,
        timeEntryId: null,
      });
    }),
  );
  const decision = yield* stored;
  return {
    fingerprint: body.fingerprint,
    status: decision.status,
    timeEntryId: decision.timeEntryId,
  };
};

const createTimeSuggestionDecision = createSafeHandler(
  {
    description:
      "Decide on a suggested time entry from time-entries.suggestions.list. " +
      "`decision.type: accept` records a time entry with the given minutes " +
      "and narrative (source `suggested`) and keeps the suggestion's " +
      "evidence with the decision; it fails with 409 when the fingerprint " +
      "is no longer pending for that day. `decision.type: dismiss` hides " +
      "the suggestion for good and is idempotent: repeating it returns the " +
      "decision already stored, including an earlier accept.",
    permissions: { timeEntry: ["create"] },
    mcp: { type: "capability", reason: "billing_admin" },
    body: createTimeSuggestionDecisionBodySchema,
  },
  async function* ({
    body,
    recordAuditEvent,
    safeDb,
    session,
    user,
    workspaceId,
  }) {
    const context: DecisionContext = {
      safeDb,
      organizationId: session.activeOrganizationId,
      workspaceId,
      userId: user.id,
      recordAuditEvent,
      body,
    };
    switch (body.decision.type) {
      case "accept":
        return Result.ok(
          yield* acceptSuggestion({
            ...context,
            body: { ...body, decision: body.decision },
          }),
        );
      case "dismiss":
        return Result.ok(yield* dismissSuggestion(context));
      default:
        body.decision satisfies never;
        return panic("Unhandled suggestion decision type");
    }
  },
);

export default createTimeSuggestionDecision;
