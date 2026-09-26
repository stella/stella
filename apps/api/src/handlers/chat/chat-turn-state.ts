import { panic } from "better-result";

import type { PermissionInput } from "@stll/permissions";

import type { SafeId } from "@/api/lib/branded-types";

/** Whoever may start a turn in a thread may also stop it. */
export const CHAT_TURN_PERMISSIONS = {
  chat: ["create"],
} satisfies PermissionInput;

export const CHAT_TURN_STATUSES = [
  "accepted",
  "running",
  "awaiting-user",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
] as const;
export type ChatTurnStatus = (typeof CHAT_TURN_STATUSES)[number];

/** The statuses of a turn not yet settled; a thread holds at most one. */
export const ACTIVE_CHAT_TURN_STATUSES = [
  "accepted",
  "running",
  "awaiting-user",
] as const satisfies readonly ChatTurnStatus[];

export const CHAT_TURN_INTERACTION_TYPES = [
  "ask-user",
  "approval",
  "client-tool",
] as const;
export type ChatTurnInteractionType =
  (typeof CHAT_TURN_INTERACTION_TYPES)[number];

export const CHAT_TURN_FAILURE_CODES = [
  "boundary-refusal",
  "connector-discovery",
  "empty-response",
  "internal",
  "persistence",
  "provider-error",
  "unsupported-input",
] as const;
export type ChatTurnFailureCode = (typeof CHAT_TURN_FAILURE_CODES)[number];

export const CHAT_TURN_CANCELLATION_REASONS = [
  "superseded",
  "user-stop",
] as const;
export type ChatTurnCancellationReason =
  (typeof CHAT_TURN_CANCELLATION_REASONS)[number];

export const CHAT_TURN_INTERRUPTION_REASONS = [
  "client-disconnected",
  "timeout",
] as const;
type ChatTurnInterruptionReason =
  (typeof CHAT_TURN_INTERRUPTION_REASONS)[number];

export type ChatTurnState =
  | {
      id: SafeId<"chatTurn">;
      leaseExpiresAt: Date;
      status: "accepted";
      threadId: SafeId<"chatThread">;
      userMessageId: SafeId<"chatMessage">;
    }
  | {
      executionId: string;
      id: SafeId<"chatTurn">;
      leaseExpiresAt: Date;
      status: "running";
      threadId: SafeId<"chatThread">;
      userMessageId: SafeId<"chatMessage">;
    }
  | {
      assistantMessageId: SafeId<"chatMessage">;
      id: SafeId<"chatTurn">;
      interaction: {
        toolCallId: string;
        type: ChatTurnInteractionType;
      };
      status: "awaiting-user";
      threadId: SafeId<"chatThread">;
      userMessageId: SafeId<"chatMessage">;
    }
  | {
      assistantMessageId: SafeId<"chatMessage">;
      completedAt: Date;
      id: SafeId<"chatTurn">;
      status: "completed";
      threadId: SafeId<"chatThread">;
      userMessageId: SafeId<"chatMessage">;
    }
  | {
      assistantMessageId: SafeId<"chatMessage">;
      failedAt: Date;
      failure: {
        code: ChatTurnFailureCode;
        retryable: boolean;
      };
      id: SafeId<"chatTurn">;
      status: "failed";
      threadId: SafeId<"chatThread">;
      userMessageId: SafeId<"chatMessage">;
    }
  | {
      cancelledAt: Date;
      id: SafeId<"chatTurn">;
      reason: ChatTurnCancellationReason;
      status: "cancelled";
      threadId: SafeId<"chatThread">;
      userMessageId: SafeId<"chatMessage">;
    }
  | {
      id: SafeId<"chatTurn">;
      interruptedAt: Date;
      reason: ChatTurnInterruptionReason;
      status: "interrupted";
      threadId: SafeId<"chatThread">;
      userMessageId: SafeId<"chatMessage">;
    };

/** A turn as a client may read it back: its status, and why a cancelled or
 *  interrupted turn ended. */
export type ChatTurnView =
  | {
      id: SafeId<"chatTurn">;
      status: Exclude<ChatTurnStatus, "cancelled" | "interrupted">;
    }
  | {
      id: SafeId<"chatTurn">;
      reason: ChatTurnCancellationReason;
      status: "cancelled";
    }
  | {
      id: SafeId<"chatTurn">;
      reason: ChatTurnInterruptionReason;
      status: "interrupted";
    };

export const chatTurnViewOf = (state: ChatTurnState): ChatTurnView => {
  switch (state.status) {
    case "cancelled":
      return { id: state.id, reason: state.reason, status: state.status };
    case "interrupted":
      return { id: state.id, reason: state.reason, status: state.status };
    case "accepted":
    case "awaiting-user":
    case "completed":
    case "failed":
    case "running":
      return { id: state.id, status: state.status };
    default:
      state satisfies never;
      return panic(`Unhandled state: ${String(state)}`);
  }
};

export type ChatTurnTransition =
  | {
      executionId: string;
      leaseExpiresAt: Date;
      type: "start";
    }
  | {
      assistantMessageId: SafeId<"chatMessage">;
      interaction: {
        toolCallId: string;
        type: ChatTurnInteractionType;
      };
      type: "await-user";
    }
  | {
      assistantMessageId: SafeId<"chatMessage">;
      completedAt: Date;
      type: "complete";
    }
  | {
      assistantMessageId: SafeId<"chatMessage">;
      failedAt: Date;
      failure: {
        code: ChatTurnFailureCode;
        retryable: boolean;
      };
      type: "fail";
    }
  | {
      cancelledAt: Date;
      reason: ChatTurnCancellationReason;
      type: "cancel";
    }
  | {
      interruptedAt: Date;
      reason: ChatTurnInterruptionReason;
      type: "interrupt";
    }
  | {
      executionId: string;
      leaseExpiresAt: Date;
      type: "resume";
    };

export type ChatTurnTransitionResult =
  | { state: ChatTurnState; type: "applied" }
  | {
      from: ChatTurnStatus;
      transition: ChatTurnTransition["type"];
      type: "rejected";
    };

const rejectedTransition = (
  state: ChatTurnState,
  transition: ChatTurnTransition,
): ChatTurnTransitionResult => ({
  from: state.status,
  transition: transition.type,
  type: "rejected",
});

type ChatTurnIdentity = Pick<
  ChatTurnState,
  "id" | "threadId" | "userMessageId"
>;

type ChatTurnTransitionOf<Type extends ChatTurnTransition["type"]> = Extract<
  ChatTurnTransition,
  { type: Type }
>;

// The target states more than one source status reaches, each carrying the
// turn's identity forward unchanged.
const runningTurn = (
  state: ChatTurnIdentity,
  transition: ChatTurnTransitionOf<"resume" | "start">,
): ChatTurnTransitionResult => ({
  state: {
    executionId: transition.executionId,
    id: state.id,
    leaseExpiresAt: transition.leaseExpiresAt,
    status: "running",
    threadId: state.threadId,
    userMessageId: state.userMessageId,
  },
  type: "applied",
});

const failedTurn = (
  state: ChatTurnIdentity,
  transition: ChatTurnTransitionOf<"fail">,
): ChatTurnTransitionResult => ({
  state: {
    assistantMessageId: transition.assistantMessageId,
    failedAt: transition.failedAt,
    failure: transition.failure,
    id: state.id,
    status: "failed",
    threadId: state.threadId,
    userMessageId: state.userMessageId,
  },
  type: "applied",
});

const cancelledTurn = (
  state: ChatTurnIdentity,
  transition: ChatTurnTransitionOf<"cancel">,
): ChatTurnTransitionResult => ({
  state: {
    cancelledAt: transition.cancelledAt,
    id: state.id,
    reason: transition.reason,
    status: "cancelled",
    threadId: state.threadId,
    userMessageId: state.userMessageId,
  },
  type: "applied",
});

const interruptedTurn = (
  state: ChatTurnIdentity,
  transition: ChatTurnTransitionOf<"interrupt">,
): ChatTurnTransitionResult => ({
  state: {
    id: state.id,
    interruptedAt: transition.interruptedAt,
    reason: transition.reason,
    status: "interrupted",
    threadId: state.threadId,
    userMessageId: state.userMessageId,
  },
  type: "applied",
});

/**
 * Pure lifecycle planner. Persistence must apply the returned branch with a
 * compare-and-set on the source status; this function deliberately never
 * reopens a terminal turn. A retry is a new turn linked by the caller.
 */
export const planChatTurnTransition = (
  state: ChatTurnState,
  transition: ChatTurnTransition,
): ChatTurnTransitionResult => {
  switch (state.status) {
    case "accepted":
      switch (transition.type) {
        case "start":
          return runningTurn(state, transition);
        case "fail":
          return failedTurn(state, transition);
        case "cancel":
          return cancelledTurn(state, transition);
        case "interrupt":
          return interruptedTurn(state, transition);
        case "await-user":
        case "complete":
        case "resume":
          return rejectedTransition(state, transition);
        default:
          transition satisfies never;
          return panic(`Unhandled transition: ${String(transition)}`);
      }
    case "running":
      switch (transition.type) {
        case "await-user":
          return {
            state: {
              assistantMessageId: transition.assistantMessageId,
              id: state.id,
              interaction: transition.interaction,
              status: "awaiting-user",
              threadId: state.threadId,
              userMessageId: state.userMessageId,
            },
            type: "applied",
          };
        case "complete":
          return {
            state: {
              assistantMessageId: transition.assistantMessageId,
              completedAt: transition.completedAt,
              id: state.id,
              status: "completed",
              threadId: state.threadId,
              userMessageId: state.userMessageId,
            },
            type: "applied",
          };
        case "fail":
          return failedTurn(state, transition);
        case "cancel":
          return cancelledTurn(state, transition);
        case "interrupt":
          return interruptedTurn(state, transition);
        case "resume":
        case "start":
          return rejectedTransition(state, transition);
        default:
          transition satisfies never;
          return panic(`Unhandled transition: ${String(transition)}`);
      }
    case "awaiting-user":
      switch (transition.type) {
        case "resume":
          return runningTurn(state, transition);
        case "cancel":
          return cancelledTurn(state, transition);
        case "await-user":
        case "complete":
        case "fail":
        case "interrupt":
        case "start":
          return rejectedTransition(state, transition);
        default:
          transition satisfies never;
          return panic(`Unhandled transition: ${String(transition)}`);
      }
    case "cancelled":
    case "completed":
    case "failed":
    case "interrupted":
      return rejectedTransition(state, transition);
    default:
      state satisfies never;
      return panic(`Unhandled state: ${String(state)}`);
  }
};
