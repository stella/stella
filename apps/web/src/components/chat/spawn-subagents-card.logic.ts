import type { RegisteredChatUIToolCallPart } from "@/components/chat/chat-ui-tools";

export type SpawnSubagentsToolCallState = Extract<
  RegisteredChatUIToolCallPart,
  { name: "spawn_subagents" }
>["state"];

export const SPAWN_SUBAGENTS_CALL_STATUS = {
  awaitingApproval: "awaitingApproval",
  running: "running",
  declined: "declined",
  done: "done",
  failed: "failed",
} as const;

export type SpawnSubagentsCallStatus =
  (typeof SPAWN_SUBAGENTS_CALL_STATUS)[keyof typeof SPAWN_SUBAGENTS_CALL_STATUS];

// `approval-requested` waits on the user, so nothing executes yet;
// `approval-responded` hands off into execution unless the answer was a
// decline (see `getSpawnSubagentsCallStatus`). `error` is terminal: a call
// hydrated in that state never produces output.
export const SPAWN_SUBAGENTS_CALL_STATUS_BY_STATE = {
  "awaiting-input": SPAWN_SUBAGENTS_CALL_STATUS.running,
  "input-streaming": SPAWN_SUBAGENTS_CALL_STATUS.running,
  "input-complete": SPAWN_SUBAGENTS_CALL_STATUS.running,
  "approval-requested": SPAWN_SUBAGENTS_CALL_STATUS.awaitingApproval,
  "approval-responded": SPAWN_SUBAGENTS_CALL_STATUS.running,
  complete: SPAWN_SUBAGENTS_CALL_STATUS.done,
  error: SPAWN_SUBAGENTS_CALL_STATUS.failed,
} as const satisfies Record<
  SpawnSubagentsToolCallState,
  SpawnSubagentsCallStatus
>;

type SpawnSubagentsCallStatusInput = {
  /** The user's answer, once an approval was responded to. */
  approval?: { approved?: boolean | undefined } | undefined;
  state: SpawnSubagentsToolCallState;
};

/**
 * A declined approval is `approval-responded` with `approved: false`, and it
 * stays in that state for good: nothing runs after it, so it must not read as
 * execution in progress.
 */
export const getSpawnSubagentsCallStatus = ({
  approval,
  state,
}: SpawnSubagentsCallStatusInput): SpawnSubagentsCallStatus =>
  state === "approval-responded" && approval?.approved === false
    ? SPAWN_SUBAGENTS_CALL_STATUS.declined
    : SPAWN_SUBAGENTS_CALL_STATUS_BY_STATE[state];

// Historical persisted tool-call arguments can contain provider-emitted nulls.
type SpawnSubagent = {
  task: string;
  context?: string | null | undefined;
  expectedOutput?: string | null | undefined;
  model?: string | null | undefined;
};

export type KeyedSpawnSubagent<T extends SpawnSubagent> = {
  index: number;
  key: string;
  subagent: T;
};

export const keySpawnSubagents = <T extends SpawnSubagent>(
  subagents: readonly T[],
): KeyedSpawnSubagent<T>[] => {
  const occurrences = new Map<string, number>();

  return subagents.map((subagent, index) => {
    const identity = JSON.stringify([
      subagent.task,
      subagent.context ?? null,
      subagent.expectedOutput ?? null,
      subagent.model ?? null,
    ]);
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);

    return {
      index,
      key: `${identity}:${String(occurrence)}`,
      subagent,
    };
  });
};
