import {
  WORK_OBLIGATION_EVENT_TYPE,
  WORK_OBLIGATION_STATUS,
} from "@/api/db/schema";
import type { WorkObligationStatus } from "@/api/db/schema";
import { TASK_STATUS } from "@/api/lib/entity-constants";
import type { TaskStatus } from "@/api/lib/entity-constants";

/**
 * The governed-work lifecycle, declared once.
 *
 * Two entry points move an obligation: the explicit transition endpoint, and a
 * legacy task-status write (task API or `save_task`) that implies one. Both
 * read this table, so the allowed source statuses, the target status, the
 * lifecycle event and the mirrored legacy task status cannot drift apart.
 * Permissions, reason requirements, locking and event emission stay with each
 * caller: this module owns the transition data and the pure resolution only.
 */
export const WORK_OBLIGATION_TRANSITION_ACTION = {
  COMPLETE: "complete",
  CANCEL: "cancel",
  REOPEN: "reopen",
} as const;

export type WorkObligationTransitionAction =
  (typeof WORK_OBLIGATION_TRANSITION_ACTION)[keyof typeof WORK_OBLIGATION_TRANSITION_ACTION];

const defineTransitionActions = <
  const TActions extends readonly [
    WorkObligationTransitionAction,
    ...WorkObligationTransitionAction[],
  ],
>(
  actions: Exclude<
    WorkObligationTransitionAction,
    TActions[number]
  > extends never
    ? TActions
    : never,
) => Object.freeze(actions);

/** Non-empty ordered actions for iteration and request schemas. */
export const WORK_OBLIGATION_TRANSITION_ACTIONS = defineTransitionActions([
  WORK_OBLIGATION_TRANSITION_ACTION.COMPLETE,
  WORK_OBLIGATION_TRANSITION_ACTION.CANCEL,
  WORK_OBLIGATION_TRANSITION_ACTION.REOPEN,
]);

type LifecycleEventType =
  | typeof WORK_OBLIGATION_EVENT_TYPE.COMPLETED
  | typeof WORK_OBLIGATION_EVENT_TYPE.CANCELLED
  | typeof WORK_OBLIGATION_EVENT_TYPE.REOPENED;

type WorkObligationTransition = {
  from: readonly WorkObligationStatus[];
  to: WorkObligationStatus;
  eventType: LifecycleEventType;
  taskStatus: TaskStatus;
};

export const WORK_OBLIGATION_TRANSITIONS = {
  complete: {
    from: [WORK_OBLIGATION_STATUS.ACTIVE],
    to: WORK_OBLIGATION_STATUS.COMPLETED,
    eventType: WORK_OBLIGATION_EVENT_TYPE.COMPLETED,
    taskStatus: TASK_STATUS.DONE,
  },
  cancel: {
    from: [
      WORK_OBLIGATION_STATUS.UNASSIGNED,
      WORK_OBLIGATION_STATUS.AWAITING_ACKNOWLEDGEMENT,
      WORK_OBLIGATION_STATUS.ACTIVE,
    ],
    to: WORK_OBLIGATION_STATUS.CANCELLED,
    eventType: WORK_OBLIGATION_EVENT_TYPE.CANCELLED,
    taskStatus: TASK_STATUS.CANCELLED,
  },
  reopen: {
    from: [WORK_OBLIGATION_STATUS.COMPLETED, WORK_OBLIGATION_STATUS.CANCELLED],
    to: WORK_OBLIGATION_STATUS.ACTIVE,
    eventType: WORK_OBLIGATION_EVENT_TYPE.REOPENED,
    taskStatus: TASK_STATUS.IN_PROGRESS,
  },
} as const satisfies Record<
  WorkObligationTransitionAction,
  WorkObligationTransition
>;

/** Closed work is exactly the work reopening exists to bring back. */
const isClosedStatus = (status: WorkObligationStatus): boolean =>
  WORK_OBLIGATION_TRANSITIONS.reopen.from.some((from) => from === status);

/**
 * Ownership state decides where reopened work lands: the obligation returns to
 * the queue its owner and acknowledgement put it in, not to a fixed status.
 */
type WorkObligationOwnershipState = {
  acknowledgedAt: Date | null;
  ownerUserId: string | null;
};

export const reopenedWorkObligationStatus = ({
  acknowledgedAt,
  ownerUserId,
}: WorkObligationOwnershipState): WorkObligationStatus => {
  if (ownerUserId === null) {
    return WORK_OBLIGATION_STATUS.UNASSIGNED;
  }
  if (acknowledgedAt === null) {
    return WORK_OBLIGATION_STATUS.AWAITING_ACKNOWLEDGEMENT;
  }
  return WORK_OBLIGATION_STATUS.ACTIVE;
};

export const nextWorkObligationStatus = (
  action: WorkObligationTransitionAction,
  ownership: WorkObligationOwnershipState,
): WorkObligationStatus => {
  switch (action) {
    case WORK_OBLIGATION_TRANSITION_ACTION.COMPLETE:
    case WORK_OBLIGATION_TRANSITION_ACTION.CANCEL:
      return WORK_OBLIGATION_TRANSITIONS[action].to;
    case WORK_OBLIGATION_TRANSITION_ACTION.REOPEN:
      return reopenedWorkObligationStatus(ownership);
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
};

type WorkObligationState = WorkObligationOwnershipState & {
  status: WorkObligationStatus;
};

export type WorkObligationTransitionResolution =
  | {
      type: "allowed";
      eventType: LifecycleEventType;
      from: readonly WorkObligationStatus[];
      nextStatus: WorkObligationStatus;
      taskStatus: TaskStatus;
    }
  | { type: "invalid_status" };

export const resolveWorkObligationTransition = (
  action: WorkObligationTransitionAction,
  obligation: WorkObligationState,
): WorkObligationTransitionResolution => {
  const transition = WORK_OBLIGATION_TRANSITIONS[action];
  if (!transition.from.some((status) => status === obligation.status)) {
    return { type: "invalid_status" };
  }
  return {
    type: "allowed",
    eventType: transition.eventType,
    from: transition.from,
    nextStatus: nextWorkObligationStatus(action, obligation),
    taskStatus: transition.taskStatus,
  };
};

/**
 * A closing action is one whose target status can only be left by reopening,
 * so writing its legacy task status names that action outright. Every other
 * task status is an open one: it only means something to an obligation that is
 * currently closed, where it reads as a reopen.
 */
const closingActionForTaskStatus = (
  taskStatus: string,
): WorkObligationTransitionAction | undefined =>
  WORK_OBLIGATION_TRANSITION_ACTIONS.find((action) => {
    const transition = WORK_OBLIGATION_TRANSITIONS[action];
    return (
      transition.taskStatus === taskStatus && isClosedStatus(transition.to)
    );
  });

export type WorkObligationStatusIntent =
  | { type: "transition"; action: WorkObligationTransitionAction }
  | { type: "none" };

type WorkObligationStatusIntentOptions = {
  currentStatus: WorkObligationStatus;
  requestedTaskStatus: string | undefined;
};

/** The lifecycle action a legacy task-status write implies, if any. */
export const workObligationIntentForTaskStatus = ({
  currentStatus,
  requestedTaskStatus,
}: WorkObligationStatusIntentOptions): WorkObligationStatusIntent => {
  if (requestedTaskStatus === undefined) {
    return { type: "none" };
  }
  const closingAction = closingActionForTaskStatus(requestedTaskStatus);
  if (closingAction) {
    // Writing the status the obligation already carries is a no-op, not a
    // repeat transition, so it emits no event.
    return currentStatus === WORK_OBLIGATION_TRANSITIONS[closingAction].to
      ? { type: "none" }
      : { type: "transition", action: closingAction };
  }
  return isClosedStatus(currentStatus)
    ? { type: "transition", action: WORK_OBLIGATION_TRANSITION_ACTION.REOPEN }
    : { type: "none" };
};
