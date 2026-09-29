import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import {
  BILLING_STATUS,
  TIME_ENTRY_SOURCE,
  timeEntries,
  timeTimerConfirmations,
  timeTimers,
} from "@/api/db/schema";
import { canApproveTimeEntries } from "@/api/handlers/time-entries/authorization";
import {
  insertPreparedTimeEntry,
  lockTimeEntryCapacity,
  prepareTimeEntryInsert,
} from "@/api/handlers/time-entries/time-entry-insert";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { readTimePolicy } from "@/api/lib/billing-time";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { hasCurrentTimerMatterAccess } from "@/api/lib/time-entry-timer-access";
import { formatTodayInTimeZone } from "@/api/lib/timezone";

import type { TimerOwner } from "./shared";
import {
  deleteLegacyTimerDraft,
  lockTimerOwner,
  ownedTimers,
  readOwnedTimer,
  timerNotFound,
  timerParams,
  timerSeconds,
} from "./shared";

// Reuse the current transaction for policy, context and rate reads; no nested
// transaction may observe a different timer or policy snapshot.
const transactionHandle =
  (tx: Transaction): SafeDb =>
  async (run) =>
    Result.tryPromise(() => run(tx));

type ReadConfirmationOptions = {
  tx: Transaction;
  owner: TimerOwner;
  id: typeof timeTimers.$inferSelect.id;
};
const readConfirmation = async ({ tx, owner, id }: ReadConfirmationOptions) => {
  const [receipt] = await tx
    .select()
    .from(timeTimerConfirmations)
    .where(
      and(
        eq(timeTimerConfirmations.timerId, id),
        eq(timeTimerConfirmations.organizationId, owner.organizationId),
        eq(timeTimerConfirmations.userId, owner.userId),
      ),
    )
    .limit(1);
  if (receipt) {
    if (!receipt.timeEntryId) {
      return Result.err(
        new HandlerError({
          status: 409,
          message: "The confirmed entry was deleted",
          hint: "Create a new time entry if more work needs recording.",
        }),
      );
    }
    const [entry] = await tx
      .select({
        id: timeEntries.id,
        durationMinutes: timeEntries.durationMinutes,
        billedMinutes: timeEntries.billedMinutes,
      })
      .from(timeEntries)
      .where(
        and(
          eq(timeEntries.id, receipt.timeEntryId),
          eq(timeEntries.organizationId, owner.organizationId),
          eq(timeEntries.userId, owner.userId),
        ),
      )
      .limit(1);
    if (!entry) {
      return Result.err(
        new HandlerError({
          status: 404,
          message: "Confirmed entry is no longer accessible",
        }),
      );
    }
    return Result.ok(entry);
  }
  return null;
};

const confirmTimer = createSafeRootHandler(
  {
    description:
      "Confirm your timer into a draft time entry and remove it. Assign a matter with update first. Rounds billed minutes to the organization's minimum unit and enforces narrative and monthly locks. Retry with the same timer ID to get the original entry ID without creating another entry. timezoneId is an IANA timezone for the work date; timers without an effective rate default to non-billable.",
    permissions: { timeEntry: ["create"] },
    mcp: { type: "capability", reason: "billing_admin" },
    params: timerParams,
    body: t.Object({
      timezoneId: t.String({ minLength: 1, maxLength: 64 }),
      billable: t.Optional(t.Boolean()),
    }),
  },
  async function* ({
    safeDb,
    session,
    user,
    memberRole,
    params,
    body,
    recordAuditEvent,
  }) {
    const owner = {
      organizationId: session.activeOrganizationId,
      userId: user.id,
    };
    const outcome = yield* Result.await(
      safeDb(async (tx) => {
        await lockTimerOwner(tx, owner);
        const replay = await readConfirmation({ tx, owner, id: params.id });
        if (replay) {
          return replay;
        }
        const timer = await readOwnedTimer({ tx, owner, id: params.id });
        if (!timer) {
          return Result.err(timerNotFound());
        }
        const workspaceId = timer.workspaceId;
        if (!workspaceId) {
          return Result.err(
            new HandlerError({
              status: 400,
              message: "A matter is required to confirm a timer",
              hint: "Update the timer with a matterId, then confirm it again.",
            }),
          );
        }
        if (
          !(await hasCurrentTimerMatterAccess({ tx, ...owner, workspaceId }))
        ) {
          return Result.err(
            new HandlerError({
              status: 404,
              message: "Matter not found or not accessible",
              hint: "Update the timer to a matter you can access.",
            }),
          );
        }
        const legacy = timer.legacyTimeEntryId
          ? (
              await tx
                .select()
                .from(timeEntries)
                .where(
                  and(
                    eq(timeEntries.id, timer.legacyTimeEntryId),
                    eq(timeEntries.organizationId, owner.organizationId),
                    eq(timeEntries.userId, owner.userId),
                  ),
                )
                .limit(1)
                .for("update")
            ).at(0)
          : undefined;
        if (timer.legacyTimeEntryId && !legacy) {
          return Result.err(
            new HandlerError({
              status: 404,
              message: "Original timer entry is not accessible",
              hint: "Restore access to the original matter before confirming this migrated timer.",
            }),
          );
        }
        if (
          legacy &&
          (legacy.status !== BILLING_STATUS.DRAFT ||
            legacy.source !== TIME_ENTRY_SOURCE.TIMER)
        ) {
          return Result.err(
            new HandlerError({
              status: 409,
              message: "The original timer entry has changed",
              hint: "Discard the timer and review the original time entry.",
            }),
          );
        }
        const now = new Date();
        const timezoneId = legacy?.timezoneId ?? body.timezoneId;
        const dateResult = formatTodayInTimeZone({
          timezoneId,
          now: timer.startedAt,
        });
        if (dateResult.isErr()) {
          return dateResult;
        }
        const durationMinutes = Math.max(
          1,
          Math.round(timerSeconds(timer, now) / 60),
        );
        const preparedResult = await Result.gen(async function* () {
          const handle = transactionHandle(tx);
          const policy = yield* Result.await(
            readTimePolicy({
              safeDb: handle,
              organizationId: owner.organizationId,
            }),
          );
          const prepared = yield* prepareTimeEntryInsert({
            safeDb: handle,
            policy,
            canApprove: canApproveTimeEntries(memberRole),
            workspaceId,
            userId: owner.userId,
            dateWindow: "timer_completion",
            billingSnapshot:
              legacy?.workspaceId === workspaceId
                ? { hourlyRate: legacy.rateAtEntry, currency: legacy.currency }
                : undefined,
            body: {
              dateWorked: legacy?.dateWorked ?? dateResult.value,
              timezoneId,
              durationMinutes,
              narrative: timer.description ?? "",
              billable: body.billable ?? legacy?.billable,
              workItemId:
                legacy?.workspaceId === workspaceId ? legacy.workItemId : null,
              narrativeLanguage: legacy?.narrativeLanguage,
              taskCode: legacy?.taskCode,
              activityCode: legacy?.activityCode,
            },
          });
          return Result.ok(prepared);
        });
        if (preparedResult.isErr()) {
          return preparedResult;
        }
        const capacity = await lockTimeEntryCapacity({
          tx,
          workspaceId,
          replacedEntryId:
            legacy?.workspaceId === workspaceId ? legacy.id : undefined,
        });
        if (capacity.isErr()) {
          return capacity;
        }
        const prepared = preparedResult.value;
        const entry = await insertPreparedTimeEntry({
          tx,
          ...owner,
          workspaceId,
          source: TIME_ENTRY_SOURCE.TIMER,
          prepared,
          recordAuditEvent,
        });
        await tx
          .delete(timeTimers)
          .where(and(ownedTimers(owner), eq(timeTimers.id, timer.id)));
        if (legacy) {
          await deleteLegacyTimerDraft({
            tx,
            owner,
            entry: legacy,
            timerId: timer.id,
            recordAuditEvent,
          });
        }
        await tx
          .insert(timeTimerConfirmations)
          .values({ ...owner, timerId: timer.id, timeEntryId: entry.id });
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.DELETE,
          resourceType: AUDIT_RESOURCE_TYPE.TIME_TIMER,
          resourceId: timer.id,
          workspaceId,
          changes: { confirmedEntryId: { old: null, new: entry.id } },
        });
        return Result.ok({
          id: entry.id,
          durationMinutes,
          billedMinutes: prepared.billedMinutes,
        });
      }),
    );
    return outcome;
  },
);
export default confirmTimer;
