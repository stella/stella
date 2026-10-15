import { panic, Result } from "better-result";
import { and, eq, gt, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import * as v from "valibot";

import { MEMBER_REMOVAL_BUSY_CODE } from "@stll/api-contract";
import { mapWithConcurrency } from "@stll/concurrency";

import { invitation, member, organization } from "@/api/db/auth-schema";
import {
  assertCallerOrg,
  proveMattersOrgScope,
  proveOrgScope,
  withOrgScope,
} from "@/api/db/org-scope";
import type { OrgScope } from "@/api/db/org-scope";
import type { Transaction } from "@/api/db/root";
import { abortTransaction } from "@/api/db/safe-db";
import {
  BILLING_STATUS,
  desktopEditHandoffs,
  entities,
  pdfSigningSessions,
  timeEntries,
  desktopEditSessions,
  desktopPresence,
  flowRuns,
  flowDefinitions,
  flowRunSteps,
  mcpUserConnections,
  sharepointConnections,
  sharepointOAuthState,
  mcpOAuthState,
  contacts,
  searchHistoryEntries,
  searchHistoryOwners,
  searchHistoryTombstones,
  taskAssignees,
  workspaceMembers,
  workspaces,
  workObligations,
  workObligationEvents,
  WORK_OBLIGATION_STATUS,
  WORK_OBLIGATION_EVENT_TYPE,
} from "@/api/db/schema";
import { ACTIVE_TASK_REASSIGNMENT_STATUSES } from "@/api/lib/account-deletion-reassignment";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createBackgroundAuditRecorder,
  recordAuditGroups,
} from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { removeOrganizationMemberWithAuthArtifacts } from "@/api/lib/auth-artifacts";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { lockOpenSigningPage } from "@/api/lib/db/aggregate-lock";
import { executedRows } from "@/api/lib/db/executed-rows";
import { FLOW_RUN_TRANSITIONS_V1 } from "@/api/lib/db/flow-run-transition-spec";
import { readCursorPage } from "@/api/lib/db/read-bounded";
import { TRANSITIONS } from "@/api/lib/db/transition-specs";
import { transitionBatch } from "@/api/lib/db/transitions";
import { clearOrganizationCorrespondenceAssignments } from "@/api/lib/email/correspondence/offboarding";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { tryLockFeatureRecoveryAdmission } from "@/api/lib/feature-access/recovery-admission-lock";
import {
  FLOWS_FEATURE_ID,
  SIGNALS_FEATURE_ID,
} from "@/api/lib/feature-access/registry";
import { MAX_FLOW_STEPS } from "@/api/lib/flows/flow-types";
import { LIMITS } from "@/api/lib/limits";
import { isPgError, PG_ERROR } from "@/api/lib/pg-error";
import { brandPersistedOrganizationId } from "@/api/lib/safe-id-boundaries";
import { enqueueContactSearchRepairs } from "@/api/lib/search/projection-repair-queue";
import { lockTaskAssignmentMembers } from "@/api/lib/tasks/assignment-membership";
import { closeRemovedMemberActiveTimer } from "@/api/lib/time-entry-offboarding";

type AssignmentScope =
  | { type: "workspace"; workspaceId: SafeId<"workspace"> }
  | { type: "organization"; organizationId: SafeId<"organization"> }
  | { type: "account" };

type ClearMemberAssignmentsOptions = {
  tx: Transaction;
  scope: AssignmentScope;
  userId: SafeId<"user">;
  actorUserId: SafeId<"user">;
  reassignTo?: SafeId<"user"> | undefined;
  recordAuditEvent?: AuditRecorder | undefined;
};

/**
 * Collects the audit events a scoped role produces so they are recorded after
 * the caller's role and settings are restored.
 */
const bufferAuditEvents =
  (sink: Parameters<AuditRecorder>[1][]): AuditRecorder =>
  async (_auditTx, events) => {
    sink.push(events);
    await Promise.resolve();
  };

const removalBusy = () =>
  new HandlerError({
    status: 409,
    code: MEMBER_REMOVAL_BUSY_CODE,
    retryable: true,
    message: "Other work is in progress. Please try again shortly.",
  });

/** Membership cleanup must serialize with recovery without waiting on its inverse lock order. */
const tryLockMemberFeatureAdmission = async (
  tx: Transaction,
  organizationId: SafeId<"organization">,
): Promise<void> => {
  const featureIds = [FLOWS_FEATURE_ID, SIGNALS_FEATURE_ID] satisfies [
    typeof FLOWS_FEATURE_ID,
    typeof SIGNALS_FEATURE_ID,
  ];
  for (const featureId of featureIds) {
    if (
      // db-await-in-loop: take the two admission locks in canonical feature order without waiting.
      !(await tryLockFeatureRecoveryAdmission({
        tx,
        organizationId,
        featureId,
      }))
    ) {
      abortTransaction(removalBusy());
    }
  }
};

const tryLockAccountFeatureAdmission = async (
  tx: Transaction,
  userId: SafeId<"user">,
): Promise<void> => {
  let afterId: string | undefined;
  for (;;) {
    const page = await readCursorPage(
      tx
        .select({ organizationId: member.organizationId })
        .from(member)
        .where(
          and(
            eq(member.userId, userId),
            afterId === undefined
              ? undefined
              : gt(member.organizationId, afterId),
          ),
        )
        .orderBy(member.organizationId),
      {
        limit: LIMITS.memberRemovalCleanupBatchSize,
        cursorForItem: (row) => row.organizationId,
      },
    );
    for (const { organizationId } of page.items) {
      // db-await-in-loop: nonblocking admission locks follow ascending organization and feature order.
      await tryLockMemberFeatureAdmission(
        tx,
        brandPersistedOrganizationId(organizationId),
      );
    }
    if (page.nextCursor === null) {
      return;
    }
    afterId = page.items.at(-1)?.organizationId;
    if (afterId === undefined) {
      panic("Membership page has a cursor without a row");
    }
  }
};

const lockScopeFeatureAdmission = async ({
  tx,
  scope,
  userId,
}: ClearMemberAssignmentsOptions): Promise<void> => {
  switch (scope.type) {
    case "workspace": {
      const row = (
        await tx
          .select({ organizationId: workspaces.organizationId })
          .from(workspaces)
          .where(eq(workspaces.id, scope.workspaceId))
          .limit(1)
      ).at(0);
      if (row) {
        await tryLockMemberFeatureAdmission(tx, row.organizationId);
      }
      return;
    }
    case "organization":
      await tryLockMemberFeatureAdmission(tx, scope.organizationId);
      return;
    case "account":
      await tryLockAccountFeatureAdmission(tx, userId);
      return;
    default:
      scope satisfies never;
      return panic("Unhandled member cleanup scope");
  }
};

/** Existing account deletion holds organization membership first; never wait on its inverse. */
export const tryLockMemberCleanupWorkspace = async (
  tx: Transaction,
  workspaceId: SafeId<"workspace">,
): Promise<void> => {
  const advisory = await tx
    .select({
      locked: sql<boolean>`pg_try_advisory_xact_lock(hashtext(${workspaceId}))`,
    })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  if (!advisory.at(0)?.locked) {
    abortTransaction(removalBusy());
  }
  const locked = await Result.tryPromise({
    try: async () =>
      await tx
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .for("update", { noWait: true }),
    catch: (error) => error,
  });
  if (Result.isError(locked)) {
    abortTransaction(
      isPgError(locked.error, PG_ERROR.LOCK_NOT_AVAILABLE)
        ? removalBusy()
        : locked.error,
    );
  }
};

const openTaskStatus = or(
  isNull(entities.status),
  inArray(entities.status, ACTIVE_TASK_REASSIGNMENT_STATUSES),
);

const memberWorkspaceScope = (scope: AssignmentScope) => {
  if (scope.type === "workspace") {
    return eq(workspaces.id, scope.workspaceId);
  }
  if (scope.type === "organization") {
    return eq(workspaces.organizationId, scope.organizationId);
  }
  return undefined;
};

const assertAssignmentScope = (proof: OrgScope, requested: AssignmentScope) => {
  switch (requested.type) {
    case "organization":
      if (assertCallerOrg(proof, requested.organizationId).isErr()) {
        abortTransaction(removalBusy());
      }
      return;
    case "workspace":
      if (!proof.workspaceIds.includes(requested.workspaceId)) {
        abortTransaction(removalBusy());
      }
      return;
    case "account":
      return;
    default: {
      requested satisfies never;
      panic("Unhandled assignment scope");
    }
  }
};

const clearMemberObligationOwners = async ({
  tx,
  scope,
  userId,
  actorUserId,
  reassignTo,
}: ClearMemberAssignmentsOptions) => {
  if (scope.type === "organization") {
    const ownershipScope = and(
      eq(workspaces.organizationId, scope.organizationId),
      eq(workObligations.ownerUserId, userId),
      inArray(workObligations.status, [
        WORK_OBLIGATION_STATUS.ACTIVE,
        WORK_OBLIGATION_STATUS.AWAITING_ACKNOWLEDGEMENT,
      ]),
    );
    const ownedRows = tx
      .select({ id: workObligations.entityId })
      .from(workObligations)
      .innerJoin(workspaces, eq(workspaces.id, workObligations.workspaceId))
      .where(ownershipScope);
    const rowCount = await tx.$count(ownedRows.as("owned_rows"));
    for (
      let remaining = rowCount;
      remaining > 0;
      remaining -= LIMITS.memberRemovalCleanupBatchSize
    ) {
      // db-await-in-loop: drain mutable ownership in bounded audited batches.
      const owned = await tx
        .select({
          entityId: workObligations.entityId,
          workspaceId: workObligations.workspaceId,
          status: workObligations.status,
        })
        .from(workObligations)
        .innerJoin(workspaces, eq(workspaces.id, workObligations.workspaceId))
        .where(ownershipScope)
        .orderBy(workObligations.workspaceId, workObligations.entityId)
        // Locked drains process exactly this batch; no unprocessed sentinel may acquire a lock.
        .limit(Math.min(remaining, LIMITS.memberRemovalCleanupBatchSize))
        .for("update", { of: workObligations });
      if (owned.length === 0) {
        break;
      }
      const nextOwnerUserId = reassignTo ?? null;
      const nextStatus = reassignTo
        ? WORK_OBLIGATION_STATUS.AWAITING_ACKNOWLEDGEMENT
        : WORK_OBLIGATION_STATUS.UNASSIGNED;
      if (reassignTo) {
        for (const workspaceId of [
          ...new Set(owned.map((row) => row.workspaceId)),
        ].toSorted()) {
          // db-await-in-loop: validate held replacement memberships in matter order.
          const members = await lockTaskAssignmentMembers({
            tx,
            workspaceId,
            userIds: [reassignTo],
          });
          if (!members.has(reassignTo)) {
            abortTransaction(
              new HandlerError({
                status: 400,
                message: "User is not a member of this workspace",
              }),
            );
          }
        }
      }
      if (owned.length > 0) {
        // db-await-in-loop: transition this held ownership page before consuming the next counted batch.
        const changedCounts = await mapWithConcurrency({
          items: owned,
          limit: 1,
          operation: async (ownedRow) => {
            const proof = await proveOrgScope(tx, {
              table: "workObligations",
              where: sql`${and(
                eq(workObligations.entityId, ownedRow.entityId),
                eq(workObligations.workspaceId, ownedRow.workspaceId),
                eq(workObligations.ownerUserId, userId),
                eq(workObligations.status, ownedRow.status),
              )}`,
            });
            if (proof.isErr()) {
              abortTransaction(removalBusy());
            }
            assertAssignmentScope(proof.value, scope);
            const auditEvents: Parameters<AuditRecorder>[1][] = [];
            const changed = await withOrgScope({
              tx,
              scope: proof.value,
              actor: { type: "system" },
              fn: async (scopedTx) => {
                const transitioned = await transitionBatch({
                  tx: scopedTx,
                  spec: TRANSITIONS.workObligations,
                  ids: [ownedRow.entityId],
                  options: {
                    from: [
                      WORK_OBLIGATION_STATUS.ACTIVE,
                      WORK_OBLIGATION_STATUS.AWAITING_ACKNOWLEDGEMENT,
                    ],
                    to: nextStatus,
                    set: {
                      ownerUserId: nextOwnerUserId,
                      acknowledgedAt: null,
                      acknowledgedByUserId: null,
                      updatedAt: new Date(),
                    },
                  },
                  recordTransitionAuditEvent: async (auditTx, rows) => {
                    const changedIds = new Set(rows.map(({ id }) => id));
                    const changedOwners = [ownedRow].filter(({ entityId }) =>
                      changedIds.has(entityId),
                    );
                    const recorder = bufferAuditEvents(auditEvents);
                    await recorder(
                      auditTx,
                      changedOwners.map((row) => ({
                        action: AUDIT_ACTION.UPDATE,
                        resourceType: AUDIT_RESOURCE_TYPE.WORK_OBLIGATION,
                        resourceId: row.entityId,
                        workspaceId: row.workspaceId,
                        changes: {
                          ownerUserId: { old: userId, new: nextOwnerUserId },
                          status: { old: row.status, new: nextStatus },
                        },
                        metadata: { cause: "membership_removed" },
                      })),
                    );
                  },
                });
                const changedIds = new Set(transitioned.map(({ id }) => id));
                const changedOwners = [ownedRow].filter(({ entityId }) =>
                  changedIds.has(entityId),
                );
                await scopedTx.insert(workObligationEvents).values(
                  changedOwners.map((row) => ({
                    id: createSafeId<"workObligationEvent">(),
                    workspaceId: row.workspaceId,
                    obligationEntityId: row.entityId,
                    actorUserId,
                    type: WORK_OBLIGATION_EVENT_TYPE.DELEGATED,
                    details: {
                      type: "ownership_changed" as const,
                      previousOwnerUserId: userId,
                      nextOwnerUserId,
                      cause: "owner_removed_from_workspace" as const,
                    },
                    occurredAt: new Date(),
                  })),
                );
                return transitioned;
              },
            });
            if (changed.length !== 1) {
              panic(
                "Locked obligation ownership changed during member removal",
              );
            }
            const recordMemberTransitionAuditEvent =
              createBackgroundAuditRecorder({
                organizationId: proof.value.organizationId,
                workspaceId: null,
                userId: actorUserId,
                execution: {
                  performer: { type: "user", id: actorUserId },
                  trigger: { type: "system", source: "membership_removal" },
                },
              });
            for (const events of auditEvents) {
              // db-await-in-loop: replay exact transition events after the scoped role restores.
              await recordMemberTransitionAuditEvent(tx, events);
            }
            return changed.length;
          },
        });
        if (
          changedCounts.reduce((count, value) => count + value, 0) !==
          owned.length
        ) {
          panic("Locked obligation ownership changed during member removal");
        }
      }
    }
  }
};

const clearMemberTaskAssignments = async ({
  tx,
  scope,
  userId,
  actorUserId,
  reassignTo,
  recordAuditEvent,
}: ClearMemberAssignmentsOptions) => {
  const workspaceScope = memberWorkspaceScope(scope);
  const assignmentScope = and(
    eq(taskAssignees.userId, userId),
    workspaceScope,
    // Completed and cancelled tasks keep their former assignee as
    // history; only open work moves or returns to the matter.
    openTaskStatus,
  );
  const assignedRows = tx
    .select({ id: taskAssignees.entityId })
    .from(taskAssignees)
    .innerJoin(workspaces, eq(workspaces.id, taskAssignees.workspaceId))
    .innerJoin(entities, eq(entities.id, taskAssignees.entityId))
    .where(assignmentScope);
  const rowCount = await tx.$count(assignedRows.as("assigned_rows"));
  for (
    let remaining = rowCount;
    remaining > 0;
    remaining -= LIMITS.memberRemovalCleanupBatchSize
  ) {
    const assigned = (
      await readCursorPage(
        tx
          .select({
            id: taskAssignees.id,
            entityId: taskAssignees.entityId,
            role: taskAssignees.role,
            workspaceId: taskAssignees.workspaceId,
            organizationId: workspaces.organizationId,
          })
          .from(taskAssignees)
          .innerJoin(workspaces, eq(workspaces.id, taskAssignees.workspaceId))
          .innerJoin(entities, eq(entities.id, taskAssignees.entityId))
          .where(assignmentScope)
          .orderBy(taskAssignees.entityId),
        {
          limit: LIMITS.memberRemovalCleanupBatchSize,
          cursorForItem: (row) => row.entityId,
        },
      )
    ).items;
    if (assigned.length === 0) {
      break;
    }
    const byWorkspace = Map.groupBy(assigned, (row) => row.workspaceId);
    // Validate every destination before any write; an invalid handoff is atomic.
    if (reassignTo) {
      for (const workspaceId of [...byWorkspace.keys()].toSorted()) {
        // db-await-in-loop: one held membership per affected matter, in deterministic order.
        const members = await lockTaskAssignmentMembers({
          tx,
          workspaceId,
          userIds: [reassignTo],
        });
        if (!members.has(reassignTo)) {
          abortTransaction(
            new HandlerError({
              status: 400,
              message: "User is not a member of this workspace",
            }),
          );
        }
      }
    }
    await mapWithConcurrency({
      items: assigned,
      limit: 1,
      operation: async (row) => {
        const proof = await proveOrgScope(tx, {
          table: "taskAssignees",
          where: sql`${and(
            eq(taskAssignees.id, row.id),
            eq(taskAssignees.userId, userId),
            eq(taskAssignees.entityId, row.entityId),
            eq(taskAssignees.workspaceId, row.workspaceId),
          )}`,
        });
        if (proof.isErr()) {
          abortTransaction(removalBusy());
        }
        assertAssignmentScope(proof.value, scope);
        const workspaceId =
          proof.value.workspaceIds.at(0) ??
          panic("Task assignment requires its matter");
        await withOrgScope({
          tx,
          scope: proof.value,
          actor: { type: "system" },
          fn: async (scopedTx) => {
            await scopedTx
              .delete(taskAssignees)
              .where(
                and(
                  eq(taskAssignees.id, row.id),
                  eq(taskAssignees.userId, userId),
                  eq(taskAssignees.entityId, row.entityId),
                  eq(taskAssignees.workspaceId, workspaceId),
                ),
              );
            if (!reassignTo) {
              return;
            }
            await scopedTx
              .insert(taskAssignees)
              .values({
                entityId: row.entityId,
                role: row.role,
                workspaceId,
                userId: reassignTo,
              })
              .onConflictDoNothing({
                target: [taskAssignees.entityId, taskAssignees.userId],
              });
          },
        });
        await recordAuditGroups({
          tx,
          recordAuditEvent,
          groups: [
            {
              bindings: {
                organizationId: proof.value.organizationId,
                workspaceId,
                userId: actorUserId,
                execution: {
                  performer: { type: "user" as const, id: actorUserId },
                  trigger: {
                    type: "system" as const,
                    source: "membership_removal",
                  },
                },
              },
              events: [
                {
                  action: AUDIT_ACTION.UPDATE,
                  resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
                  resourceId: row.entityId,
                  workspaceId: row.workspaceId,
                  changes: {
                    assigneeUserId: { old: userId, new: reassignTo ?? null },
                  },
                  metadata: {
                    kind: "task" as const,
                    change: reassignTo
                      ? "assignee-reassigned"
                      : "assignee-removed",
                    role: row.role,
                    cause: "membership_removed",
                  },
                },
              ],
            },
          ],
        });
      },
    });
  }
};

type RecordMemberSessionTransitionsOptions = {
  tx: Transaction;
  actorUserId: SafeId<"user">;
  resourceType:
    | typeof AUDIT_RESOURCE_TYPE.PDF_SIGNING_SESSION
    | typeof AUDIT_RESOURCE_TYPE.DESKTOP_EDIT_SESSION;
  rows: readonly {
    id: string;
    workspaceId: SafeId<"workspace">;
    organizationId: SafeId<"organization">;
  }[];
  recordAuditEvent?: AuditRecorder | undefined;
};

const recordMemberSessionTransitions = async ({
  tx,
  actorUserId,
  resourceType,
  rows,
  recordAuditEvent,
}: RecordMemberSessionTransitionsOptions) => {
  await recordAuditGroups({
    tx,
    recordAuditEvent,
    groups: rows.map((row) => ({
      bindings: {
        organizationId: row.organizationId,
        workspaceId: row.workspaceId,
        userId: actorUserId,
        execution: {
          performer: { type: "user" as const, id: actorUserId },
          trigger: { type: "system" as const, source: "membership_removal" },
        },
      },
      events: [
        {
          action: AUDIT_ACTION.UPDATE,
          resourceType,
          resourceId: row.id,
          workspaceId: row.workspaceId,
          changes: { status: { old: "open", new: "cancelled" } },
          metadata: { cause: "membership_removed" },
        },
      ],
    })),
  });
};

const clearMemberTakeovers = async ({
  tx,
  scope,
  userId,
  actorUserId,
  recordAuditEvent,
}: ClearMemberAssignmentsOptions) => {
  const workspaceScope = memberWorkspaceScope(scope);
  const scopedWorkspaces = tx
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(workspaceScope);
  const removePage = async (cursor: string | undefined): Promise<void> => {
    // A pending takeover would hand the departing member a fresh session token.
    const page = await readCursorPage(
      tx
        .select({
          id: desktopEditSessions.id,
          workspaceId: desktopEditSessions.workspaceId,
          organizationId: workspaces.organizationId,
        })
        .from(desktopEditSessions)
        .innerJoin(
          workspaces,
          eq(workspaces.id, desktopEditSessions.workspaceId),
        )
        .where(
          and(
            cursor === undefined
              ? undefined
              : sql`${desktopEditSessions.id} > ${cursor}`,
            inArray(desktopEditSessions.workspaceId, scopedWorkspaces),
            eq(desktopEditSessions.takeoverRequestedBy, userId),
            eq(desktopEditSessions.status, "open"),
          ),
        )
        .orderBy(desktopEditSessions.id),
      {
        limit: LIMITS.memberRemovalCleanupBatchSize,
        cursorForItem: (row) => row.id,
      },
    );
    await mapWithConcurrency({
      items: page.items,
      limit: 1,
      operation: async (row) => {
        const proof = await proveOrgScope(tx, {
          table: "desktopEditSessions",
          where: sql`${and(
            eq(desktopEditSessions.id, row.id),
            eq(desktopEditSessions.workspaceId, row.workspaceId),
            eq(desktopEditSessions.takeoverRequestedBy, userId),
            eq(desktopEditSessions.status, "open"),
          )}`,
        });
        if (proof.isErr()) {
          abortTransaction(removalBusy());
        }
        assertAssignmentScope(proof.value, scope);
        await withOrgScope({
          tx,
          scope: proof.value,
          actor: { type: "system" },
          fn: async (scopedTx) => {
            await scopedTx
              .update(desktopEditSessions)
              .set({ takeoverRequestedBy: null, takeoverRequestedAt: null })
              .where(
                and(
                  eq(desktopEditSessions.id, row.id),
                  eq(desktopEditSessions.workspaceId, row.workspaceId),
                  eq(desktopEditSessions.takeoverRequestedBy, userId),
                  eq(desktopEditSessions.status, "open"),
                ),
              );
          },
        });
        await recordAuditGroups({
          tx,
          recordAuditEvent,
          groups: [
            {
              bindings: {
                organizationId: proof.value.organizationId,
                workspaceId: row.workspaceId,
                userId: actorUserId,
                execution: {
                  performer: { type: "user" as const, id: actorUserId },
                  trigger: {
                    type: "system" as const,
                    source: "membership_removal",
                  },
                },
              },
              events: [
                {
                  action: AUDIT_ACTION.UPDATE,
                  resourceType: AUDIT_RESOURCE_TYPE.DESKTOP_EDIT_SESSION,
                  resourceId: row.id,
                  workspaceId: row.workspaceId,
                  changes: { takeoverRequestedBy: { old: userId, new: null } },
                  metadata: { cause: "membership_removed" },
                },
              ],
            },
          ],
        });
      },
    });
    if (page.nextCursor !== null) {
      await removePage(page.nextCursor);
    }
  };
  await removePage(undefined);
};

const expireMemberHandoffs = async ({
  tx,
  scope,
  userId,
  actorUserId,
  recordAuditEvent,
}: ClearMemberAssignmentsOptions) => {
  const workspaceScope = memberWorkspaceScope(scope);
  const scopedWorkspaces = tx
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(workspaceScope);
  const now = new Date();
  const removePage = async (cursor: string | undefined): Promise<void> => {
    const page = await readCursorPage(
      tx
        .select({
          id: desktopEditHandoffs.id,
          entityId: desktopEditHandoffs.entityId,
          workspaceId: desktopEditHandoffs.workspaceId,
          organizationId: workspaces.organizationId,
        })
        .from(desktopEditHandoffs)
        .innerJoin(
          workspaces,
          eq(workspaces.id, desktopEditHandoffs.workspaceId),
        )
        .where(
          and(
            cursor === undefined
              ? undefined
              : sql`${desktopEditHandoffs.id} > ${cursor}`,
            inArray(desktopEditHandoffs.workspaceId, scopedWorkspaces),
            eq(desktopEditHandoffs.createdBy, userId),
            sql`${desktopEditHandoffs.expiresAt} > ${now}`,
          ),
        )
        .orderBy(desktopEditHandoffs.id),
      {
        limit: LIMITS.memberRemovalCleanupBatchSize,
        cursorForItem: (row) => row.id,
      },
    );
    await mapWithConcurrency({
      items: page.items,
      limit: 1,
      operation: async (row) => {
        const proof = await proveOrgScope(tx, {
          table: "desktopEditHandoffs",
          where: sql`${and(
            eq(desktopEditHandoffs.id, row.id),
            eq(desktopEditHandoffs.workspaceId, row.workspaceId),
            eq(desktopEditHandoffs.createdBy, userId),
            sql`${desktopEditHandoffs.expiresAt} > ${now}`,
          )}`,
        });
        if (proof.isErr()) {
          abortTransaction(removalBusy());
        }
        assertAssignmentScope(proof.value, scope);
        await withOrgScope({
          tx,
          scope: proof.value,
          actor: { type: "system" },
          fn: async (scopedTx) => {
            await scopedTx
              .update(desktopEditHandoffs)
              .set({ expiresAt: now, updatedAt: now })
              .where(
                and(
                  eq(desktopEditHandoffs.id, row.id),
                  eq(desktopEditHandoffs.workspaceId, row.workspaceId),
                  eq(desktopEditHandoffs.createdBy, userId),
                  sql`${desktopEditHandoffs.expiresAt} > ${now}`,
                ),
              );
          },
        });
        await recordAuditGroups({
          tx,
          recordAuditEvent,
          groups: [
            {
              bindings: {
                organizationId: proof.value.organizationId,
                workspaceId: row.workspaceId,
                userId: actorUserId,
                execution: {
                  performer: { type: "user" as const, id: actorUserId },
                  trigger: {
                    type: "system" as const,
                    source: "membership_removal",
                  },
                },
              },
              events: [
                {
                  action: AUDIT_ACTION.UPDATE,
                  resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
                  resourceId: row.entityId,
                  workspaceId: row.workspaceId,
                  metadata: {
                    cause: "membership_removed",
                    change: "desktop-handoff-expired",
                    handoffId: row.id,
                  },
                },
              ],
            },
          ],
        });
      },
    });
    if (page.nextCursor !== null) {
      await removePage(page.nextCursor);
    }
  };
  await removePage(undefined);
};

const cancelMemberSigningSessions = async ({
  tx,
  scope,
  userId,
  actorUserId,
  recordAuditEvent,
}: ClearMemberAssignmentsOptions) => {
  const workspaceScope = memberWorkspaceScope(scope);
  const scopedWorkspaces = tx
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(workspaceScope);
  const now = new Date();
  const signingScope = and(
    inArray(pdfSigningSessions.workspaceId, scopedWorkspaces),
    eq(pdfSigningSessions.createdBy, userId),
    eq(pdfSigningSessions.status, "open"),
  );
  const signingCount = await tx.$count(pdfSigningSessions, signingScope);
  for (
    let remaining = signingCount;
    remaining > 0;
    remaining -= LIMITS.memberRemovalCleanupBatchSize
  ) {
    // db-await-in-loop: discover a bounded signing page after the matter prefix.
    const signing = await tx
      .select({
        id: pdfSigningSessions.id,
        workspaceId: pdfSigningSessions.workspaceId,
        organizationId: workspaces.organizationId,
      })
      .from(pdfSigningSessions)
      .innerJoin(workspaces, eq(workspaces.id, pdfSigningSessions.workspaceId))
      .where(signingScope)
      .orderBy(
        sql`${workspaces.organizationId} COLLATE "C"`,
        pdfSigningSessions.id,
      )
      .limit(Math.min(remaining, LIMITS.memberRemovalCleanupBatchSize));
    if (signing.length === 0) {
      break;
    }
    const byOrganization = Map.groupBy(
      signing,
      (signingSession) => signingSession.organizationId,
    );
    const organizations = [...byOrganization];
    const closeNextOrganization = async (index: number): Promise<number> => {
      const next = organizations.at(index);
      if (next === undefined) {
        return 0;
      }
      const [, organizationSessions] = next;
      // Signing sessions force row security and give the table owner no
      // UPDATE policy, so a row lock taken in the caller's context can see
      // nothing and silently skip every session. Prove the organization from
      // the sessions' matters, then lock and close inside that scope.
      const proof = await proveMattersOrgScope(
        tx,
        organizationSessions.map((session) => session.workspaceId),
      );
      if (proof.isErr()) {
        abortTransaction(removalBusy());
      }
      const organizationScope = proof.value;
      assertAssignmentScope(organizationScope, scope);
      const closed: {
        session: (typeof organizationSessions)[number];
        auditEvents: Parameters<AuditRecorder>[1][];
      }[] = [];
      const heldCount = await withOrgScope({
        tx,
        scope: organizationScope,
        actor: { type: "system" },
        fn: async (scopedTx) => {
          const held = await lockOpenSigningPage({
            tx: scopedTx,
            sessions: organizationSessions,
          });
          await mapWithConcurrency({
            items: held,
            limit: 1,
            operation: async (session) => {
              const auditEvents: Parameters<AuditRecorder>[1][] = [];
              const bufferAudit = bufferAuditEvents(auditEvents);
              const changed = await transitionBatch({
                tx: scopedTx,
                spec: TRANSITIONS.pdfSigningSessions,
                ids: [session.id],
                options: {
                  from: ["open"],
                  to: "cancelled",
                  set: {
                    closeReason: "expired",
                    closedAt: now,
                    handoffExpiresAt: now,
                    tokenExpiresAt: now,
                  },
                },
                recordTransitionAuditEvent: async (auditTx, rows) =>
                  await recordMemberSessionTransitions({
                    tx: auditTx,
                    actorUserId,
                    resourceType: AUDIT_RESOURCE_TYPE.PDF_SIGNING_SESSION,
                    rows: rows.map(() => ({
                      ...session,
                      organizationId: organizationScope.organizationId,
                    })),
                    recordAuditEvent: bufferAudit,
                  }),
              });
              if (changed.length !== 1) {
                panic("Locked signing sessions changed during member removal");
              }
              closed.push({ session, auditEvents });
            },
          });
          return held.length;
        },
      });
      if (closed.length !== heldCount) {
        panic("Locked signing sessions changed during member removal");
      }
      for (const { session, auditEvents } of closed) {
        const recordMemberTransitionAuditEvent =
          recordAuditEvent ??
          createBackgroundAuditRecorder({
            organizationId: organizationScope.organizationId,
            workspaceId: session.workspaceId,
            userId: actorUserId,
            execution: {
              performer: { type: "user", id: actorUserId },
              trigger: { type: "system", source: "membership_removal" },
            },
          });
        for (const events of auditEvents) {
          // db-await-in-loop: replay exact transition events after the scoped role restores.
          await recordMemberTransitionAuditEvent(tx, events);
        }
      }
      return closed.length + (await closeNextOrganization(index + 1));
    };
    // db-await-in-loop: bounded signing pages must lock, transition and audit in organization/session order before the next page.
    await closeNextOrganization(0);
  }
};

const closeMemberExchanges = async (options: ClearMemberAssignmentsOptions) => {
  await clearMemberTakeovers(options);
  await expireMemberHandoffs(options);
  await cancelMemberSigningSessions(options);
};

const clearMemberContactAssignments = async ({
  tx,
  scope,
  userId,
  actorUserId,
}: ClearMemberAssignmentsOptions) => {
  if (scope.type === "workspace") {
    return;
  }
  const contactScope =
    scope.type === "organization"
      ? eq(contacts.organizationId, scope.organizationId)
      : undefined;
  const attorneyScope = and(
    contactScope,
    or(
      eq(contacts.originatingAttorneyId, userId),
      eq(contacts.responsibleAttorneyId, userId),
    ),
  );
  const rowCount = await tx.$count(contacts, attorneyScope);
  for (
    let remaining = rowCount;
    remaining > 0;
    remaining -= LIMITS.memberRemovalCleanupBatchSize
  ) {
    // Matter creation already locks its client before organization membership.
    // Refuse writer contention instead of introducing the opposite waiting order.
    // Attorney updates preserve contact keys, so projection FK checks can retain
    // KEY SHARE while cleanup takes NO KEY UPDATE without waiting.
    const contactResult = await Result.tryPromise({
      try: async () =>
        // db-await-in-loop: drain attorney references in bounded audited batches.
        await tx
          .select({
            id: contacts.id,
            organizationId: contacts.organizationId,
            originatingAttorneyId: contacts.originatingAttorneyId,
            responsibleAttorneyId: contacts.responsibleAttorneyId,
          })
          .from(contacts)
          .where(attorneyScope)
          .orderBy(contacts.id)
          // Locked drains process exactly this batch; no unprocessed sentinel may acquire a lock.
          .limit(Math.min(remaining, LIMITS.memberRemovalCleanupBatchSize))
          .for("no key update", { noWait: true }),
      catch: (error) => error,
    });
    if (Result.isError(contactResult)) {
      abortTransaction(
        isPgError(contactResult.error, PG_ERROR.LOCK_NOT_AVAILABLE)
          ? removalBusy()
          : contactResult.error,
      );
    }
    const contactRows = contactResult.value;
    if (contactRows.length === 0) {
      break;
    }
    await mapWithConcurrency({
      items: contactRows,
      limit: 1,
      operation: async (row) => {
        const proof = await proveOrgScope(tx, {
          table: "contacts",
          where: sql`${and(
            eq(contacts.id, row.id),
            eq(contacts.organizationId, row.organizationId),
            or(
              eq(contacts.originatingAttorneyId, userId),
              eq(contacts.responsibleAttorneyId, userId),
            ),
          )}`,
        });
        if (proof.isErr()) {
          abortTransaction(removalBusy());
        }
        assertAssignmentScope(proof.value, scope);
        await withOrgScope({
          tx,
          scope: proof.value,
          actor: { type: "system" },
          fn: async (scopedTx) => {
            await scopedTx
              .update(contacts)
              .set({
                originatingAttorneyId: sql`CASE WHEN ${contacts.originatingAttorneyId} = ${userId} THEN NULL ELSE ${contacts.originatingAttorneyId} END`,
                responsibleAttorneyId: sql`CASE WHEN ${contacts.responsibleAttorneyId} = ${userId} THEN NULL ELSE ${contacts.responsibleAttorneyId} END`,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(contacts.id, row.id),
                  eq(contacts.organizationId, proof.value.organizationId),
                ),
              );
            await enqueueContactSearchRepairs(scopedTx, [row.id]);
          },
        });
        await recordAuditGroups({
          tx,
          groups: [
            {
              bindings: {
                organizationId: proof.value.organizationId,
                workspaceId: null,
                userId: actorUserId,
                execution: {
                  performer: { type: "user", id: actorUserId },
                  trigger: { type: "system", source: "membership_removal" },
                },
              },
              events: [
                {
                  action: AUDIT_ACTION.UPDATE,
                  resourceType: AUDIT_RESOURCE_TYPE.CONTACT,
                  resourceId: row.id,
                  workspaceId: null,
                  changes: {
                    ...(row.originatingAttorneyId === userId
                      ? { originatingAttorneyId: { old: userId, new: null } }
                      : {}),
                    ...(row.responsibleAttorneyId === userId
                      ? { responsibleAttorneyId: { old: userId, new: null } }
                      : {}),
                  },
                  metadata: { cause: "membership_removed" },
                },
              ],
            },
          ],
        });
      },
    });
  }
};

const timeEntryApprovalScope = (tx: Transaction, scope: AssignmentScope) => {
  if (scope.type === "workspace") {
    return eq(timeEntries.workspaceId, scope.workspaceId);
  }
  if (scope.type === "organization") {
    return eq(timeEntries.organizationId, scope.organizationId);
  }
  // Account erasure clears every pending approval naming the user, including
  // ones in organizations the user already left. Probing the approval-queue
  // index once per organization keeps the read off a time-entry scan.
  return inArray(
    timeEntries.organizationId,
    tx.select({ id: organization.id }).from(organization),
  );
};

/**
 * Pending entries return to the approver pool. Approval locks an entry before
 * its matter, the reverse of offboarding, so a held entry is a typed busy
 * refusal instead of a wait.
 */
const clearMemberTimeEntryApprovals = async ({
  tx,
  scope,
  userId,
  actorUserId,
  recordAuditEvent,
}: ClearMemberAssignmentsOptions) => {
  const approvalScope = and(
    timeEntryApprovalScope(tx, scope),
    eq(timeEntries.approverUserId, userId),
    eq(timeEntries.status, BILLING_STATUS.DRAFT),
  );
  const rowCount = await tx.$count(timeEntries, approvalScope);
  for (
    let remaining = rowCount;
    remaining > 0;
    remaining -= LIMITS.memberRemovalCleanupBatchSize
  ) {
    const pending = await Result.tryPromise({
      try: async () =>
        // db-await-in-loop: drain pending approvals in bounded audited batches.
        await tx
          .select({
            id: timeEntries.id,
            organizationId: timeEntries.organizationId,
            workspaceId: timeEntries.workspaceId,
          })
          .from(timeEntries)
          .where(approvalScope)
          .orderBy(timeEntries.id)
          // Locked drains process exactly this batch; no unprocessed sentinel may acquire a lock.
          .limit(Math.min(remaining, LIMITS.memberRemovalCleanupBatchSize))
          .for("update", { noWait: true }),
      catch: (error) => error,
    });
    if (Result.isError(pending)) {
      abortTransaction(
        isPgError(pending.error, PG_ERROR.LOCK_NOT_AVAILABLE)
          ? removalBusy()
          : pending.error,
      );
    }
    const rows = pending.value;
    if (rows.length === 0) {
      break;
    }
    await mapWithConcurrency({
      items: rows,
      limit: 1,
      operation: async (row) => {
        const proof = await proveOrgScope(tx, {
          table: "timeEntries",
          where: sql`${and(
            eq(timeEntries.id, row.id),
            eq(timeEntries.organizationId, row.organizationId),
            eq(timeEntries.approverUserId, userId),
            eq(timeEntries.status, BILLING_STATUS.DRAFT),
          )}`,
        });
        if (proof.isErr()) {
          abortTransaction(removalBusy());
        }
        assertAssignmentScope(proof.value, scope);
        await withOrgScope({
          tx,
          scope: proof.value,
          actor: { type: "system" },
          fn: async (scopedTx) => {
            await scopedTx
              .update(timeEntries)
              .set({ approverUserId: null, updatedAt: new Date() })
              .where(
                and(
                  eq(timeEntries.id, row.id),
                  eq(timeEntries.organizationId, proof.value.organizationId),
                  eq(timeEntries.approverUserId, userId),
                  eq(timeEntries.status, BILLING_STATUS.DRAFT),
                ),
              );
          },
        });
        await recordAuditGroups({
          tx,
          recordAuditEvent,
          groups: [
            {
              bindings: {
                organizationId: proof.value.organizationId,
                workspaceId: null,
                userId: actorUserId,
                execution: {
                  performer: { type: "user" as const, id: actorUserId },
                  trigger: {
                    type: "system" as const,
                    source: "membership_removal",
                  },
                },
              },
              events: [
                {
                  action: AUDIT_ACTION.UPDATE,
                  resourceType: AUDIT_RESOURCE_TYPE.TIME_ENTRY,
                  resourceId: row.id,
                  workspaceId: row.workspaceId,
                  changes: { approverUserId: { old: userId, new: null } },
                  metadata: { cause: "membership_removed" },
                },
              ],
            },
          ],
        });
      },
    });
  }
};

/** Caller holds the departing memberships until cleanup and deletion commit. */
export const clearMemberAssignments = async (
  options: ClearMemberAssignmentsOptions,
): Promise<void> => {
  if (options.reassignTo === options.userId) {
    abortTransaction(
      new HandlerError({
        status: 400,
        message: "User is not a member of this workspace",
      }),
    );
  }
  await lockScopeFeatureAdmission(options);
  await clearMemberObligationOwners(options);
  await clearMemberTaskAssignments(options);
  await clearMemberTimeEntryApprovals(options);
  await closeMemberExchanges(options);
  await clearMemberContactAssignments(options);
};

type MemberCleanupWorkspaceOptions = {
  tx: Transaction;
  userId: SafeId<"user">;
  /** Absent for account erasure, which spans every organization. */
  organizationId?: SafeId<"organization">;
  /** The per-organization matter cap; tests lower it to reach the bound. */
  workspacesPerOrganization?: number;
};

/**
 * Every matter in which removal changes a row of this user: memberships,
 * assignments, owned obligations, lead, pending approvals, runs they started
 * or authored, and their open exchanges. Removal locks exactly these matters,
 * so unrelated matters of the organization keep accepting writes.
 */
const selectMemberCleanupWorkspaceIds = async ({
  tx,
  userId,
  organizationId,
  workspacesPerOrganization = LIMITS.workspacesCount,
}: MemberCleanupWorkspaceOptions): Promise<SafeId<"workspace">[]> => {
  const organizationWorkspaces = organizationId
    ? tx
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.organizationId, organizationId))
    : undefined;
  const inOrganization = (
    column:
      | typeof workspaceMembers.workspaceId
      | typeof taskAssignees.workspaceId
      | typeof workObligations.workspaceId
      | typeof flowRuns.workspaceId
      | typeof desktopEditSessions.workspaceId
      | typeof desktopEditHandoffs.workspaceId
      | typeof pdfSigningSessions.workspaceId,
  ) =>
    organizationWorkspaces
      ? inArray(column, organizationWorkspaces)
      : undefined;
  const now = new Date();
  const sources = [
    () =>
      tx
        .select({ id: workspaceMembers.workspaceId })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.userId, userId),
            inOrganization(workspaceMembers.workspaceId),
          ),
        ),
    () =>
      tx
        .selectDistinct({ id: taskAssignees.workspaceId })
        .from(taskAssignees)
        .where(
          and(
            eq(taskAssignees.userId, userId),
            inOrganization(taskAssignees.workspaceId),
          ),
        ),
    () =>
      tx
        .selectDistinct({ id: workObligations.workspaceId })
        .from(workObligations)
        .where(
          and(
            eq(workObligations.ownerUserId, userId),
            inArray(workObligations.status, [
              WORK_OBLIGATION_STATUS.ACTIVE,
              WORK_OBLIGATION_STATUS.AWAITING_ACKNOWLEDGEMENT,
            ]),
            inOrganization(workObligations.workspaceId),
          ),
        ),
    () =>
      tx
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(
          and(
            eq(workspaces.leadUserId, userId),
            organizationId
              ? eq(workspaces.organizationId, organizationId)
              : undefined,
          ),
        ),
    () =>
      tx
        .selectDistinct({ id: timeEntries.workspaceId })
        .from(timeEntries)
        .where(
          and(
            organizationId
              ? eq(timeEntries.organizationId, organizationId)
              : undefined,
            eq(timeEntries.approverUserId, userId),
            eq(timeEntries.status, BILLING_STATUS.DRAFT),
            isNotNull(timeEntries.workspaceId),
          ),
        ),
    // The running timer offboarding closes locks its matter too.
    () =>
      tx
        .selectDistinct({ id: timeEntries.workspaceId })
        .from(timeEntries)
        .where(
          and(
            organizationId
              ? eq(timeEntries.organizationId, organizationId)
              : undefined,
            eq(timeEntries.userId, userId),
            isNotNull(timeEntries.timerStartedAt),
            isNull(timeEntries.timerStoppedAt),
            isNotNull(timeEntries.workspaceId),
          ),
        ),
    () =>
      tx
        .selectDistinct({ id: flowRuns.workspaceId })
        .from(flowRuns)
        .innerJoin(workspaces, eq(workspaces.id, flowRuns.workspaceId))
        .leftJoin(
          flowDefinitions,
          and(
            eq(flowDefinitions.id, flowRuns.definitionId),
            eq(flowDefinitions.organizationId, workspaces.organizationId),
          ),
        )
        .where(
          and(
            inOrganization(flowRuns.workspaceId),
            inArray(flowRuns.status, ["pending", "running", "awaiting_review"]),
            or(
              sql`${flowRuns.triggerSource}->>'userId' = ${userId}`,
              and(
                sql`${flowRuns.triggerSource}->>'type' <> 'manual'`,
                eq(flowDefinitions.createdByUserId, userId),
              ),
            ),
          ),
        ),
    () =>
      tx
        .selectDistinct({ id: desktopEditSessions.workspaceId })
        .from(desktopEditSessions)
        .where(
          and(
            or(
              eq(desktopEditSessions.createdBy, userId),
              eq(desktopEditSessions.takeoverRequestedBy, userId),
            ),
            eq(desktopEditSessions.status, "open"),
            inOrganization(desktopEditSessions.workspaceId),
          ),
        ),
    () =>
      tx
        .selectDistinct({ id: desktopEditHandoffs.workspaceId })
        .from(desktopEditHandoffs)
        .where(
          and(
            eq(desktopEditHandoffs.createdBy, userId),
            sql`${desktopEditHandoffs.expiresAt} > ${now}`,
            inOrganization(desktopEditHandoffs.workspaceId),
          ),
        ),
    () =>
      tx
        .selectDistinct({ id: pdfSigningSessions.workspaceId })
        .from(pdfSigningSessions)
        .where(
          and(
            eq(pdfSigningSessions.createdBy, userId),
            eq(pdfSigningSessions.status, "open"),
            inOrganization(pdfSigningSessions.workspaceId),
          ),
        ),
  ];
  // Every organization holds at most its matter cap, so the bound is that cap
  // once per organization whose matters this cleanup changes: one for
  // organization removal, every such organization (current or already left)
  // for account erasure.
  const affectedWorkspaceIds = sql`(${sql.join(
    sources.map((source) => source().getSQL()),
    sql` UNION `,
  )})`;
  const affectedWorkspaces = inArray(workspaces.id, affectedWorkspaceIds);
  const organizationCount = organizationId
    ? 1
    : await tx.$count(
        organization,
        inArray(
          organization.id,
          tx
            .selectDistinct({ id: workspaces.organizationId })
            .from(workspaces)
            .where(affectedWorkspaces),
        ),
      );
  const bound = workspacesPerOrganization * Math.max(organizationCount, 1);
  const rows = await tx
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(affectedWorkspaces)
    .orderBy(workspaces.id)
    .limit(bound + 1);
  const ids = new Set(rows.map(({ id }) => id));
  if (ids.size > bound) {
    abortTransaction(
      new HandlerError({
        status: 400,
        message: "Workspaces limit reached",
      }),
    );
  }
  return [...ids].toSorted();
};

/**
 * Account erasure holds the user's organization memberships first, as it
 * always has, then every matter it changes without waiting: organization
 * removal and grants take a matter before a membership, so a busy matter is a
 * typed retryable refusal rather than an inverted wait. Re-entrant: a caller
 * that already holds the prefix takes nothing new.
 */
type AccountMemberCleanupOptions = Pick<
  MemberCleanupWorkspaceOptions,
  "tx" | "userId" | "workspacesPerOrganization"
>;

export const tryLockAccountMemberCleanup = async ({
  tx,
  userId,
  workspacesPerOrganization = LIMITS.workspacesCount,
}: AccountMemberCleanupOptions): Promise<void> => {
  await tx
    .select({ id: member.id })
    .from(member)
    .where(eq(member.userId, userId))
    .for("update");
  await tryLockAccountFeatureAdmission(tx, userId);
  for (const id of await selectMemberCleanupWorkspaceIds({
    tx,
    userId,
    workspacesPerOrganization,
  })) {
    // db-await-in-loop: try each affected matter in ascending id order.
    await tryLockMemberCleanupWorkspace(tx, id);
  }
  // Delegation locks a requested matter membership before its obligation.
  // Holding the departing memberships first makes a concurrent delegation
  // either land before cleanup or observe the deletion.
  await tx
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, userId))
    .for("update");
};

/**
 * Timer-owner/user locks precede these matter locks, just as in timer writes.
 * Only the matters removal changes are locked, in ascending id order.
 */
const lockMemberCleanupWorkspaces = async (
  options: MemberCleanupWorkspaceOptions,
) => {
  const ids = await selectMemberCleanupWorkspaceIds(options);
  for (const id of ids) {
    // db-await-in-loop: acquire workspace advisory and row locks in ascending id order.
    await options.tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${id}))`,
    );
    // db-await-in-loop: workspace precedes all workflow/member/obligation/entity rows.
    await options.tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, id))
      .for("update");
  }
  return ids;
};

type RemoveOrganizationMemberOptions = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  memberId: string;
  userId: SafeId<"user">;
  actorUserId: SafeId<"user">;
  reassignTo?: SafeId<"user"> | undefined;
};

type CancelScopedMemberFlowRunBatchOptions = {
  tx: Transaction;
  actorUserId: SafeId<"user">;
  scopedRuns: readonly {
    run: Pick<typeof flowRuns.$inferSelect, "id" | "workspaceId" | "status">;
    scope: OrgScope;
  }[];
};

const cancelScopedMemberFlowRunBatch = async ({
  tx,
  actorUserId,
  scopedRuns,
}: CancelScopedMemberFlowRunBatchOptions) => {
  const runIds = scopedRuns.map(({ run }) => run.id);
  const steps = await tx
    .select({
      id: flowRunSteps.id,
      runId: flowRunSteps.runId,
      status: flowRunSteps.status,
    })
    .from(flowRunSteps)
    .where(inArray(flowRunSteps.runId, runIds))
    .orderBy(flowRunSteps.runId, flowRunSteps.index)
    .limit(runIds.length * MAX_FLOW_STEPS)
    .for("update");
  const recordAuditEvent = createBackgroundAuditRecorder({
    organizationId:
      scopedRuns.at(0)?.scope.organizationId ??
      panic("Locked run batch requires its scope"),
    workspaceId: null,
    userId: actorUserId,
    execution: {
      performer: { type: "user", id: actorUserId },
      trigger: { type: "system", source: "membership_removal" },
    },
  });
  const activeSteps = steps.filter(
    ({ status }) =>
      status === "pending" ||
      status === "running" ||
      status === "awaiting_review",
  );
  const changedCounts = await mapWithConcurrency({
    items: scopedRuns,
    limit: 1,
    operation: async ({ run: lockedRun, scope }) => {
      const auditEvents: Parameters<AuditRecorder>[1][] = [];
      const bufferAuditEvent = bufferAuditEvents(auditEvents);
      const changedCount = await withOrgScope({
        tx,
        scope,
        actor: { type: "system" },
        fn: async (scopedTx) => {
          const ownedSteps = activeSteps.filter(
            ({ runId }) => runId === lockedRun.id,
          );
          const changed = await transitionBatch({
            tx: scopedTx,
            spec: FLOW_RUN_TRANSITIONS_V1,
            ids: [lockedRun.id],
            options: {
              from: ["pending", "running", "awaiting_review"],
              to: "cancelled",
              set: { finishedAt: new Date() },
            },
            recordTransitionAuditEvent: async (auditTx, rows) => {
              const changedIds = new Set(rows.map(({ id }) => id));
              const changedRuns = [lockedRun].filter(({ id }) =>
                changedIds.has(id),
              );
              const changedSteps = await transitionBatch({
                tx: auditTx,
                spec: TRANSITIONS.flowRunSteps,
                ids: ownedSteps
                  .filter(({ runId }) => changedIds.has(runId))
                  .map(({ id }) => id),
                options: {
                  from: ["pending", "running", "awaiting_review"],
                  to: "skipped",
                  set: { finishedAt: new Date() },
                },
                recordTransitionAuditEvent: async (stepTx, stepRows) => {
                  const stepIds = new Set(stepRows.map(({ id }) => id));
                  const runById = new Map(
                    changedRuns.map((run) => [run.id, run]),
                  );
                  await bufferAuditEvent(
                    stepTx,
                    ownedSteps
                      .filter(({ id }) => stepIds.has(id))
                      .map((step) => {
                        const run = runById.get(step.runId);
                        if (run === undefined) {
                          panic(
                            "A transitioned step must belong to a held run",
                          );
                        }
                        return {
                          action: AUDIT_ACTION.UPDATE,
                          resourceType: AUDIT_RESOURCE_TYPE.FLOW_RUN,
                          resourceId: run.id,
                          workspaceId: run.workspaceId,
                          changes: {
                            stepStatus: {
                              old: step.status,
                              new: "skipped",
                            },
                          },
                          metadata: {
                            cause: "membership_removed",
                            stepId: step.id,
                          },
                        };
                      }),
                  );
                },
              });
              if (changedSteps.length !== ownedSteps.length) {
                panic("Locked flow steps changed during member removal");
              }
              await bufferAuditEvent(
                auditTx,
                changedRuns.map((run) => ({
                  action: AUDIT_ACTION.UPDATE,
                  resourceType: AUDIT_RESOURCE_TYPE.FLOW_RUN,
                  resourceId: run.id,
                  workspaceId: run.workspaceId,
                  changes: {
                    status: { old: run.status, new: "cancelled" },
                  },
                  metadata: { cause: "membership_removed" },
                })),
              );
            },
          });
          if (changed.length !== 1) {
            panic("Locked flow run changed during member removal");
          }
          return changed.length;
        },
      });
      for (const events of auditEvents) {
        // db-await-in-loop: replay the exact transition events after the scoped role restores.
        await recordAuditEvent(tx, events);
      }
      return changedCount;
    },
  });
  if (
    changedCounts.reduce((count, value) => count + value, 0) !==
    scopedRuns.length
  ) {
    panic("Locked flow runs changed during member removal");
  }
};

const cancelMemberFlowRuns = async ({
  tx,
  organizationId,
  userId,
  actorUserId,
}: RemoveOrganizationMemberOptions) => {
  // Workspace locks precede run, step, obligation and entity cleanup.
  const affectedWorkspaceIds = tx
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.organizationId, organizationId));
  const runScope = and(
    inArray(flowRuns.workspaceId, affectedWorkspaceIds),
    inArray(flowRuns.status, ["pending", "running", "awaiting_review"]),
    or(
      sql`${flowRuns.triggerSource}->>'userId' = ${userId}`,
      and(
        sql`${flowRuns.triggerSource}->>'type' <> 'manual'`,
        eq(flowDefinitions.createdByUserId, userId),
      ),
    ),
  );
  const pendingRuns = tx
    .select({ id: flowRuns.id })
    .from(flowRuns)
    .leftJoin(
      flowDefinitions,
      and(
        eq(flowDefinitions.id, flowRuns.definitionId),
        eq(flowDefinitions.organizationId, organizationId),
      ),
    )
    .where(runScope);
  const rowCount = await tx.$count(pendingRuns.as("pending_runs"));
  for (
    let remaining = rowCount;
    remaining > 0;
    remaining -= LIMITS.memberRemovalCleanupBatchSize
  ) {
    // db-await-in-loop: cancel bounded run batches while holding the workspace prefix.
    const runs = await tx
      .select({
        id: flowRuns.id,
        workspaceId: flowRuns.workspaceId,
        status: flowRuns.status,
      })
      .from(flowRuns)
      .leftJoin(
        flowDefinitions,
        and(
          eq(flowDefinitions.id, flowRuns.definitionId),
          eq(flowDefinitions.organizationId, organizationId),
        ),
      )
      .where(runScope)
      .orderBy(flowRuns.id)
      // Locked drains process exactly this batch; no unprocessed sentinel may acquire a lock.
      .limit(Math.min(remaining, LIMITS.memberRemovalCleanupBatchSize))
      .for("update", { of: flowRuns });
    if (runs.length === 0) {
      break;
    }
    if (runs.length > 0) {
      const scopedRuns = await mapWithConcurrency({
        items: runs,
        limit: 1,
        operation: async (run) => {
          const proof = await proveOrgScope(tx, {
            table: "flowRuns",
            where: sql`${and(
              eq(flowRuns.id, run.id),
              eq(flowRuns.workspaceId, run.workspaceId),
              eq(flowRuns.status, run.status),
              inArray(flowRuns.workspaceId, affectedWorkspaceIds),
            )}`,
          });
          if (proof.isErr()) {
            return panic("Locked flow run requires its organization scope");
          }
          if (assertCallerOrg(proof.value, organizationId).isErr()) {
            abortTransaction(removalBusy());
          }
          return { run, scope: proof.value };
        },
      });
      await cancelScopedMemberFlowRunBatch({ tx, actorUserId, scopedRuns });
    }
  }
};

type LockOrganizationCleanupWorkspacesOptions = Pick<
  RemoveOrganizationMemberOptions,
  "tx" | "organizationId" | "userId" | "reassignTo"
>;

const lockOrganizationCleanupWorkspaces = async ({
  tx,
  organizationId,
  userId,
  reassignTo,
}: LockOrganizationCleanupWorkspacesOptions) => {
  const locked = await lockMemberCleanupWorkspaces({
    tx,
    userId,
    organizationId,
  });
  // Existing promotion takes workspace -> organization membership.
  await tx
    .select({ id: member.id })
    .from(member)
    .where(
      and(
        eq(member.organizationId, organizationId),
        inArray(member.userId, reassignTo ? [userId, reassignTo] : [userId]),
      ),
    )
    .orderBy(member.userId)
    .limit(reassignTo ? 2 : 1)
    .for("update");
  // A grant that held its matter before this membership lock may have
  // committed meanwhile; the held membership refuses every later one.
  const current = (
    await selectMemberCleanupWorkspaceIds({
      tx,
      userId,
      organizationId,
    })
  ).map((id) => ({ id }));
  const lockedIds = new Set(locked);
  for (const { id } of current) {
    if (lockedIds.has(id)) {
      continue;
    }
    // db-await-in-loop: newly affected matters cannot invert held membership locks.
    await tryLockMemberCleanupWorkspace(tx, id);
  }
  if (current.length > 0) {
    await tx
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(
        and(
          inArray(
            workspaceMembers.workspaceId,
            current.map(({ id }) => id),
          ),
          inArray(
            workspaceMembers.userId,
            reassignTo ? [userId, reassignTo] : [userId],
          ),
        ),
      )
      .orderBy(workspaceMembers.workspaceId, workspaceMembers.userId)
      .limit(current.length * (reassignTo ? 2 : 1))
      .for("update");
  }
};

type CancelMemberDesktopSessionsOptions = Pick<
  RemoveOrganizationMemberOptions,
  "tx" | "organizationId" | "userId" | "actorUserId"
>;

const cancelMemberDesktopSessions = async ({
  tx,
  organizationId,
  userId,
  actorUserId,
}: CancelMemberDesktopSessionsOptions) => {
  const affectedWorkspaceIds = tx
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.organizationId, organizationId));
  const desktopScope = and(
    inArray(desktopEditSessions.workspaceId, affectedWorkspaceIds),
    eq(desktopEditSessions.createdBy, userId),
    eq(desktopEditSessions.status, "open"),
  );
  const desktopCount = await tx.$count(desktopEditSessions, desktopScope);
  for (
    let remaining = desktopCount;
    remaining > 0;
    remaining -= LIMITS.memberRemovalCleanupBatchSize
  ) {
    // db-await-in-loop: lock a bounded desktop session page after assignment cleanup.
    const sessions = await tx
      .select({
        id: desktopEditSessions.id,
        workspaceId: desktopEditSessions.workspaceId,
      })
      .from(desktopEditSessions)
      .where(desktopScope)
      .orderBy(desktopEditSessions.id)
      // Locked drains process exactly this batch; no unprocessed sentinel may acquire a lock.
      .limit(Math.min(remaining, LIMITS.memberRemovalCleanupBatchSize))
      .for("update");
    if (sessions.length === 0) {
      break;
    }
    // db-await-in-loop: transition and audit the held desktop page before consuming the next counted batch.
    const changedCounts = await mapWithConcurrency({
      items: sessions,
      limit: 1,
      operation: async (session) => {
        const proof = await proveOrgScope(tx, {
          table: "desktopEditSessions",
          where: sql`${and(
            eq(desktopEditSessions.id, session.id),
            eq(desktopEditSessions.workspaceId, session.workspaceId),
            eq(desktopEditSessions.createdBy, userId),
            eq(desktopEditSessions.status, "open"),
          )}`,
        });
        if (proof.isErr()) {
          abortTransaction(removalBusy());
        }
        if (assertCallerOrg(proof.value, organizationId).isErr()) {
          abortTransaction(removalBusy());
        }
        const auditEvents: Parameters<AuditRecorder>[1][] = [];
        const bufferAudit = bufferAuditEvents(auditEvents);
        const changed = await withOrgScope({
          tx,
          scope: proof.value,
          actor: { type: "system" },
          fn: async (scopedTx) =>
            await transitionBatch({
              tx: scopedTx,
              spec: TRANSITIONS.desktopEditSessions,
              ids: [session.id],
              options: {
                from: ["open"],
                to: "cancelled",
                set: { closedAt: new Date() },
              },
              recordTransitionAuditEvent: async (auditTx, rows) =>
                await recordMemberSessionTransitions({
                  tx: auditTx,
                  actorUserId,
                  resourceType: AUDIT_RESOURCE_TYPE.DESKTOP_EDIT_SESSION,
                  rows: rows.map(() => ({
                    ...session,
                    organizationId: proof.value.organizationId,
                  })),
                  recordAuditEvent: bufferAudit,
                }),
            }),
        });
        if (changed.length !== 1) {
          panic("Locked desktop sessions changed during member removal");
        }
        const recordMemberTransitionAuditEvent = createBackgroundAuditRecorder({
          organizationId: proof.value.organizationId,
          workspaceId: session.workspaceId,
          userId: actorUserId,
          execution: {
            performer: { type: "user", id: actorUserId },
            trigger: { type: "system", source: "membership_removal" },
          },
        });
        for (const events of auditEvents) {
          // db-await-in-loop: replay exact transition events after the scoped role restores.
          await recordMemberTransitionAuditEvent(tx, events);
        }
        return changed.length;
      },
    });
    if (
      changedCounts.reduce((count, value) => count + value, 0) !==
      sessions.length
    ) {
      panic("Locked desktop sessions changed during member removal");
    }
  }
};

type ClearMemberPresenceOptions = Pick<
  RemoveOrganizationMemberOptions,
  "tx" | "organizationId" | "userId" | "memberId"
> & { recordAuditEvent: AuditRecorder };

const clearMemberPresence = async ({
  tx,
  organizationId,
  userId,
  memberId,
  recordAuditEvent,
}: ClearMemberPresenceOptions) => {
  const scope = await proveOrgScope(tx, {
    table: "member",
    where: sql`${and(eq(member.id, memberId), eq(member.organizationId, organizationId), eq(member.userId, userId))}`,
  });
  if (scope.isErr() || assertCallerOrg(scope.value, organizationId).isErr()) {
    abortTransaction(removalBusy());
  }
  await withOrgScope({
    tx,
    scope: scope.value,
    actor: { type: "actor", userId },
    fn: async (scopedTx) => {
      await scopedTx
        .delete(desktopPresence)
        .where(
          and(
            eq(desktopPresence.organizationId, scope.value.organizationId),
            eq(desktopPresence.userId, userId),
          ),
        );
    },
  });
  await recordAuditEvent(tx, {
    action: AUDIT_ACTION.UPDATE,
    resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
    resourceId: organizationId,
    metadata: { change: "member-presence-cleared", memberId, userId },
  });
};

type ProvenMemberCleanupOptions = {
  tx: Transaction;
  scope: OrgScope;
  userId: SafeId<"user">;
  recordAuditEvent: AuditRecorder;
};

const clearRemovedMemberMatterLeads = async ({
  tx,
  scope,
  userId,
  recordAuditEvent,
}: ProvenMemberCleanupOptions) => {
  const removePage = async (cursor: string | undefined): Promise<void> => {
    const page = await readCursorPage(
      tx
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(
          and(
            cursor === undefined
              ? undefined
              : sql`${workspaces.id} > ${cursor}`,
            eq(workspaces.organizationId, scope.organizationId),
            eq(workspaces.leadUserId, userId),
          ),
        )
        .orderBy(workspaces.id),
      {
        limit: LIMITS.memberRemovalCleanupBatchSize,
        cursorForItem: (row) => row.id,
      },
    );
    await mapWithConcurrency({
      items: page.items,
      limit: 1,
      operation: async (matter) => {
        const proof = await proveOrgScope(tx, {
          table: "workspaces",
          where: sql`${and(
            eq(workspaces.id, matter.id),
            eq(workspaces.organizationId, scope.organizationId),
            eq(workspaces.leadUserId, userId),
          )}`,
        });
        if (proof.isErr()) {
          abortTransaction(removalBusy());
        }
        if (assertCallerOrg(proof.value, scope.organizationId).isErr()) {
          abortTransaction(removalBusy());
        }
        await withOrgScope({
          tx,
          scope: proof.value,
          actor: { type: "system" },
          fn: async (scopedTx) => {
            await scopedTx
              .update(workspaces)
              .set({ leadUserId: null })
              .where(
                and(
                  eq(workspaces.id, matter.id),
                  eq(workspaces.organizationId, proof.value.organizationId),
                  eq(workspaces.leadUserId, userId),
                ),
              );
          },
        });
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.WORKSPACE,
          resourceId: matter.id,
          workspaceId: matter.id,
          changes: { leadUserId: { old: userId, new: null } },
          metadata: {
            change: "member-lead-cleared",
            userId,
            cause: "membership_removed",
          },
        });
      },
    });
    if (page.nextCursor !== null) {
      await removePage(page.nextCursor);
    }
  };
  await removePage(undefined);
};

const removeDepartingMemberMatterMemberships = async ({
  tx,
  scope,
  userId,
  recordAuditEvent,
}: ProvenMemberCleanupOptions) => {
  const removePage = async (cursor: string | undefined): Promise<void> => {
    const page = await readCursorPage(
      tx
        .select({
          id: workspaceMembers.id,
          workspaceId: workspaceMembers.workspaceId,
        })
        .from(workspaceMembers)
        .where(
          and(
            cursor === undefined
              ? undefined
              : sql`${workspaceMembers.id} > ${cursor}`,
            eq(workspaceMembers.userId, userId),
            inArray(
              workspaceMembers.workspaceId,
              tx
                .select({ id: workspaces.id })
                .from(workspaces)
                .where(eq(workspaces.organizationId, scope.organizationId)),
            ),
          ),
        )
        .orderBy(workspaceMembers.id),
      {
        limit: LIMITS.memberRemovalCleanupBatchSize,
        cursorForItem: (row) => row.id,
      },
    );
    await mapWithConcurrency({
      items: page.items,
      limit: 1,
      operation: async (membership) => {
        const proof = await proveOrgScope(tx, {
          table: "workspaceMembers",
          where: sql`${and(
            eq(workspaceMembers.id, membership.id),
            eq(workspaceMembers.workspaceId, membership.workspaceId),
            eq(workspaceMembers.userId, userId),
          )}`,
        });
        if (proof.isErr()) {
          abortTransaction(removalBusy());
        }
        if (assertCallerOrg(proof.value, scope.organizationId).isErr()) {
          abortTransaction(removalBusy());
        }
        await withOrgScope({
          tx,
          scope: proof.value,
          actor: { type: "system" },
          fn: async (scopedTx) => {
            await scopedTx
              .delete(workspaceMembers)
              .where(
                and(
                  eq(workspaceMembers.id, membership.id),
                  eq(workspaceMembers.workspaceId, membership.workspaceId),
                  eq(workspaceMembers.userId, userId),
                ),
              );
          },
        });
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.DELETE,
          resourceType: AUDIT_RESOURCE_TYPE.WORKSPACE_MEMBER,
          resourceId: membership.id,
          workspaceId: membership.workspaceId,

          changes: {
            deleted: {
              old: { userId, workspaceId: membership.workspaceId },
              new: null,
            },
          },
          metadata: { cause: "membership_removed" },
        });
      },
    });
    if (page.nextCursor !== null) {
      await removePage(page.nextCursor);
    }
  };
  await removePage(undefined);
};

const removedMemberCount = (result: unknown): number =>
  v.parse(v.object({ count: v.number() }), executedRows(result).at(0)).count;

const clearRemovedMemberOrganizationState = async ({
  tx,
  scope,
  userId,
  recordAuditEvent,
}: ProvenMemberCleanupOptions) => {
  const counts = await withOrgScope({
    tx,
    scope,
    actor: { type: "system" },
    fn: async (scopedTx) => {
      const searchHistoryTombstonesCount = removedMemberCount(
        await scopedTx.execute(
          sql`WITH removed AS (${scopedTx
            .delete(searchHistoryTombstones)
            .where(
              and(
                eq(
                  searchHistoryTombstones.organizationId,
                  scope.organizationId,
                ),
                eq(searchHistoryTombstones.userId, userId),
              ),
            )
            .returning({
              changed: sql`1`,
            })
            .getSQL()}) SELECT count(*)::integer AS count FROM removed`,
        ),
      );
      const searchHistoryOwnersCount = removedMemberCount(
        await scopedTx.execute(
          sql`WITH removed AS (${scopedTx
            .delete(searchHistoryOwners)
            .where(
              and(
                eq(searchHistoryOwners.organizationId, scope.organizationId),
                eq(searchHistoryOwners.userId, userId),
              ),
            )
            .returning({
              changed: sql`1`,
            })
            .getSQL()}) SELECT count(*)::integer AS count FROM removed`,
        ),
      );
      const searchHistoryEntriesCount = removedMemberCount(
        await scopedTx.execute(
          sql`WITH removed AS (${scopedTx
            .delete(searchHistoryEntries)
            .where(
              and(
                eq(searchHistoryEntries.organizationId, scope.organizationId),
                eq(searchHistoryEntries.userId, userId),
              ),
            )
            .returning({
              changed: sql`1`,
            })
            .getSQL()}) SELECT count(*)::integer AS count FROM removed`,
        ),
      );
      const mcpUserConnectionsCount = removedMemberCount(
        await scopedTx.execute(
          sql`WITH removed AS (${scopedTx
            .delete(mcpUserConnections)
            .where(
              and(
                eq(mcpUserConnections.organizationId, scope.organizationId),
                eq(mcpUserConnections.userId, userId),
              ),
            )
            .returning({
              changed: sql`1`,
            })
            .getSQL()}) SELECT count(*)::integer AS count FROM removed`,
        ),
      );
      const sharepointConnectionsCount = removedMemberCount(
        await scopedTx.execute(
          sql`WITH removed AS (${scopedTx
            .delete(sharepointConnections)
            .where(
              and(
                eq(sharepointConnections.organizationId, scope.organizationId),
                eq(sharepointConnections.userId, userId),
              ),
            )
            .returning({
              changed: sql`1`,
            })
            .getSQL()}) SELECT count(*)::integer AS count FROM removed`,
        ),
      );
      const mcpOAuthStateCount = removedMemberCount(
        await scopedTx.execute(
          sql`WITH removed AS (${scopedTx
            .delete(mcpOAuthState)
            .where(
              and(
                eq(mcpOAuthState.organizationId, scope.organizationId),
                eq(mcpOAuthState.userId, userId),
              ),
            )
            .returning({
              changed: sql`1`,
            })
            .getSQL()}) SELECT count(*)::integer AS count FROM removed`,
        ),
      );
      const sharepointOAuthStateCount = removedMemberCount(
        await scopedTx.execute(
          sql`WITH removed AS (${scopedTx
            .delete(sharepointOAuthState)
            .where(
              and(
                eq(sharepointOAuthState.organizationId, scope.organizationId),
                eq(sharepointOAuthState.userId, userId),
              ),
            )
            .returning({
              changed: sql`1`,
            })
            .getSQL()}) SELECT count(*)::integer AS count FROM removed`,
        ),
      );
      const invitationCount = removedMemberCount(
        await scopedTx.execute(
          sql`WITH removed AS (${scopedTx
            .delete(invitation)
            .where(
              and(
                eq(invitation.organizationId, scope.organizationId),
                eq(invitation.inviterId, userId),
                eq(invitation.status, "pending"),
              ),
            )
            .returning({
              changed: sql`1`,
            })
            .getSQL()}) SELECT count(*)::integer AS count FROM removed`,
        ),
      );
      return {
        searchHistoryTombstones: searchHistoryTombstonesCount,
        searchHistoryOwners: searchHistoryOwnersCount,
        searchHistoryEntries: searchHistoryEntriesCount,
        mcpUserConnections: mcpUserConnectionsCount,
        sharepointConnections: sharepointConnectionsCount,
        mcpOAuthState: mcpOAuthStateCount,
        sharepointOAuthState: sharepointOAuthStateCount,
        invitation: invitationCount,
      };
    },
  });

  if (!Object.values(counts).some((count) => count > 0)) {
    return;
  }
  await recordAuditEvent(tx, {
    action: AUDIT_ACTION.UPDATE,
    resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
    resourceId: scope.organizationId,
    metadata: {
      change: "member-state-cleared",
      userId,
      counts,
      cause: "membership_removed",
    },
  });
};

/**
 * Better Auth's permission/owner checks precede this transactional operation.
 * The membership row, its credentials and every assignment leave in the
 * caller's one transaction.
 */
export const removeOrganizationMemberInTransaction = async (
  tx: Transaction,
  {
    organizationId,
    memberId,
    userId,
    actorUserId,
    reassignTo,
  }: Omit<RemoveOrganizationMemberOptions, "tx">,
): Promise<void> => {
  const source = (
    await tx
      .select({ organizationId: member.organizationId })
      .from(member)
      .where(
        and(
          eq(member.id, memberId),
          eq(member.organizationId, organizationId),
          eq(member.userId, userId),
        ),
      )
      .limit(1)
  ).at(0);
  if (source === undefined) {
    abortTransaction(removalBusy());
  }
  const sourceOrganizationId = brandPersistedOrganizationId(
    source.organizationId,
  );
  await tryLockMemberFeatureAdmission(tx, sourceOrganizationId);
  const timerClose = await closeRemovedMemberActiveTimer({
    organizationId,
    tx,
    userId,
    lockWorkspaces: async (transaction) => {
      await lockOrganizationCleanupWorkspaces({
        tx: transaction,
        organizationId: sourceOrganizationId,
        userId,
        reassignTo,
      });
      const scope = await proveOrgScope(transaction, {
        table: "member",
        where: sql`${and(eq(member.id, memberId), eq(member.organizationId, sourceOrganizationId), eq(member.userId, userId))}`,
      });
      if (
        scope.isErr() ||
        assertCallerOrg(scope.value, organizationId).isErr()
      ) {
        abortTransaction(removalBusy());
      }
    },
  });
  if (Result.isError(timerClose)) {
    abortTransaction(timerClose.error);
  }
  const membershipProof = await proveOrgScope(tx, {
    table: "member",
    where: sql`${and(
      eq(member.id, memberId),
      eq(member.organizationId, sourceOrganizationId),
      eq(member.userId, userId),
    )}`,
  });
  if (membershipProof.isErr()) {
    abortTransaction(removalBusy());
  }
  if (reassignTo) {
    const replacement = await tx
      .select({ id: member.id })
      .from(member)
      .where(
        and(
          eq(member.organizationId, organizationId),
          eq(member.userId, reassignTo),
        ),
      );
    if (reassignTo === userId || replacement.length === 0) {
      abortTransaction(
        new HandlerError({
          status: 400,
          message: "User is not a member of this organization",
        }),
      );
    }
  }
  // Workspace locks precede run, step, obligation and entity cleanup.
  await cancelMemberFlowRuns({
    tx,
    organizationId,
    memberId,
    userId,
    actorUserId,
    reassignTo,
  });
  await clearMemberAssignments({
    tx,
    scope: { type: "organization", organizationId },
    userId,
    actorUserId,
    reassignTo,
  });
  const recordAuditEvent = createBackgroundAuditRecorder({
    organizationId,
    workspaceId: null,
    userId: actorUserId,
    execution: {
      performer: { type: "user", id: actorUserId },
      trigger: { type: "system", source: "membership_removal" },
    },
  });
  await clearRemovedMemberMatterLeads({
    tx,
    scope: membershipProof.value,
    userId,
    recordAuditEvent,
  });
  await cancelMemberDesktopSessions({
    tx,
    organizationId,
    userId,
    actorUserId,
  });
  await clearMemberPresence({
    tx,
    organizationId,
    userId,
    memberId,
    recordAuditEvent,
  });
  await clearRemovedMemberOrganizationState({
    tx,
    scope: membershipProof.value,
    userId,
    recordAuditEvent,
  });
  await removeDepartingMemberMatterMemberships({
    tx,
    scope: membershipProof.value,
    userId,
    recordAuditEvent,
  });
  await clearOrganizationCorrespondenceAssignments({
    tx,
    organizationId,
    userId,
  });
  await removeOrganizationMemberWithAuthArtifacts(tx, {
    memberId,
    organizationId,
    userId,
  });
  await recordAuditEvent(tx, {
    action: AUDIT_ACTION.UPDATE,
    resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
    resourceId: organizationId,
    metadata: { change: "member-removed", memberId, userId },
  });
};
