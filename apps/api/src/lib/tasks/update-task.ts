import { panic, Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";
import { isDeepStrictEqual } from "node:util";

import type { Transaction } from "@/api/db/root";
import { abortableTx } from "@/api/db/safe-db";
import type { SafeDb } from "@/api/db/safe-db";
import {
  entities,
  LIST_ITEM_TYPES,
  WORK_OBLIGATION_EVENT_TYPE,
  WORK_OBLIGATION_SOURCE,
  WORK_OBLIGATION_STATUS,
  WORK_OBLIGATION_TYPE,
  workObligationEvents,
  workObligations,
} from "@/api/db/schema";
import type { ListItemType, WorkObligationStatus } from "@/api/db/schema";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type {
  AuditAction,
  AuditRecorder,
  FieldDiffs,
} from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { lockWorkspacesForEntityCap } from "@/api/lib/entity-cap-lock";
import type { AgendaItemKind } from "@/api/lib/entity-constants";
import {
  AGENDA_ITEM_KINDS,
  ENTITY_PRIORITIES,
  TASK_STATUSES,
} from "@/api/lib/entity-constants";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { FlowReviewDecision } from "@/api/lib/flows/flow-types";
import {
  decideGateForTask,
  gateDecisionForTransition,
} from "@/api/lib/flows/review-gate-task";
import { LIMITS } from "@/api/lib/limits";
import { validateAgendaFields } from "@/api/lib/tasks/agenda-fields";
import {
  deployedTaskFeatures,
  type TaskDeploymentFeatures,
} from "@/api/lib/tasks/deployment-features";
import { includes } from "@/api/lib/type-guards";
import { isWorkObligationEligible } from "@/api/lib/work-obligations/eligibility";
import { ensureLegacyWorkObligation } from "@/api/lib/work-obligations/legacy-work-obligation";
import { lockWorkObligation } from "@/api/lib/work-obligations/lock-work-obligation";
import {
  isClosedWorkObligationStatus,
  nextWorkObligationStatus,
  resolveWorkObligationTransition,
  WORK_OBLIGATION_TRANSITION_ACTION,
  WORK_OBLIGATION_TRANSITION_AUDIT_ACTION,
  WORK_OBLIGATION_TRANSITIONS,
  workObligationIntentForTaskStatus,
} from "@/api/lib/work-obligations/transitions";
import type { WorkObligationTransitionAction } from "@/api/lib/work-obligations/transitions";

const agendaDateTimeSchema = t.Nullable(t.String({ format: "date-time" }));
const agendaParticipantSchema = t.Object({
  email: t.Nullable(t.String({ format: "email", maxLength: 320 })),
  name: t.Nullable(t.String({ maxLength: 512 })),
});
const agendaAttendeeSchema = t.Object({
  email: t.Nullable(t.String({ format: "email", maxLength: 320 })),
  name: t.Nullable(t.String({ maxLength: 512 })),
  optional: t.Optional(t.Boolean()),
  responseStatus: t.Optional(t.Nullable(t.String({ maxLength: 64 }))),
  type: t.Optional(t.Nullable(t.String({ maxLength: 32 }))),
});
const agendaRecurrenceSchema = t.Object({
  pattern: t.Nullable(t.String({ maxLength: 2000 })),
  range: t.Nullable(t.String({ maxLength: 2000 })),
});

export const updateTaskBodySchema = t.Object({
  taskId: tSafeId("entity"),
  name: t.Optional(t.String({ minLength: 1, maxLength: 255 })),
  agendaKind: t.Optional(t.String({ minLength: 1, maxLength: 32 })),
  status: t.Optional(t.String({ minLength: 1, maxLength: 32 })),
  priority: t.Optional(t.String({ minLength: 1, maxLength: 16 })),
  dueDate: t.Optional(t.Nullable(t.String({ format: "date" }))),
  listItemType: t.Optional(t.String({ minLength: 1, maxLength: 32 })),
  startAt: t.Optional(agendaDateTimeSchema),
  endAt: t.Optional(agendaDateTimeSchema),
  occurredAt: t.Optional(agendaDateTimeSchema),
  remindAt: t.Optional(agendaDateTimeSchema),
  allDay: t.Optional(t.Boolean()),
  timeZone: t.Optional(t.Nullable(t.String({ maxLength: 64 }))),
  location: t.Optional(t.Nullable(t.String({ maxLength: 1000 }))),
  onlineMeetingUrl: t.Optional(t.Nullable(t.String({ maxLength: 2048 }))),
  availability: t.Optional(t.Nullable(t.String({ maxLength: 32 }))),
  sensitivity: t.Optional(t.Nullable(t.String({ maxLength: 32 }))),
  organizer: t.Optional(t.Nullable(agendaParticipantSchema)),
  attendees: t.Optional(
    t.Nullable(
      t.Array(agendaAttendeeSchema, {
        maxItems: LIMITS.agendaAttendeesMax,
      }),
    ),
  ),
  recurrence: t.Optional(t.Nullable(agendaRecurrenceSchema)),
  sortOrder: t.Optional(t.Nullable(t.String({ maxLength: 64 }))),
  workflowReason: t.Optional(t.String({ minLength: 1, maxLength: 1000 })),
});
type UpdateTaskBody = Static<typeof updateTaskBodySchema>;

const toDateOrNull = (value: string | null | undefined): Date | null =>
  value ? new Date(value) : null;

type AgendaKindValidationResult =
  | { agendaKind: AgendaItemKind | null; status: "ok" }
  | { error: HandlerError; status: "error" };

const validateAgendaKind = (
  value: string | undefined,
): AgendaKindValidationResult => {
  if (value === undefined) {
    return { agendaKind: null, status: "ok" };
  }
  if (includes(AGENDA_ITEM_KINDS, value)) {
    return { agendaKind: value, status: "ok" };
  }
  return {
    error: new HandlerError({
      status: 400,
      message: "Invalid agenda item kind",
    }),
    status: "error",
  };
};

type ListItemTypeValidationResult =
  | { listItemType: ListItemType | null; status: "ok" }
  | { error: HandlerError; status: "error" };

const validateListItemType = (
  value: string | undefined,
): ListItemTypeValidationResult => {
  if (value === undefined) {
    return { listItemType: null, status: "ok" };
  }
  if (includes(LIST_ITEM_TYPES, value)) {
    return { listItemType: value, status: "ok" };
  }
  return {
    error: new HandlerError({
      status: 400,
      message: "Invalid list item type",
    }),
    status: "error",
  };
};

const validateTaskFields = (
  body: UpdateTaskBody,
): ListItemTypeValidationResult => {
  if (body.status !== undefined && !includes(TASK_STATUSES, body.status)) {
    return {
      error: new HandlerError({ status: 400, message: "Invalid task status" }),
      status: "error",
    };
  }
  if (
    body.priority !== undefined &&
    !includes(ENTITY_PRIORITIES, body.priority)
  ) {
    return {
      error: new HandlerError({
        status: 400,
        message: "Invalid task priority",
      }),
      status: "error",
    };
  }
  return validateListItemType(body.listItemType);
};

type TaskInputValidationResult =
  | {
      agendaKind: AgendaItemKind | null;
      listItemType: ListItemType | null;
      status: "ok";
    }
  | { error: HandlerError; status: "error" };

const validateTaskInput = (body: UpdateTaskBody): TaskInputValidationResult => {
  const agendaKindResult = validateAgendaKind(body.agendaKind);
  if (agendaKindResult.status === "error") {
    return agendaKindResult;
  }
  const taskFieldsResult = validateTaskFields(body);
  if (taskFieldsResult.status === "error") {
    return taskFieldsResult;
  }
  return {
    agendaKind: agendaKindResult.agendaKind,
    listItemType: taskFieldsResult.listItemType,
    status: "ok",
  };
};

type ValidAgendaFields = Extract<
  ReturnType<typeof validateAgendaFields>,
  { status: "ok" }
>;

type TaskUpdateValuesOptions = {
  agendaFields: ValidAgendaFields;
  agendaKind: AgendaItemKind | null;
  body: UpdateTaskBody;
  listItemType: ListItemType | null;
};

const taskUpdateValues = ({
  agendaFields,
  agendaKind,
  body,
  listItemType,
}: TaskUpdateValuesOptions) => ({
  ...(body.name !== undefined && { name: body.name }),
  ...(agendaKind !== null && { agendaKind }),
  ...(body.status !== undefined && { status: body.status }),
  ...(body.priority !== undefined && { priority: body.priority }),
  ...(body.dueDate !== undefined && { dueDate: body.dueDate }),
  ...(listItemType !== null && { listItemType }),
  ...(body.startAt !== undefined && { startAt: toDateOrNull(body.startAt) }),
  ...(body.endAt !== undefined && { endAt: toDateOrNull(body.endAt) }),
  ...(body.occurredAt !== undefined && {
    occurredAt: toDateOrNull(body.occurredAt),
  }),
  ...(body.remindAt !== undefined && {
    remindAt: toDateOrNull(body.remindAt),
  }),
  ...(body.allDay !== undefined && { allDay: body.allDay }),
  ...(body.timeZone !== undefined && { timeZone: body.timeZone }),
  ...(body.location !== undefined && { location: body.location }),
  ...(body.onlineMeetingUrl !== undefined && {
    onlineMeetingUrl: body.onlineMeetingUrl,
  }),
  ...(body.availability !== undefined && {
    availability: agendaFields.availability,
  }),
  ...(body.sensitivity !== undefined && {
    sensitivity: agendaFields.sensitivity,
  }),
  ...(body.organizer !== undefined && { organizer: body.organizer }),
  ...(body.attendees !== undefined && { attendees: agendaFields.attendees }),
  ...(body.recurrence !== undefined && { recurrence: body.recurrence }),
  ...(body.sortOrder !== undefined && { sortOrder: body.sortOrder }),
  updatedAt: new Date(),
});

/**
 * Field-level old/new pairs for the entity audit entry. A value equal to the
 * stored one is not a change, so a no-op save records nothing; `updatedAt` is
 * bookkeeping, not a change the compliance view needs.
 */
const taskFieldDiffs = (
  before: Record<string, unknown>,
  values: Record<string, unknown>,
): FieldDiffs => {
  const changes: FieldDiffs = {};
  for (const [field, next] of Object.entries(values)) {
    if (field === "updatedAt") {
      continue;
    }
    const previous = before[field];
    // Structural, not serialized: JSONB reorders object keys on the way back,
    // so a no-op save of organizer/attendees/recurrence must not read as a change.
    if (!isDeepStrictEqual(previous, next)) {
      changes[field] = { old: previous, new: next };
    }
  }
  return changes;
};

type LockedWorkObligation = NonNullable<
  Awaited<ReturnType<typeof lockWorkObligation>>
>;

/**
 * Only work nobody has taken up is still trivially derivable from the task
 * itself. An owned, acknowledged or closed obligation carries accountability
 * history that dropping the row would destroy.
 */
const isUnclaimedWorkObligation = (workflow: LockedWorkObligation): boolean =>
  workflow.status === WORK_OBLIGATION_STATUS.UNASSIGNED &&
  workflow.acknowledgedAt === null &&
  workflow.ownerUserId === null;

type ListItemTypeTransition =
  | { type: "removes_obligation"; workflow: LockedWorkObligation }
  | { type: "adds_obligation" }
  | { type: "none" };

type ListItemTypeTransitionOptions = {
  entityId: SafeId<"entity">;
  governedWorkflow: boolean;
  nextListItemType: ListItemType | null;
  tx: Transaction;
  workflow: LockedWorkObligation | undefined;
  workspaceId: SafeId<"workspace">;
};

/**
 * The list discriminator decides whether a row may carry governed work at all,
 * so a change across that boundary has to add or drop the sidecar in the same
 * transaction: otherwise the row keeps a live obligation nothing surfaces, or
 * stays actionable but ungoverned until the backfill sweep reaches it.
 *
 * The stored discriminator is read under the lock the update itself takes, so
 * the value the decision moves away from is the one being written over. A
 * read-only or missing task yields no row and no transition: the update matches
 * nothing and the caller gets that answer instead.
 */
const listItemTypeTransition = async ({
  entityId,
  governedWorkflow,
  nextListItemType,
  tx,
  workflow,
  workspaceId,
}: ListItemTypeTransitionOptions): Promise<ListItemTypeTransition> => {
  if (nextListItemType === null) {
    return { type: "none" };
  }

  const currentTasks = await tx
    .select({ listItemType: entities.listItemType })
    .from(entities)
    .where(
      and(
        eq(entities.id, entityId),
        eq(entities.workspaceId, workspaceId),
        eq(entities.kind, "task"),
        eq(entities.readOnly, false),
      ),
    )
    .limit(1)
    .for("update");
  const currentTask = currentTasks.at(0);
  const nextEligible = isWorkObligationEligible(nextListItemType);
  if (
    !currentTask ||
    isWorkObligationEligible(currentTask.listItemType) === nextEligible
  ) {
    return { type: "none" };
  }

  if (!nextEligible) {
    return workflow
      ? { type: "removes_obligation", workflow }
      : { type: "none" };
  }
  return governedWorkflow && !workflow
    ? { type: "adds_obligation" }
    : { type: "none" };
};

type ApplyListItemTypeTransitionOptions = {
  entityId: SafeId<"entity">;
  recordAuditEvent: AuditRecorder;
  transition: ListItemTypeTransition;
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
};

const applyListItemTypeTransition = async ({
  entityId,
  recordAuditEvent,
  transition,
  tx,
  workspaceId,
}: ApplyListItemTypeTransitionOptions): Promise<void> => {
  switch (transition.type) {
    case "removes_obligation": {
      await tx
        .delete(workObligations)
        .where(
          and(
            eq(workObligations.entityId, entityId),
            eq(workObligations.workspaceId, workspaceId),
          ),
        );
      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.DELETE,
        resourceType: AUDIT_RESOURCE_TYPE.WORK_OBLIGATION,
        resourceId: entityId,
        metadata: { cause: "list_item_type_change" },
      });
      return;
    }
    case "adds_obligation": {
      // Runs after the entity update: the bridge derives the obligation from
      // the stored row, which only becomes eligible once the new discriminator
      // is written.
      await ensureLegacyWorkObligation({ tx, entityId, workspaceId });
      return;
    }
    case "none":
      return;
    default: {
      transition satisfies never;
      return panic(`Unhandled transition: ${String(transition)}`);
    }
  }
};

type ResolveWorkflowStatusTransitionOptions = {
  governedWorkflow: boolean;
  requestedStatus: string | undefined;
  userId: SafeId<"user">;
  workflow: LockedWorkObligation;
  workflowReason: string | undefined;
};

type WorkflowStatusPolicyOptions = {
  action: WorkObligationTransitionAction;
  userId: SafeId<"user">;
  workflow: LockedWorkObligation;
  workflowReason: string | undefined;
};

/** The move each action names, for the message a refusal has to explain. */
const BLOCKED_MOVE = {
  complete: "completed",
  cancel: "cancelled",
  reopen: "reopened",
} as const satisfies Record<WorkObligationTransitionAction, string>;

/**
 * Closed work has exactly one way back, so say so; every other refused source
 * status simply is not one the lifecycle admits for that move.
 */
const blockedTransitionMessage = (
  action: WorkObligationTransitionAction,
  status: WorkObligationStatus,
): string => {
  const current = `Work that is ${status.replaceAll("_", " ")}`;
  return isClosedWorkObligationStatus(status)
    ? `${current} must be reopened before it can be ${BLOCKED_MOVE[action]}`
    : `${current} cannot be ${BLOCKED_MOVE[action]}`;
};

/**
 * A legacy status write carries no explicit intent, so the guards the
 * transition endpoint applies per action are re-applied here. They stay at this
 * call site: the shared table owns which move a status implies, not who may
 * make it, and the source statuses it admits are already settled before this
 * runs.
 */
const assertWorkflowStatusPolicy = ({
  action,
  userId,
  workflow,
  workflowReason,
}: WorkflowStatusPolicyOptions): void => {
  switch (action) {
    case WORK_OBLIGATION_TRANSITION_ACTION.COMPLETE:
      if (workflow.ownerUserId !== userId) {
        throw new HandlerError({
          status: 409,
          message: "Only the accountable owner can complete this work",
        });
      }
      return;
    case WORK_OBLIGATION_TRANSITION_ACTION.CANCEL:
      if (
        workflow.status !== WORK_OBLIGATION_STATUS.UNASSIGNED &&
        !workflowReason
      ) {
        throw new HandlerError({
          status: 400,
          message: "A reason is required when cancelling assigned work",
        });
      }
      return;
    case WORK_OBLIGATION_TRANSITION_ACTION.REOPEN:
      return;
    default: {
      action satisfies never;
      return panic(`Unhandled action: ${String(action)}`);
    }
  }
};

/**
 * Governed deployments resolve the implied move through the shared table, so a
 * task-status write can only reach the obligation states the endpoint would
 * reach. Ungoverned deployments keep legacy freedom: the obligation row mirrors
 * whatever status the write asks for.
 */
const resolveWorkflowStatusTransition = ({
  governedWorkflow,
  requestedStatus,
  userId,
  workflow,
  workflowReason,
}: ResolveWorkflowStatusTransitionOptions) => {
  const intent = workObligationIntentForTaskStatus({
    currentStatus: workflow.status,
    requestedTaskStatus: requestedStatus,
  });
  if (intent.type === "none") {
    return { type: "none" as const };
  }
  const { action } = intent;

  if (!governedWorkflow) {
    return {
      type: "transition" as const,
      action,
      eventType: WORK_OBLIGATION_TRANSITIONS[action].eventType,
      nextStatus: nextWorkObligationStatus(action, workflow),
    };
  }

  const resolution = resolveWorkObligationTransition(action, workflow);
  if (resolution.type === "invalid_status") {
    throw new HandlerError({
      status: 409,
      message: blockedTransitionMessage(action, workflow.status),
    });
  }
  assertWorkflowStatusPolicy({ action, userId, workflow, workflowReason });
  return {
    type: "transition" as const,
    action,
    eventType: resolution.eventType,
    nextStatus: resolution.nextStatus,
  };
};

export type UpdateTaskHandlerProps = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  recordAuditEvent: AuditRecorder;
  body: UpdateTaskBody;
  features?: TaskDeploymentFeatures;
  /** The gate decision's queue and broadcast boundaries; tests pin them. */
  decideGate?: typeof decideGateForTask;
};

type ApplyTaskUpdateOutcome =
  | { type: "updated" }
  | { type: "gate"; decision: FlowReviewDecision };

// Keeps both branches typed as the union, so the wrapper reads one `Result`
// rather than one per branch.
const applyTaskUpdateOutcome = (
  outcome: ApplyTaskUpdateOutcome,
): ApplyTaskUpdateOutcome => outcome;

// One pass over the task: every field the body carries, or the discovery
// that a closing status belongs to a workflow review gate, in which case
// nothing is written and the caller takes the decision first.
const applyTaskUpdate = async function* ({
  safeDb,
  workspaceId,
  userId,
  recordAuditEvent,
  body,
  features,
}: Omit<Required<UpdateTaskHandlerProps>, "decideGate">) {
  if (
    !features.legalLists &&
    body.listItemType !== undefined &&
    body.listItemType !== "task"
  ) {
    return Result.err(
      new HandlerError({ status: 404, message: "Legal Lists are disabled" }),
    );
  }

  const workflowReason = body.workflowReason?.trim();
  const inputResult = validateTaskInput(body);
  if (inputResult.status === "error") {
    return Result.err(inputResult.error);
  }
  const { agendaKind, listItemType } = inputResult;
  const agendaFields = validateAgendaFields({
    attendees: body.attendees,
    availability: body.availability,
    sensitivity: body.sensitivity,
  });
  if (agendaFields.status === "error") {
    return Result.err(agendaFields.error);
  }

  const txResult = yield* Result.await(
    abortableTx(safeDb, async (tx) => {
      const workflowRelevant =
        body.status !== undefined ||
        body.dueDate !== undefined ||
        agendaKind === "task" ||
        agendaKind === "deadline";
      const changesListItemType = listItemType !== null;
      if (changesListItemType) {
        // The workspace row before the obligation, then the entity: the order
        // `lockWorkspacesForEntityCap`, the governed update path and the legacy
        // bridge already agree on, so a discriminator change cannot deadlock
        // against any of them.
        await lockWorkspacesForEntityCap(tx, [workspaceId]);
      }
      let workflow =
        workflowRelevant || changesListItemType
          ? await lockWorkObligation(tx, {
              entityId: body.taskId,
              workspaceId,
            })
          : undefined;
      if (features.governedWorkflow && workflowRelevant && !workflow) {
        await ensureLegacyWorkObligation({
          tx,
          entityId: body.taskId,
          workspaceId,
        });
        workflow = await lockWorkObligation(tx, {
          entityId: body.taskId,
          workspaceId,
        });
      }
      if (features.governedWorkflow && workflowRelevant && !workflow) {
        // The backfill above may have written the obligation row this branch
        // then declares missing; returning would commit it behind the 409.
        throw new HandlerError({
          status: 409,
          message: "Task workflow is not initialized",
        });
      }

      // A closing status on the task a workflow review gate raised is the
      // gate's decision, whichever surface asks for it. Nothing is written
      // here: the decision is taken once this transaction has released the
      // row, and the run then settles the task itself.
      if (
        workflow?.sourceType === WORK_OBLIGATION_SOURCE.FLOW &&
        body.status !== undefined
      ) {
        const intent = workObligationIntentForTaskStatus({
          currentStatus: workflow.status,
          requestedTaskStatus: body.status,
        });
        if (intent.type === "transition") {
          const decision = gateDecisionForTransition(intent.action);
          if (decision === null) {
            throw new HandlerError({
              status: 409,
              message:
                "A workflow review cannot be reopened; start the workflow again instead",
            });
          }
          return { type: "gate" as const, decision };
        }
      }

      const eligibility = await listItemTypeTransition({
        entityId: body.taskId,
        governedWorkflow: features.governedWorkflow,
        nextListItemType: listItemType,
        tx,
        workflow,
        workspaceId,
      });
      if (
        eligibility.type === "removes_obligation" &&
        !isUnclaimedWorkObligation(eligibility.workflow)
      ) {
        throw new HandlerError({
          status: 409,
          message:
            "Governed work must be unassigned and removed before this row can become reference material",
        });
      }

      const workflowSet: Partial<typeof workObligations.$inferInsert> = {};
      const workflowEvents: (typeof workObligationEvents.$inferInsert)[] = [];
      const workflowChanges: FieldDiffs = {};
      let workflowAuditAction: AuditAction = AUDIT_ACTION.UPDATE;
      const now = new Date();

      if (workflow && eligibility.type !== "removes_obligation") {
        const updatesLegacyDeadline =
          body.dueDate !== undefined &&
          (agendaKind === "deadline" ||
            (agendaKind === null &&
              workflow.type === WORK_OBLIGATION_TYPE.DEADLINE));
        const nextLegacyHardDeadlineDate = updatesLegacyDeadline
          ? body.dueDate
          : undefined;
        const statusTransition = resolveWorkflowStatusTransition({
          governedWorkflow: features.governedWorkflow,
          requestedStatus: body.status,
          userId,
          workflow,
          workflowReason,
        });

        if (statusTransition.type === "transition") {
          const { action, eventType, nextStatus } = statusTransition;
          workflowAuditAction = WORK_OBLIGATION_TRANSITION_AUDIT_ACTION[action];
          workflowSet.status = nextStatus;
          if (nextStatus === WORK_OBLIGATION_STATUS.UNASSIGNED) {
            workflowSet.acknowledgedAt = null;
            workflowSet.acknowledgedByUserId = null;
          }
          workflowChanges["status"] = {
            old: workflow.status,
            new: nextStatus,
          };
          workflowEvents.push({
            id: createSafeId<"workObligationEvent">(),
            workspaceId,
            obligationEntityId: body.taskId,
            actorUserId: userId,
            type: eventType,
            details: {
              type: "status_changed",
              previousStatus: workflow.status,
              nextStatus,
            },
            reason: workflowReason ?? null,
            occurredAt: now,
          });
        }

        if (
          body.dueDate !== undefined &&
          body.dueDate !== workflow.workingTargetDate
        ) {
          if (
            body.dueDate !== null &&
            workflow.hardDeadlineDate !== null &&
            !updatesLegacyDeadline &&
            body.dueDate > workflow.hardDeadlineDate
          ) {
            throw new HandlerError({
              status: 400,
              message: "Working target cannot be after the hard deadline",
            });
          }
          workflowSet.workingTargetDate = body.dueDate;
          workflowChanges["workingTargetDate"] = {
            old: workflow.workingTargetDate,
            new: body.dueDate,
          };
          workflowEvents.push({
            id: createSafeId<"workObligationEvent">(),
            workspaceId,
            obligationEntityId: body.taskId,
            actorUserId: userId,
            type: WORK_OBLIGATION_EVENT_TYPE.WORKING_TARGET_CHANGED,
            details: {
              type: "date_changed",
              field: "working_target_date",
              previousDate: workflow.workingTargetDate,
              nextDate: body.dueDate,
            },
            reason: workflowReason ?? null,
            occurredAt: now,
          });
        }

        if (
          nextLegacyHardDeadlineDate !== undefined &&
          nextLegacyHardDeadlineDate !== workflow.hardDeadlineDate
        ) {
          workflowSet.hardDeadlineDate = nextLegacyHardDeadlineDate;
          workflowChanges["hardDeadlineDate"] = {
            old: workflow.hardDeadlineDate,
            new: nextLegacyHardDeadlineDate,
          };
          workflowEvents.push({
            id: createSafeId<"workObligationEvent">(),
            workspaceId,
            obligationEntityId: body.taskId,
            actorUserId: userId,
            type: WORK_OBLIGATION_EVENT_TYPE.HARD_DEADLINE_CHANGED,
            details: {
              type: "date_changed",
              field: "hard_deadline_date",
              previousDate: workflow.hardDeadlineDate,
              nextDate: nextLegacyHardDeadlineDate,
            },
            reason: workflowReason ?? null,
            occurredAt: now,
          });
        }

        let nextType: "task" | "deadline" | undefined;
        if (agendaKind === "deadline") {
          nextType = WORK_OBLIGATION_TYPE.DEADLINE;
        } else if (agendaKind === "task") {
          nextType = WORK_OBLIGATION_TYPE.TASK;
        }
        if (nextType !== undefined && nextType !== workflow.type) {
          workflowSet.type = nextType;
          workflowChanges["type"] = { old: workflow.type, new: nextType };
          workflowEvents.push({
            id: createSafeId<"workObligationEvent">(),
            workspaceId,
            obligationEntityId: body.taskId,
            actorUserId: userId,
            type: WORK_OBLIGATION_EVENT_TYPE.TYPE_CHANGED,
            details: {
              type: "obligation_type_changed",
              previousType: workflow.type,
              nextType,
            },
            reason: workflowReason ?? null,
            occurredAt: now,
          });
        }
      }

      const values = taskUpdateValues({
        agendaFields,
        agendaKind,
        body,
        listItemType,
      });
      // The row as it stands, locked for the update that follows, so the audit
      // entry can carry old/new pairs like every other update handler does
      // instead of a bare "updated".
      const before = (
        await tx
          .select()
          .from(entities)
          .where(
            and(
              eq(entities.id, body.taskId),
              eq(entities.workspaceId, workspaceId),
              eq(entities.kind, "task"),
            ),
          )
          .limit(1)
          .for("update")
      ).at(0);
      const rows = await tx
        .update(entities)
        .set({ ...values, updatedAt: now })
        .where(
          and(
            eq(entities.id, body.taskId),
            eq(entities.workspaceId, workspaceId),
            eq(entities.kind, "task"),
            eq(entities.readOnly, false),
          ),
        )
        .returning({ id: entities.id });

      if (rows.length > 0) {
        if (workflow && workflowEvents.length > 0) {
          const workflowRows = await tx
            .update(workObligations)
            .set({ ...workflowSet, updatedAt: now })
            .where(
              and(
                eq(workObligations.entityId, body.taskId),
                eq(workObligations.workspaceId, workspaceId),
                eq(workObligations.status, workflow.status),
              ),
            )
            .returning({ entityId: workObligations.entityId });
          if (!workflowRows.at(0)) {
            panic("Locked work obligation changed before compatibility update");
          }
          await tx.insert(workObligationEvents).values(workflowEvents);
          await recordAuditEvent(tx, {
            action: workflowAuditAction,
            resourceType: AUDIT_RESOURCE_TYPE.WORK_OBLIGATION,
            resourceId: body.taskId,
            changes: workflowChanges,
            ...(workflowReason ? { metadata: { reason: workflowReason } } : {}),
          });
        }

        await applyListItemTypeTransition({
          entityId: body.taskId,
          recordAuditEvent,
          transition: eligibility,
          tx,
          workspaceId,
        });

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
          resourceId: body.taskId,
          changes: before === undefined ? null : taskFieldDiffs(before, values),
          metadata: { kind: "task" },
        });
      }

      return { type: "updated" as const, rows };
    }),
  );

  if (txResult.type === "gate") {
    return Result.ok(
      applyTaskUpdateOutcome({ type: "gate", decision: txResult.decision }),
    );
  }

  const updated = txResult.rows;

  if (updated.length === 0) {
    const [task] = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({ readOnly: entities.readOnly })
          .from(entities)
          .where(
            and(
              eq(entities.id, body.taskId),
              eq(entities.workspaceId, workspaceId),
              eq(entities.kind, "task"),
            ),
          )
          .limit(1),
      ),
    );

    if (task?.readOnly) {
      return Result.err(
        new HandlerError({ status: 409, message: "Task is read-only" }),
      );
    }

    return Result.err(
      new HandlerError({ status: 404, message: "Task not found" }),
    );
  }

  return Result.ok(applyTaskUpdateOutcome({ type: "updated" }));
};

// Shared task-update logic reused by the HTTP handler and the
// `save_task` MCP tool, so both emit identical audit events.
export const updateTaskHandler = async function* ({
  features = deployedTaskFeatures(),
  decideGate = decideGateForTask,
  ...props
}: UpdateTaskHandlerProps) {
  const first = yield* applyTaskUpdate({ ...props, features });
  if (Result.isError(first)) {
    return first;
  }
  if (first.value.type === "updated") {
    return Result.ok({ success: true });
  }
  // A closing status on the task a workflow review gate raised is the gate's
  // decision; the run settles the task, and the rest of the change applies
  // as usual.
  yield* Result.await(
    decideGate({
      safeDb: props.safeDb,
      workspaceId: props.workspaceId,
      taskEntityId: props.body.taskId,
      userId: props.userId,
      decision: first.value.decision,
      note: props.body.workflowReason?.trim() ?? null,
      recordAuditEvent: props.recordAuditEvent,
    }),
  );
  const { status: _decided, ...rest } = props.body;
  const second = yield* applyTaskUpdate({ ...props, body: rest, features });
  if (Result.isError(second)) {
    return second;
  }
  return Result.ok({ success: true });
};
