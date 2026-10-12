import { EventType } from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai";
import { panic } from "better-result";

import type {
  ChatTurnFailureCode,
  ChatTurnStatus,
} from "@/api/handlers/chat/chat-turn-state";
import type { ChatPart, ChatTurnOutcome } from "@/api/handlers/chat/types";
import { CHAT_ORACLE, violationsOf } from "@/api/tests/helpers/chat-oracles";
import type { OracleViolation } from "@/api/tests/helpers/chat-oracles";

// A settled turn measured against what its run showed the user. The status a
// turn settles with is the product's claim about the run (it answered, it
// failed, it waits on the user); these checks hold that claim to the parts
// the run added to the message it wrote and to the stream the page read.
// The reading of "visible" here is the test's own, written from what the
// page renders, not a copy of the production reading it checks.

/**
 * What each stored part shows the user. `text` shows only when it holds more
 * than whitespace; `call` is a tool call, new when its id is; `content` is
 * anything else the page renders as the answer. Reasoning renders behind a
 * disclosure and is not an answer, and a tool result belongs to its call.
 */
const PART_VISIBILITY = {
  activity: "none",
  audio: "content",
  document: "content",
  image: "content",
  "structured-output": "content",
  subagent: "content",
  text: "text",
  thinking: "none",
  "tool-call": "call",
  "tool-result": "none",
  "ui-resource": "content",
  video: "content",
} as const satisfies Record<
  ChatPart["type"],
  "call" | "content" | "none" | "text"
>;

const contentKey = (part: ChatPart): string => JSON.stringify(part);

/**
 * The visible parts `after` holds that `before` did not: a tool call by id,
 * text and other content by what it holds, so a continuation's message,
 * which already holds the call the user answered, adds only what its run
 * wrote.
 */
export const addedVisibleParts = ({
  after,
  before,
}: {
  after: readonly ChatPart[];
  before: readonly ChatPart[];
}): ChatPart[] => {
  const heldCalls = new Set<string>();
  const held = new Map<string, number>();
  for (const part of before) {
    if (part.type === "tool-call") {
      heldCalls.add(part.id);
      continue;
    }
    const key = contentKey(part);
    held.set(key, (held.get(key) ?? 0) + 1);
  }
  return after.filter((part) => {
    const visibility = PART_VISIBILITY[part.type];
    switch (visibility) {
      case "none":
        return false;
      case "call":
        return part.type === "tool-call" && !heldCalls.has(part.id);
      case "text":
      case "content": {
        const key = contentKey(part);
        const count = held.get(key) ?? 0;
        if (count > 0) {
          held.set(key, count - 1);
          return false;
        }
        return (
          visibility === "content" ||
          (part.type === "text" && part.content.trim().length > 0)
        );
      }
      default:
        visibility satisfies never;
        return panic(`Unhandled visibility: ${String(visibility)}`);
    }
  });
};

/**
 * What a settled status claims about the run: that it added an answer
 * (`answered`), that the user sees an error (`failed`), or nothing the run's
 * parts can confirm (a turn waiting on the user holds the card it waits on,
 * which `chat.persisted.pending-owned` checks; a stopped or interrupted turn
 * keeps whatever it wrote). A status still writing its message has settled
 * nothing yet (`chat.persisted.turn-settles`). Keyed by every status, so a
 * new one fails typecheck here until its claim is chosen.
 */
export const TURN_STATUS_CLAIM = {
  accepted: "unsettled",
  running: "unsettled",
  "awaiting-user": "none",
  completed: "answered",
  failed: "failed",
  cancelled: "none",
  interrupted: "none",
} as const satisfies Record<
  ChatTurnStatus,
  "answered" | "failed" | "none" | "unsettled"
>;

/** A turn row as its request left it. */
export type SettledTurnRow = {
  assistantMessageId: string | null;
  failureCode: ChatTurnFailureCode | null;
  failureRetryable: boolean | null;
  id: string;
  status: ChatTurnStatus;
};

/** How the page's read of the response ended (`RecordedExchange["ended"]`). */
type ResponseEnding =
  | "complete"
  | "connection-lost"
  | "disconnected"
  | "stopped";

/**
 * Whether a chunk ends its run for good: a run error, or a finish that is
 * not the end of one model call of a tool cycle. The engine closes each
 * such call with a `tool_calls` finish under the same run and goes on, so
 * those may come before the end; nothing may follow a final one.
 */
const isFinalTerminal = (chunk: StreamChunk): boolean => {
  if (chunk.type === EventType.RUN_ERROR) {
    return true;
  }
  if (chunk.type !== EventType.RUN_FINISHED) {
    return false;
  }
  return chunk.outcome !== undefined || chunk.finishReason !== "tool_calls";
};

/**
 * `chat.turn.one-terminal`: a response read to its end with no Stop ends
 * each run it starts exactly once, with a final terminal event
 * (`isFinalTerminal`), before the next run starts (a fallback attempt is a
 * run of its own); ends on one; and reports an error exactly when its turn
 * failed, as its last event. A request that fails before any run starts
 * reports its error alone.
 */
const findTerminalViolations = ({
  chunks,
  ended,
  turn,
}: {
  chunks: readonly StreamChunk[];
  ended: ResponseEnding;
  turn: SettledTurnRow;
}): unknown[] => {
  if (ended !== "complete" || TURN_STATUS_CLAIM[turn.status] === "unsettled") {
    return [];
  }
  const findings: unknown[] = [];
  let open: string | null = null;
  for (const [index, chunk] of chunks.entries()) {
    if (chunk.type === EventType.RUN_STARTED) {
      if (open !== null) {
        findings.push({ runStartedWhileOpen: open, index, turnId: turn.id });
      }
      open = chunk.runId;
    } else if (
      chunk.type === EventType.RUN_FINISHED ||
      chunk.type === EventType.RUN_ERROR
    ) {
      // A request can fail before any run starts: its error closes none.
      if (open === null && chunk.type === EventType.RUN_FINISHED) {
        findings.push({
          terminalOfNoOpenRun: chunk.type,
          index,
          turnId: turn.id,
        });
      } else if (isFinalTerminal(chunk)) {
        open = null;
      }
    }
  }
  const last = chunks.at(-1);
  if (last === undefined || !isFinalTerminal(last) || open !== null) {
    findings.push({ lastEvent: last?.type ?? null, open, turnId: turn.id });
  }
  const errors = chunks.filter(({ type }) => type === EventType.RUN_ERROR);
  if (
    errors.length > 1 ||
    (errors.length === 1 && last?.type !== EventType.RUN_ERROR)
  ) {
    findings.push({ runErrors: errors.length, turnId: turn.id });
  }
  const reportedError = errors.length > 0;
  if (reportedError !== (turn.status === "failed")) {
    findings.push({ reportedError, status: turn.status, turnId: turn.id });
  }
  return findings;
};

/**
 * Every way a settled turn disagrees with what its run showed:
 *
 * - `chat.turn.completed-shows-answer`: a completed turn's run added a
 *   visible part (text, a tool call, other content) to the message it wrote,
 *   measured against what that message held before the run.
 * - `chat.turn.empty-fails-retryably`: a turn that failed because its run
 *   answered nothing (an empty completion) settles as `empty-response`,
 *   retryable.
 * - `chat.turn.failed-shows-error`: a failed turn stores its failure on the
 *   message it names, and a reload of the thread shows it as an error.
 * - `chat.turn.one-terminal`: see `findTerminalViolations`.
 */
export const findTurnOutcomeViolations = ({
  after,
  before,
  chunks,
  ended,
  reloadShowsError,
  storedOutcome,
  turn,
}: {
  /** The parts of the message the turn names once it settled; null when it
   *  names none or the message is gone. */
  after: readonly ChatPart[] | null;
  /** That message's parts before the request (empty for a new message). */
  before: readonly ChatPart[];
  /** The chunks the page read, when it read the response. */
  chunks: readonly StreamChunk[] | null;
  ended: ResponseEnding;
  /** Whether the reloaded thread shows the turn's message as failed. */
  reloadShowsError: boolean;
  /** The outcome the message stores. */
  storedOutcome: ChatTurnOutcome | undefined;
  turn: SettledTurnRow;
}): OracleViolation[] => {
  const added = addedVisibleParts({ after: after ?? [], before });
  const claim = TURN_STATUS_CLAIM[turn.status];
  const subject = { messageId: turn.assistantMessageId, turnId: turn.id };
  const terminal =
    chunks === null ? [] : findTerminalViolations({ chunks, ended, turn });
  switch (claim) {
    case "unsettled":
    case "none":
      return violationsOf(CHAT_ORACLE.turnOneTerminal, terminal);
    case "answered":
      return [
        ...violationsOf(
          CHAT_ORACLE.turnCompletedShowsAnswer,
          added.length === 0 ? [{ ...subject, parts: after ?? [] }] : [],
        ),
        ...violationsOf(CHAT_ORACLE.turnOneTerminal, terminal),
      ];
    case "failed": {
      const emptyCompletion =
        storedOutcome?.type === "failed" &&
        storedOutcome.error === "empty_completion";
      // A run that answered nothing fails as an empty completion; any other
      // failure is the provider's, retryable or not by its kind.
      return [
        ...violationsOf(
          CHAT_ORACLE.turnEmptyFailsRetryably,
          emptyCompletion &&
            (turn.failureCode !== "empty-response" ||
              turn.failureRetryable !== true)
            ? [
                {
                  ...subject,
                  failureCode: turn.failureCode,
                  failureRetryable: turn.failureRetryable,
                },
              ]
            : [],
        ),
        ...violationsOf(
          CHAT_ORACLE.turnFailedShowsError,
          storedOutcome?.type === "failed" && reloadShowsError
            ? []
            : [{ ...subject, reloadShowsError, storedOutcome }],
        ),
        ...violationsOf(CHAT_ORACLE.turnOneTerminal, terminal),
      ];
    }
    default:
      claim satisfies never;
      return panic(`Unhandled claim: ${String(claim)}`);
  }
};

/** What a page shows of its latest answer: an error, or none. */
export type ShownOutcome = { error: boolean };

/**
 * `chat.turn.live-outcome-equals-reload`: the page that watched the turn
 * shows an error exactly when a reload of the thread does.
 */
export const findLiveOutcomeViolations = ({
  live,
  reload,
}: {
  live: ShownOutcome;
  reload: ShownOutcome;
}): OracleViolation[] =>
  violationsOf(
    CHAT_ORACLE.turnLiveOutcomeEqualsReload,
    live.error === reload.error ? [] : [{ live, reload }],
  );
