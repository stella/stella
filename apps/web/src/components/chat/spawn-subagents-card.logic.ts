import type {
  ChatUITools,
  RegisteredChatUIToolCallPart,
} from "@/components/chat/chat-ui-tools";

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

type SpawnSubagent =
  ChatUITools["spawn_subagents"]["input"]["subagents"][number];

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
      subagent.title,
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

const MASKED_IDENTIFIER = "[…]";
const UUID_IN_PROMPT =
  /\b[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\b/giu;
// Mask values labeled by the identifier naming conventions, including JSON
// and prose assignments, without removing ordinary legal references.
const LABELED_IDENTIFIER_IN_PROMPT =
  /\b((?:id|ID|[a-zA-Z][\w]*(?:Id|ID)|[a-zA-Z][\w]*_(?:id|ID))["']?\s*[:=]\s*)(?:\[…\]|"[^"\n]*"|'[^'\n]*'|[^\s,;.)}\]]+)/gu;

export const maskSubagentIdentifiers = (text: string) =>
  text
    .replace(UUID_IN_PROMPT, () => MASKED_IDENTIFIER)
    .replace(
      LABELED_IDENTIFIER_IN_PROMPT,
      (_match, prefix: string) => `${prefix}${MASKED_IDENTIFIER}`,
    );

const TITLE_CITATION_RUN =
  /§{1,2}\s*\p{N}+(?:[./:–—-]\p{N}+)*|\p{N}+(?:[./:–—-]\p{N}+)+/gu;

type SubagentTitleRun = {
  type: "text" | "citation";
  text: string;
  start: number;
};

/** Keep numerical legal references in their source order within RTL titles. */
export const subagentTitleRuns = (title: string) => {
  const runs: SubagentTitleRun[] = [];
  let start = 0;
  for (const match of title.matchAll(TITLE_CITATION_RUN)) {
    // SAFETY: A regex match always contains its full matched text at index zero.
    const citation = match[0];
    if (match.index > start) {
      runs.push({ type: "text", text: title.slice(start, match.index), start });
    }
    runs.push({ type: "citation", text: citation, start: match.index });
    start = match.index + citation.length;
  }
  if (start < title.length) {
    runs.push({ type: "text", text: title.slice(start), start });
  }
  return runs;
};
