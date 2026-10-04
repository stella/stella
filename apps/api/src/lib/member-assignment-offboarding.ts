import { Result } from "better-result";
import { and, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

import { MEMBER_REMOVAL_BUSY_CODE } from "@stll/api-contract";

import { agentDelegation, agentRegistration } from "@/api/db/agent-auth-schema";
import {
  apikey,
  invitation,
  member,
  oauthAccessToken,
  oauthConsent,
  oauthRefreshToken,
  session,
} from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  BILLING_STATUS,
  correspondence,
  desktopEditHandoffs,
  folioCollabRoomTokens,
  entities,
  pdfSigningSessions,
  timeEntries,
  desktopEditSessions,
  flowRuns,
  flowDefinitions,
  flowRunSteps,
  mcpUserConnections,
  sharepointConnections,
  sharepointOAuthState,
  mcpOAuthState,
  contacts,
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
} from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { removeOrganizationMemberWithAuthArtifacts } from "@/api/lib/auth-artifacts";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { clearOrganizationCorrespondenceAssignments } from "@/api/lib/email/correspondence/offboarding";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { MAX_FLOW_STEPS } from "@/api/lib/flows/flow-types";
import { LIMITS } from "@/api/lib/limits";
import { isPgError, PG_ERROR } from "@/api/lib/pg-error";
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

const removalBusy = () =>
  new HandlerError({
    status: 409,
    code: MEMBER_REMOVAL_BUSY_CODE,
    retryable: true,
    message: "Other work is in progress. Please try again shortly.",
  });

/** Existing account deletion holds organization membership first; never wait on its inverse. */
export const tryLockMemberCleanupWorkspace = async (
  tx: Transaction,
  workspaceId: SafeId<"workspace">,
) => {
  const advisory = await tx
    .select({
      locked: sql<boolean>`pg_try_advisory_xact_lock(hashtext(${workspaceId}))`,
    })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  if (!advisory.at(0)?.locked) {
    throw removalBusy();
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
    throw isPgError(locked.error, PG_ERROR.LOCK_NOT_AVAILABLE)
      ? removalBusy()
      : locked.error;
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

const clearMemberObligationOwners = async ({
  tx,
  scope,
  userId,
  actorUserId,
  reassignTo,
}: ClearMemberAssignmentsOptions) => {
  if (scope.type === "organization") {
    while (true) {
      // db-await-in-loop: drain mutable ownership in bounded audited batches.
      const owned = await tx
        .select({
          entityId: workObligations.entityId,
          workspaceId: workObligations.workspaceId,
          status: workObligations.status,
        })
        .from(workObligations)
        .innerJoin(workspaces, eq(workspaces.id, workObligations.workspaceId))
        .where(
          and(
            eq(workspaces.organizationId, scope.organizationId),
            eq(workObligations.ownerUserId, userId),
            inArray(workObligations.status, [
              WORK_OBLIGATION_STATUS.ACTIVE,
              WORK_OBLIGATION_STATUS.AWAITING_ACKNOWLEDGEMENT,
            ]),
          ),
        )
        .orderBy(workObligations.workspaceId, workObligations.entityId)
        .limit(LIMITS.memberRemovalCleanupBatchSize)
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
            throw new HandlerError({
              status: 400,
              message: "User is not a member of this workspace",
            });
          }
        }
      }
      if (owned.length > 0) {
        // db-await-in-loop: persist this bounded ownership batch before the next read.
        await tx
          .update(workObligations)
          .set({
            ownerUserId: nextOwnerUserId,
            status: nextStatus,
            acknowledgedAt: null,
            acknowledgedByUserId: null,
            updatedAt: new Date(),
          })
          .where(
            inArray(
              workObligations.entityId,
              owned.map(({ entityId }) => entityId),
            ),
          );
        // db-await-in-loop: write history for this bounded ownership batch.
        await tx.insert(workObligationEvents).values(
          owned.map((row) => ({
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
        const recorder = createBackgroundAuditRecorder({
          organizationId: scope.organizationId,
          workspaceId: null,
          userId: actorUserId,
          execution: {
            performer: { type: "user", id: actorUserId },
            trigger: { type: "system", source: "membership_removal" },
          },
        });
        // db-await-in-loop: batch audit for each drained ownership page.
        await recorder(
          tx,
          owned.map((row) => ({
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
  while (true) {
    // db-await-in-loop: drain assignment rows in bounded audited batches.
    const assigned = await tx
      .select({
        entityId: taskAssignees.entityId,
        role: taskAssignees.role,
        workspaceId: taskAssignees.workspaceId,
        organizationId: workspaces.organizationId,
      })
      .from(taskAssignees)
      .innerJoin(workspaces, eq(workspaces.id, taskAssignees.workspaceId))
      .innerJoin(entities, eq(entities.id, taskAssignees.entityId))
      .where(
        and(
          eq(taskAssignees.userId, userId),
          workspaceScope,
          // Completed and cancelled tasks keep their former assignee as
          // history; only open work moves or returns to the matter.
          openTaskStatus,
        ),
      )
      .orderBy(taskAssignees.entityId)
      .limit(LIMITS.memberRemovalCleanupBatchSize);
    if (assigned.length === 0) {
      break;
    }
    const byWorkspace = new Map<SafeId<"workspace">, typeof assigned>();
    for (const row of assigned) {
      const rows = byWorkspace.get(row.workspaceId) ?? [];
      rows.push(row);
      byWorkspace.set(row.workspaceId, rows);
    }
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
          throw new HandlerError({
            status: 400,
            message: "User is not a member of this workspace",
          });
        }
      }
    }
    if (assigned.length > 0) {
      // db-await-in-loop: clear this page before the next read.
      await tx.delete(taskAssignees).where(
        and(
          eq(taskAssignees.userId, userId),
          inArray(
            taskAssignees.entityId,
            assigned.map(({ entityId }) => entityId),
          ),
        ),
      );
      if (reassignTo) {
        // db-await-in-loop: preserve this bounded replacement batch.
        await tx
          .insert(taskAssignees)
          .values(
            assigned.map((row) => ({
              entityId: row.entityId,
              role: row.role,
              workspaceId: row.workspaceId,
              userId: reassignTo,
            })),
          )
          .onConflictDoNothing({
            target: [taskAssignees.entityId, taskAssignees.userId],
          });
      }
    }
    for (const rows of byWorkspace.values()) {
      const first = rows.at(0);
      if (!first) {
        continue;
      }
      const recorder =
        recordAuditEvent ??
        createBackgroundAuditRecorder({
          organizationId: first.organizationId,
          workspaceId: first.workspaceId,
          userId: actorUserId,
          execution: {
            performer: { type: "user", id: actorUserId },
            trigger: { type: "system", source: "membership_removal" },
          },
        });
      // db-await-in-loop: audit each matter as its own tenant, batched within the matter.
      await recorder(
        tx,
        rows.map((row) => ({
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
          resourceId: row.entityId,
          workspaceId: row.workspaceId,
          changes: { assigneeUserId: { old: userId, new: reassignTo ?? null } },
          metadata: {
            kind: "task",
            change: reassignTo ? "assignee-reassigned" : "assignee-removed",
            role: row.role,
            cause: "membership_removed",
          },
        })),
      );
    }
  }
};

const closeMemberExchanges = async ({
  tx,
  scope,
  userId,
}: ClearMemberAssignmentsOptions) => {
  const workspaceScope = memberWorkspaceScope(scope);
  const scopedWorkspaces = tx
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(workspaceScope);
  const now = new Date();
  // A pending takeover would hand the departing member a fresh session token.
  await tx
    .update(desktopEditSessions)
    .set({ takeoverRequestedBy: null, takeoverRequestedAt: null })
    .where(
      and(
        inArray(desktopEditSessions.workspaceId, scopedWorkspaces),
        eq(desktopEditSessions.takeoverRequestedBy, userId),
        eq(desktopEditSessions.status, "open"),
      ),
    );
  await tx
    .update(desktopEditHandoffs)
    .set({ expiresAt: now, updatedAt: now })
    .where(
      and(
        inArray(desktopEditHandoffs.workspaceId, scopedWorkspaces),
        eq(desktopEditHandoffs.createdBy, userId),
        sql`${desktopEditHandoffs.expiresAt} > ${now}`,
      ),
    );
  await tx
    .update(pdfSigningSessions)
    .set({
      status: "cancelled",
      closeReason: "expired",
      closedAt: now,
      handoffExpiresAt: now,
      tokenExpiresAt: now,
    })
    .where(
      and(
        inArray(pdfSigningSessions.workspaceId, scopedWorkspaces),
        eq(pdfSigningSessions.createdBy, userId),
        eq(pdfSigningSessions.status, "open"),
      ),
    );
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
  while (true) {
    // db-await-in-loop: drain attorney references in bounded audited batches.
    // Matter creation already locks its client before organization membership.
    // Refuse contention here instead of introducing the opposite waiting order.
    const contactResult = await Result.tryPromise({
      try: async () =>
        await tx
          .select({
            id: contacts.id,
            organizationId: contacts.organizationId,
            originatingAttorneyId: contacts.originatingAttorneyId,
            responsibleAttorneyId: contacts.responsibleAttorneyId,
          })
          .from(contacts)
          .where(
            and(
              contactScope,
              or(
                eq(contacts.originatingAttorneyId, userId),
                eq(contacts.responsibleAttorneyId, userId),
              ),
            ),
          )
          .orderBy(contacts.id)
          .limit(LIMITS.memberRemovalCleanupBatchSize)
          .for("update", { noWait: true }),
      catch: (error) => error,
    });
    if (Result.isError(contactResult)) {
      throw isPgError(contactResult.error, PG_ERROR.LOCK_NOT_AVAILABLE)
        ? removalBusy()
        : contactResult.error;
    }
    const contactRows = contactResult.value;
    if (contactRows.length === 0) {
      break;
    }
    // db-await-in-loop: clear the bounded attorney batch before the next read.
    await tx
      .update(contacts)
      .set({
        originatingAttorneyId: sql`CASE WHEN ${contacts.originatingAttorneyId} = ${userId} THEN NULL ELSE ${contacts.originatingAttorneyId} END`,
        responsibleAttorneyId: sql`CASE WHEN ${contacts.responsibleAttorneyId} = ${userId} THEN NULL ELSE ${contacts.responsibleAttorneyId} END`,
        updatedAt: new Date(),
      })
      .where(
        inArray(
          contacts.id,
          contactRows.map(({ id }) => id),
        ),
      );
    // db-await-in-loop: enqueue projection repairs for this bounded batch.
    await enqueueContactSearchRepairs(
      tx,
      contactRows.map(({ id }) => id),
    );
    const contactsByOrganization = new Map<
      SafeId<"organization">,
      typeof contactRows
    >();
    for (const row of contactRows) {
      const rows = contactsByOrganization.get(row.organizationId) ?? [];
      rows.push(row);
      contactsByOrganization.set(row.organizationId, rows);
    }
    for (const [organizationId, rows] of contactsByOrganization) {
      const recorder = createBackgroundAuditRecorder({
        organizationId,
        workspaceId: null,
        userId: actorUserId,
        execution: {
          performer: { type: "user", id: actorUserId },
          trigger: { type: "system", source: "membership_removal" },
        },
      });
      // db-await-in-loop: batch audit by the contact's organization ownership.
      await recorder(
        tx,
        rows.map((row) => ({
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
        })),
      );
    }
  }
};

const timeEntryApprovalScope = (
  tx: Transaction,
  scope: AssignmentScope,
  userId: SafeId<"user">,
) => {
  if (scope.type === "workspace") {
    return eq(timeEntries.workspaceId, scope.workspaceId);
  }
  if (scope.type === "organization") {
    return eq(timeEntries.organizationId, scope.organizationId);
  }
  // Account erasure: bound by the user's organizations so the approval-queue
  // index serves the read; memberships are deleted only after this cleanup.
  return inArray(
    timeEntries.organizationId,
    tx
      .select({ id: member.organizationId })
      .from(member)
      .where(eq(member.userId, userId)),
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
  while (true) {
    // db-await-in-loop: drain pending approvals in bounded audited batches.
    const pending = await Result.tryPromise({
      try: async () =>
        await tx
          .select({
            id: timeEntries.id,
            organizationId: timeEntries.organizationId,
            workspaceId: timeEntries.workspaceId,
          })
          .from(timeEntries)
          .where(
            and(
              timeEntryApprovalScope(tx, scope, userId),
              eq(timeEntries.approverUserId, userId),
              eq(timeEntries.status, BILLING_STATUS.DRAFT),
            ),
          )
          .orderBy(timeEntries.id)
          .limit(LIMITS.memberRemovalCleanupBatchSize)
          .for("update", { noWait: true }),
      catch: (error) => error,
    });
    if (Result.isError(pending)) {
      throw isPgError(pending.error, PG_ERROR.LOCK_NOT_AVAILABLE)
        ? removalBusy()
        : pending.error;
    }
    const rows = pending.value;
    if (rows.length === 0) {
      break;
    }
    // db-await-in-loop: persist this bounded approval batch before the next read.
    await tx
      .update(timeEntries)
      .set({ approverUserId: null, updatedAt: new Date() })
      .where(
        inArray(
          timeEntries.id,
          rows.map(({ id }) => id),
        ),
      );
    const byOrganization = new Map<SafeId<"organization">, typeof rows>();
    for (const row of rows) {
      const grouped = byOrganization.get(row.organizationId) ?? [];
      grouped.push(row);
      byOrganization.set(row.organizationId, grouped);
    }
    for (const [organizationId, grouped] of byOrganization) {
      const recorder =
        recordAuditEvent ??
        createBackgroundAuditRecorder({
          organizationId,
          workspaceId: null,
          userId: actorUserId,
          execution: {
            performer: { type: "user", id: actorUserId },
            trigger: { type: "system", source: "membership_removal" },
          },
        });
      // db-await-in-loop: audit each organization's approval batch as its own tenant.
      await recorder(
        tx,
        grouped.map((row) => ({
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.TIME_ENTRY,
          resourceId: row.id,
          workspaceId: row.workspaceId,
          changes: { approverUserId: { old: userId, new: null } },
          metadata: { cause: "membership_removed" },
        })),
      );
    }
  }
};

/** Caller holds the departing memberships until cleanup and deletion commit. */
export const clearMemberAssignments = async (
  options: ClearMemberAssignmentsOptions,
) => {
  if (options.reassignTo === options.userId) {
    throw new HandlerError({
      status: 400,
      message: "User is not a member of this workspace",
    });
  }
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
};

/**
 * Every matter in which removal changes a row of this user: memberships,
 * assignments, owned obligations, lead, pending approvals, runs they started
 * or authored, and their open exchanges. Removal locks exactly these matters,
 * so unrelated matters of the organization keep accepting writes.
 */
export const selectMemberCleanupWorkspaceIds = async ({
  tx,
  userId,
  organizationId,
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
  const bound = LIMITS.workspacesCount + 1;
  const ids = new Set<SafeId<"workspace">>();
  const sources = [
    async () =>
      await tx
        .select({ id: workspaceMembers.workspaceId })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.userId, userId),
            inOrganization(workspaceMembers.workspaceId),
          ),
        )
        .limit(bound),
    async () =>
      await tx
        .selectDistinct({ id: taskAssignees.workspaceId })
        .from(taskAssignees)
        .where(
          and(
            eq(taskAssignees.userId, userId),
            inOrganization(taskAssignees.workspaceId),
          ),
        )
        .limit(bound),
    async () =>
      await tx
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
        )
        .limit(bound),
    async () =>
      await tx
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(
          and(
            eq(workspaces.leadUserId, userId),
            organizationId
              ? eq(workspaces.organizationId, organizationId)
              : undefined,
          ),
        )
        .limit(bound),
    async () =>
      (
        await tx
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
          )
          .limit(bound)
      ).flatMap(({ id }) => (id === null ? [] : [{ id }])),
    // The running timer offboarding closes locks its matter too.
    async () =>
      (
        await tx
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
          )
          .limit(bound)
      ).flatMap(({ id }) => (id === null ? [] : [{ id }])),
    async () =>
      await tx
        .selectDistinct({ id: flowRuns.workspaceId })
        .from(flowRuns)
        .leftJoin(
          flowDefinitions,
          eq(flowDefinitions.id, flowRuns.definitionId),
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
        )
        .limit(bound),
    async () =>
      await tx
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
        )
        .limit(bound),
    async () =>
      await tx
        .selectDistinct({ id: desktopEditHandoffs.workspaceId })
        .from(desktopEditHandoffs)
        .where(
          and(
            eq(desktopEditHandoffs.createdBy, userId),
            sql`${desktopEditHandoffs.expiresAt} > ${now}`,
            inOrganization(desktopEditHandoffs.workspaceId),
          ),
        )
        .limit(bound),
    async () =>
      await tx
        .selectDistinct({ id: pdfSigningSessions.workspaceId })
        .from(pdfSigningSessions)
        .where(
          and(
            eq(pdfSigningSessions.createdBy, userId),
            eq(pdfSigningSessions.status, "open"),
            inOrganization(pdfSigningSessions.workspaceId),
          ),
        )
        .limit(bound),
  ];
  for (const source of sources) {
    // db-await-in-loop: one indexed read per kind of row removal changes.
    for (const { id } of await source()) {
      ids.add(id);
    }
  }
  if (ids.size > LIMITS.workspacesCount) {
    throw new HandlerError({
      status: 400,
      message: "Workspaces limit reached",
    });
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
export const tryLockAccountMemberCleanup = async (
  tx: Transaction,
  userId: SafeId<"user">,
) => {
  await tx
    .select({ id: member.id })
    .from(member)
    .where(eq(member.userId, userId))
    .for("update");
  for (const id of await selectMemberCleanupWorkspaceIds({ tx, userId })) {
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
export const lockMemberCleanupWorkspaces = async (
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

const cancelMemberFlowRuns = async ({
  tx,
  organizationId,
  userId,
}: RemoveOrganizationMemberOptions) => {
  // Workspace locks precede run, step, obligation and entity cleanup.
  const affectedWorkspaceIds = tx
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.organizationId, organizationId));
  while (true) {
    // db-await-in-loop: cancel bounded run batches while holding the workspace prefix.
    const runs = await tx
      .select({ id: flowRuns.id })
      .from(flowRuns)
      .leftJoin(flowDefinitions, eq(flowDefinitions.id, flowRuns.definitionId))
      .where(
        and(
          inArray(flowRuns.workspaceId, affectedWorkspaceIds),
          inArray(flowRuns.status, ["pending", "running", "awaiting_review"]),
          or(
            sql`${flowRuns.triggerSource}->>'userId' = ${userId}`,
            and(
              sql`${flowRuns.triggerSource}->>'type' <> 'manual'`,
              eq(flowDefinitions.createdByUserId, userId),
            ),
          ),
        ),
      )
      .orderBy(flowRuns.id)
      .limit(LIMITS.memberRemovalCleanupBatchSize)
      .for("update", { of: flowRuns });
    if (runs.length === 0) {
      break;
    }
    if (runs.length > 0) {
      const runIds = runs.map(({ id }) => id);
      // db-await-in-loop: lock each batch of steps after its run locks.
      await tx
        .select({ id: flowRunSteps.id })
        .from(flowRunSteps)
        .where(inArray(flowRunSteps.runId, runIds))
        .orderBy(flowRunSteps.runId, flowRunSteps.index)
        .limit(runIds.length * MAX_FLOW_STEPS)
        .for("update");
      // db-await-in-loop: persist this bounded run cancellation batch.
      await tx
        .update(flowRuns)
        .set({ status: "cancelled", finishedAt: new Date() })
        .where(inArray(flowRuns.id, runIds));
      // db-await-in-loop: persist this bounded step cancellation batch.
      await tx
        .update(flowRunSteps)
        .set({ status: "skipped", finishedAt: new Date() })
        .where(
          and(
            inArray(flowRunSteps.runId, runIds),
            inArray(flowRunSteps.status, [
              "pending",
              "running",
              "awaiting_review",
            ]),
          ),
        );
    }
  }
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
) => {
  const timerClose = await closeRemovedMemberActiveTimer({
    organizationId,
    tx,
    userId,
    lockWorkspaces: async (transaction) => {
      const locked = await lockMemberCleanupWorkspaces({
        tx: transaction,
        userId,
        organizationId,
      });
      // Existing promotion takes workspace -> organization membership.
      await transaction
        .select({ id: member.id })
        .from(member)
        .where(
          and(
            eq(member.organizationId, organizationId),
            inArray(
              member.userId,
              reassignTo ? [userId, reassignTo] : [userId],
            ),
          ),
        )
        .orderBy(member.userId)
        .limit(reassignTo ? 2 : 1)
        .for("update");
      // A grant that held its matter before this membership lock may have
      // committed meanwhile; the held membership refuses every later one.
      const current = (
        await selectMemberCleanupWorkspaceIds({
          tx: transaction,
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
        await tryLockMemberCleanupWorkspace(transaction, id);
      }
      if (current.length > 0) {
        await transaction
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
    },
  });
  if (Result.isError(timerClose)) {
    throw timerClose.error;
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
      throw new HandlerError({
        status: 400,
        message: "User is not a member of this organization",
      });
    }
  }
  // Workspace locks precede run, step, obligation and entity cleanup.
  const affectedWorkspaceIds = tx
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.organizationId, organizationId));
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
  await tx
    .update(workspaces)
    .set({ leadUserId: null })
    .where(
      and(
        eq(workspaces.organizationId, organizationId),
        eq(workspaces.leadUserId, userId),
      ),
    );
  await tx
    .update(desktopEditSessions)
    .set({ status: "cancelled", closedAt: new Date() })
    .where(
      and(
        inArray(desktopEditSessions.workspaceId, affectedWorkspaceIds),
        eq(desktopEditSessions.createdBy, userId),
        eq(desktopEditSessions.status, "open"),
      ),
    );
  await tx
    .delete(mcpUserConnections)
    .where(
      and(
        eq(mcpUserConnections.organizationId, organizationId),
        eq(mcpUserConnections.userId, userId),
      ),
    );
  await tx
    .delete(sharepointConnections)
    .where(
      and(
        eq(sharepointConnections.organizationId, organizationId),
        eq(sharepointConnections.userId, userId),
      ),
    );
  await tx
    .delete(mcpOAuthState)
    .where(
      and(
        eq(mcpOAuthState.organizationId, organizationId),
        eq(mcpOAuthState.userId, userId),
      ),
    );
  await tx
    .delete(sharepointOAuthState)
    .where(
      and(
        eq(sharepointOAuthState.organizationId, organizationId),
        eq(sharepointOAuthState.userId, userId),
      ),
    );
  await tx
    .delete(invitation)
    .where(
      and(
        eq(invitation.organizationId, organizationId),
        eq(invitation.inviterId, userId),
        eq(invitation.status, "pending"),
      ),
    );

  await tx
    .delete(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.userId, userId),
        inArray(
          workspaceMembers.workspaceId,
          tx
            .select({ id: workspaces.id })
            .from(workspaces)
            .where(eq(workspaces.organizationId, organizationId)),
        ),
      ),
    );
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
};

/** How removal treats a column that names the departing member. */
export type MemberCleanupDisposition =
  /** The row is deleted, cancelled or expired, or the column is nulled. */
  | "cleared"
  /** Open work moves to `reassign_to` when given, otherwise it is cleared. */
  | "reassigned";

/**
 * Every column organization removal changes for the departing member, in this
 * module or in the credential revocation it runs in the same transaction. The
 * schema coverage guard derives its census from this list.
 */
export const ORGANIZATION_MEMBER_CLEANUP_COLUMNS = [
  [member.userId, "cleared"],
  [workspaceMembers.userId, "cleared"],
  [taskAssignees.userId, "reassigned"],
  [workObligations.ownerUserId, "reassigned"],
  [timeEntries.approverUserId, "cleared"],
  [contacts.originatingAttorneyId, "cleared"],
  [contacts.responsibleAttorneyId, "cleared"],
  [workspaces.leadUserId, "cleared"],
  [flowRuns.triggerSource, "cleared"],
  [desktopEditSessions.createdBy, "cleared"],
  [desktopEditSessions.takeoverRequestedBy, "cleared"],
  [desktopEditHandoffs.createdBy, "cleared"],
  [pdfSigningSessions.createdBy, "cleared"],
  [mcpUserConnections.userId, "cleared"],
  [mcpOAuthState.userId, "cleared"],
  [sharepointConnections.userId, "cleared"],
  [sharepointOAuthState.userId, "cleared"],
  [invitation.inviterId, "cleared"],
  [correspondence.assigneeId, "cleared"],
  // Revoked by `removeOrganizationMemberWithAuthArtifacts`.
  [session.userId, "cleared"],
  [apikey.referenceId, "cleared"],
  [oauthAccessToken.userId, "cleared"],
  [oauthRefreshToken.userId, "cleared"],
  [oauthConsent.userId, "cleared"],
  [agentRegistration.boundUserId, "cleared"],
  [agentDelegation.userId, "cleared"],
  [folioCollabRoomTokens.userId, "cleared"],
] as const satisfies readonly (readonly [PgColumn, MemberCleanupDisposition])[];

/**
 * Every column matter removal (`handlers/workspaces/members/remove.ts` with
 * `clearMemberAssignments`) changes for the departing member. The schema coverage guard derives from this list.
 */
export const WORKSPACE_MEMBER_CLEANUP_COLUMNS = [
  [workspaceMembers.userId, "cleared"],
  [taskAssignees.userId, "reassigned"],
  [workObligations.ownerUserId, "reassigned"],
  [timeEntries.approverUserId, "cleared"],
  [workspaces.leadUserId, "cleared"],
  [correspondence.assigneeId, "cleared"],
  [desktopEditSessions.createdBy, "cleared"],
  [desktopEditSessions.takeoverRequestedBy, "cleared"],
  [desktopEditHandoffs.createdBy, "cleared"],
  [pdfSigningSessions.createdBy, "cleared"],
] as const satisfies readonly (readonly [PgColumn, MemberCleanupDisposition])[];
