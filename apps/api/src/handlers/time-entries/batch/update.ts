import { Result } from "better-result";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { t } from "elysia";

import { BILLING_STATUS, timeEntries } from "@/api/db/schema";
import { timeEntryRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditEvent } from "@/api/lib/audit-log";
import { UNPRICED_TIME_ENTRY_CURRENCY } from "@/api/lib/billing-constants";
import { getTimePolicyViolation, readTimePolicy } from "@/api/lib/billing-time";
import type { TimePolicy } from "@/api/lib/billing-time";
import { recordBillingCapCrossings } from "@/api/lib/billing/arrangements";
import {
  rateLookupKey,
  resolveRatesInTransaction,
} from "@/api/lib/billing/rates";
import {
  guardRunningTimeEntries,
  timeEntryIsRunning,
} from "@/api/lib/billing/time-entry-running";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";
import { sqlCaseFragment } from "@/api/lib/sql-case-expression";
import { formatTodayInTimeZone } from "@/api/lib/timezone";

const batchUpdateBodySchema = t.Object({
  ids: t.Array(tSafeId("timeEntry"), { minItems: 1, maxItems: 200 }),
  action: t.UnionEnum([
    "approve",
    "revert_to_draft",
    "mark_billable",
    "mark_non_billable",
  ]),
});

type BatchAction =
  | "approve"
  | "revert_to_draft"
  | "mark_billable"
  | "mark_non_billable";

const buildBatchEvents = (
  rows: { id: SafeId<"timeEntry"> }[],
  action: BatchAction,
  rateChanges?: ReadonlyMap<
    SafeId<"timeEntry">,
    {
      newCurrency: string;
      newRateAtEntry: number;
      oldCurrency: string;
      oldRateAtEntry: number;
    }
  >,
): AuditEvent[] => {
  const changes = batchChangesFor(action);
  const events: AuditEvent[] = [];
  for (const row of rows) {
    const rateChange = rateChanges?.get(row.id);
    events.push({
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.TIME_ENTRY,
      resourceId: row.id,
      changes:
        rateChange === undefined
          ? changes
          : {
              ...changes,
              rateAtEntry: {
                old: rateChange.oldRateAtEntry,
                new: rateChange.newRateAtEntry,
              },
              currency: {
                old: rateChange.oldCurrency,
                new: rateChange.newCurrency,
              },
            },
    });
  }
  return events;
};

const batchChangesFor = (
  action: BatchAction,
): Record<string, { old: unknown; new: unknown }> => {
  if (action === "approve") {
    return {
      status: {
        old: BILLING_STATUS.DRAFT,
        new: BILLING_STATUS.APPROVED,
      },
    };
  }
  if (action === "revert_to_draft") {
    return {
      status: {
        old: BILLING_STATUS.APPROVED,
        new: BILLING_STATUS.DRAFT,
      },
    };
  }
  if (action === "mark_billable") {
    return { billable: { old: false, new: true } };
  }
  return { billable: { old: true, new: false } };
};

type PolicyCandidate = {
  dateWorked: string;
  narrative: string;
  timezoneId: string;
};

type BatchPolicyCheckOptions = {
  candidates: PolicyCandidate[];
  policy: TimePolicy;
  now: Date;
  checkNarrative: boolean;
};

const getBatchPolicyViolation = ({
  candidates,
  policy,
  now,
  checkNarrative,
}: BatchPolicyCheckOptions): HandlerError<400> | null => {
  for (const entry of candidates) {
    const today = formatTodayInTimeZone({ timezoneId: entry.timezoneId, now });
    if (Result.isError(today)) {
      return today.error;
    }
    const violation = getTimePolicyViolation({
      policy,
      dateWorked: entry.dateWorked,
      today: today.value,
      canApprove: true,
      narrative: checkNarrative ? entry.narrative : undefined,
    });
    if (violation) {
      return violation;
    }
  }
  return null;
};

const batchUpdate = createSafeHandler(
  {
    description:
      "Apply one action to up to 200 time entries in a matter at once: " +
      "approve, revert_to_draft, mark_billable, or mark_non_billable. " +
      "Entries that are not in the action's starting state are skipped and " +
      "only the number of changed rows is returned. Approval is refused " +
      "while any selected entry has a running timer or a billable entry has " +
      "no rate; mark_billable re-resolves each entry's rate and is refused " +
      "when one of them has no effective rate.",
    permissions: { timeEntry: ["approve"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    featureAccess: { featureId: "time-billing", type: "required" },
    realtime: timeEntryRealtimeUpdates,
    mcp: {
      type: "capability",
      reason: "billing_admin",
      consumesServices: false,
    },
    access: "write",
    body: batchUpdateBodySchema,
  },
  async function* ({
    safeDb,
    session,
    user,
    workspaceId,
    body,
    recordAuditEvent,
  }) {
    const { ids, action } = body;
    const policy = yield* Result.await(
      readTimePolicy({
        safeDb,
        organizationId: session.activeOrganizationId,
      }),
    );
    const now = new Date();

    const condition = and(
      eq(timeEntries.workspaceId, workspaceId),
      inArray(timeEntries.id, ids),
    );

    switch (action) {
      case "approve": {
        const rows = yield* Result.await(
          safeDb(async (tx) => {
            const runningError = await guardRunningTimeEntries({
              tx,
              workspaceId,
              selection: { type: "entries", ids },
              actorUserId: user.id,
            });
            if (runningError) {
              return { type: "policy" as const, error: runningError, rows: [] };
            }
            const blockers = await tx
              .select({
                billable: timeEntries.billable,
                currency: timeEntries.currency,
                dateWorked: timeEntries.dateWorked,
                narrative: timeEntries.narrative,
                timezoneId: timeEntries.timezoneId,
                running: timeEntryIsRunning(),
              })
              .from(timeEntries)
              .where(
                and(condition, eq(timeEntries.status, BILLING_STATUS.DRAFT)),
              )
              .limit(ids.length)
              .for("update");
            const violation = getBatchPolicyViolation({
              candidates: blockers,
              policy,
              now,
              checkNarrative: true,
            });
            if (violation) {
              return { type: "policy" as const, error: violation, rows: [] };
            }
            const hasRunningTimer = blockers.some((entry) => entry.running);
            if (hasRunningTimer) {
              return { type: "running_timer" as const, rows: [] };
            }
            const hasUnpricedEntry = blockers.some(
              (entry) =>
                entry.billable &&
                entry.currency === UNPRICED_TIME_ENTRY_CURRENCY,
            );
            if (hasUnpricedEntry) {
              return { type: "unpriced" as const, rows: [] };
            }
            const updated = await tx
              .update(timeEntries)
              .set({
                status: BILLING_STATUS.APPROVED,
                approvedByUserId: user.id,
                approvedAt: now,
                returnedAt: null,
                returnedByUserId: null,
                returnComment: null,
                updatedAt: now,
              })
              .where(
                and(condition, eq(timeEntries.status, BILLING_STATUS.DRAFT)),
              )
              .returning({ id: timeEntries.id });
            await recordAuditEvent(tx, buildBatchEvents(updated, action));
            await recordBillingCapCrossings(tx, {
              workspaceId,
              recordAuditEvent,
            });
            return { type: "updated" as const, rows: updated };
          }),
        );
        if (rows.type === "policy") {
          return Result.err(rows.error);
        }
        if (rows.type === "unpriced") {
          return Result.err(
            new HandlerError({
              status: 400,
              message: "Billable time entries need a rate before approval",
            }),
          );
        }
        if (rows.type === "running_timer") {
          return Result.err(
            new HandlerError({
              status: 400,
              message: "Stop running timers before approval",
            }),
          );
        }
        return Result.ok({ updated: rows.rows.length });
      }

      case "revert_to_draft": {
        const rows = yield* Result.await(
          safeDb(async (tx) => {
            const runningError = await guardRunningTimeEntries({
              tx,
              workspaceId,
              selection: { type: "entries", ids },
              actorUserId: user.id,
            });
            if (runningError) {
              return { type: "policy" as const, error: runningError, rows: [] };
            }
            const candidates = await tx
              .select({
                dateWorked: timeEntries.dateWorked,
                narrative: timeEntries.narrative,
                timezoneId: timeEntries.timezoneId,
              })
              .from(timeEntries)
              .where(
                and(condition, eq(timeEntries.status, BILLING_STATUS.APPROVED)),
              )
              .limit(ids.length)
              .for("update");
            const violation = getBatchPolicyViolation({
              candidates,
              policy,
              now,
              checkNarrative: false,
            });
            if (violation) {
              return { type: "policy" as const, error: violation };
            }
            const updated = await tx
              .update(timeEntries)
              .set({
                status: BILLING_STATUS.DRAFT,
                approvedByUserId: null,
                approvedAt: null,
                updatedAt: now,
              })
              .where(
                and(condition, eq(timeEntries.status, BILLING_STATUS.APPROVED)),
              )
              .returning({ id: timeEntries.id });
            await recordAuditEvent(tx, buildBatchEvents(updated, action));
            await recordBillingCapCrossings(tx, {
              workspaceId,
              recordAuditEvent,
            });
            return { type: "updated" as const, rows: updated };
          }),
        );
        if (rows.type === "policy") {
          return Result.err(rows.error);
        }
        return Result.ok({ updated: rows.rows.length });
      }

      case "mark_billable": {
        const result = yield* Result.await(
          safeDb(async (tx) => {
            const runningError = await guardRunningTimeEntries({
              tx,
              workspaceId,
              selection: { type: "entries", ids },
              actorUserId: user.id,
            });
            if (runningError) {
              return { type: "policy" as const, error: runningError, rows: [] };
            }
            const candidates = await tx
              .select({
                currency: timeEntries.currency,
                dateWorked: timeEntries.dateWorked,
                narrative: timeEntries.narrative,
                timezoneId: timeEntries.timezoneId,
                id: timeEntries.id,
                rateAtEntry: timeEntries.rateAtEntry,
                userId: timeEntries.userId,
              })
              .from(timeEntries)
              .where(
                and(
                  condition,
                  eq(timeEntries.billable, false),
                  ne(timeEntries.status, BILLING_STATUS.BILLED),
                  ne(timeEntries.status, BILLING_STATUS.WRITTEN_OFF),
                ),
              )
              .for("update");
            const violation = getBatchPolicyViolation({
              candidates,
              policy,
              now,
              checkNarrative: false,
            });
            if (violation) {
              return { type: "policy" as const, error: violation, rows: [] };
            }

            const rateLookups = candidates.flatMap((row) =>
              row.userId
                ? [
                    {
                      dateWorked: row.dateWorked,
                      userId: brandPersistedUserId(row.userId),
                    },
                  ]
                : [],
            );
            const resolvedRates = await resolveRatesInTransaction({
              lookups: rateLookups,
              tx,
              workspaceId,
            });
            const unresolved = candidates.some(
              (row) =>
                !row.userId ||
                !resolvedRates.has(
                  rateLookupKey({
                    dateWorked: row.dateWorked,
                    userId: brandPersistedUserId(row.userId),
                  }),
                ),
            );
            if (unresolved) {
              return { type: "unpriced" as const, rows: [] };
            }

            const rateChanges = new Map<
              SafeId<"timeEntry">,
              {
                newCurrency: string;
                newRateAtEntry: number;
                oldCurrency: string;
                oldRateAtEntry: number;
              }
            >();
            const rateCases = candidates.flatMap((row) => {
              const resolved = row.userId
                ? resolvedRates.get(
                    rateLookupKey({
                      dateWorked: row.dateWorked,
                      userId: brandPersistedUserId(row.userId),
                    }),
                  )
                : undefined;
              if (!resolved) {
                return [];
              }
              if (
                row.currency !== resolved.currency ||
                row.rateAtEntry !== resolved.hourlyRate
              ) {
                rateChanges.set(row.id, {
                  newCurrency: resolved.currency,
                  newRateAtEntry: resolved.hourlyRate,
                  oldCurrency: row.currency,
                  oldRateAtEntry: row.rateAtEntry,
                });
              }
              return [
                {
                  id: row.id,
                  currency: resolved.currency,
                  rateAtEntry: resolved.hourlyRate,
                },
              ];
            });
            const rateAtEntry =
              rateCases.length > 0
                ? sqlCaseFragment({
                    branches: rateCases.map(
                      ({ id, rateAtEntry: rate }) =>
                        sql`WHEN ${eq(timeEntries.id, id)} THEN ${rate}`,
                    ),
                    fallback: sql`${timeEntries.rateAtEntry}`,
                  })
                : undefined;
            const currency =
              rateCases.length > 0
                ? sqlCaseFragment({
                    branches: rateCases.map(
                      ({ id, currency: value }) =>
                        sql`WHEN ${eq(timeEntries.id, id)} THEN ${value}`,
                    ),
                    fallback: sql`${timeEntries.currency}`,
                  })
                : undefined;
            const updated = await tx
              .update(timeEntries)
              .set({
                billable: true,
                ...(rateAtEntry === undefined ? {} : { rateAtEntry }),
                ...(currency === undefined ? {} : { currency }),
                updatedAt: new Date(),
              })
              .where(
                and(
                  condition,
                  eq(timeEntries.billable, false),
                  ne(timeEntries.status, BILLING_STATUS.BILLED),
                  ne(timeEntries.status, BILLING_STATUS.WRITTEN_OFF),
                ),
              )
              .returning({ id: timeEntries.id });
            await recordAuditEvent(
              tx,
              buildBatchEvents(updated, action, rateChanges),
            );
            await recordBillingCapCrossings(tx, {
              workspaceId,
              recordAuditEvent,
            });
            return { type: "updated" as const, rows: updated };
          }),
        );
        if (result.type === "policy") {
          return Result.err(result.error);
        }
        if (result.type === "unpriced") {
          return Result.err(
            new HandlerError({
              status: 400,
              message: "Billable time entries need a rate before this change",
            }),
          );
        }
        return Result.ok({ updated: result.rows.length });
      }

      case "mark_non_billable": {
        const rows = yield* Result.await(
          safeDb(async (tx) => {
            const runningError = await guardRunningTimeEntries({
              tx,
              workspaceId,
              selection: { type: "entries", ids },
              actorUserId: user.id,
            });
            if (runningError) {
              return { type: "policy" as const, error: runningError, rows: [] };
            }
            const candidates = await tx
              .select({
                dateWorked: timeEntries.dateWorked,
                narrative: timeEntries.narrative,
                timezoneId: timeEntries.timezoneId,
              })
              .from(timeEntries)
              .where(
                and(
                  condition,
                  eq(timeEntries.billable, true),
                  ne(timeEntries.status, BILLING_STATUS.BILLED),
                  ne(timeEntries.status, BILLING_STATUS.WRITTEN_OFF),
                ),
              )
              .limit(ids.length)
              .for("update");
            const violation = getBatchPolicyViolation({
              candidates,
              policy,
              now,
              checkNarrative: false,
            });
            if (violation) {
              return { type: "policy" as const, error: violation };
            }
            const updated = await tx
              .update(timeEntries)
              .set({ billable: false, updatedAt: new Date() })
              .where(
                and(
                  condition,
                  eq(timeEntries.billable, true),
                  ne(timeEntries.status, BILLING_STATUS.BILLED),
                  ne(timeEntries.status, BILLING_STATUS.WRITTEN_OFF),
                ),
              )
              .returning({ id: timeEntries.id });
            await recordAuditEvent(tx, buildBatchEvents(updated, action));
            await recordBillingCapCrossings(tx, {
              workspaceId,
              recordAuditEvent,
            });
            return { type: "updated" as const, rows: updated };
          }),
        );
        if (rows.type === "policy") {
          return Result.err(rows.error);
        }
        return Result.ok({ updated: rows.rows.length });
      }

      default:
        return Result.err(
          new HandlerError({ status: 400, message: "Invalid action" }),
        );
    }
  },
);

export default batchUpdate;
