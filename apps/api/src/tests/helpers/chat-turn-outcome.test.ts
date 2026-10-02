import { EventType } from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai";
import { describe, expect, test } from "bun:test";

import type { ChatPart } from "@/api/handlers/chat/types";
import { CHAT_ORACLE } from "@/api/tests/helpers/chat-oracles";
import {
  addedVisibleParts,
  findLiveOutcomeViolations,
  findTurnOutcomeViolations,
} from "@/api/tests/helpers/chat-turn-outcome";
import type { SettledTurnRow } from "@/api/tests/helpers/chat-turn-outcome";

// The settled-turn oracles on turns built to break each one, and on the
// sound turn each broken one differs from.

const CARD = {
  arguments: "{}",
  id: "call-1",
  input: {},
  name: "ask-user",
  output: { answers: [] },
  state: "complete",
  type: "tool-call",
} as const satisfies ChatPart;
const RESULT = {
  content: "{}",
  state: "complete",
  toolCallId: "call-1",
  type: "tool-result",
} as const satisfies ChatPart;
const THINKING = {
  content: "The user wants a draft.",
  type: "thinking",
} as const satisfies ChatPart;
const text = (content: string): ChatPart => ({ content, type: "text" });

const row = (patch: Partial<SettledTurnRow>): SettledTurnRow => ({
  assistantMessageId: "message-1",
  failureCode: null,
  failureRetryable: null,
  id: "turn-1",
  status: "completed",
  ...patch,
});

const finished: StreamChunk[] = [
  { runId: "run", threadId: "thread", type: EventType.RUN_STARTED },
  { runId: "run", threadId: "thread", type: EventType.RUN_FINISHED },
];
const errored: StreamChunk[] = [
  { runId: "run", threadId: "thread", type: EventType.RUN_STARTED },
  { message: "Empty", type: EventType.RUN_ERROR },
];

const oraclesOf = (
  options: Partial<Parameters<typeof findTurnOutcomeViolations>[0]>,
) =>
  findTurnOutcomeViolations({
    after: [text("Here is the draft.")],
    before: [],
    chunks: finished,
    ended: "complete",
    reloadShowsError: false,
    storedOutcome: { type: "completed" },
    turn: row({}),
    ...options,
  })
    .map(({ oracle }) => oracle)
    .filter((oracle, index, all) => all.indexOf(oracle) === index);

describe("what a run added that the user sees", () => {
  test("a continuation's answered card and its result are not the run's", () => {
    expect(
      addedVisibleParts({ after: [CARD, RESULT], before: [CARD] }),
    ).toEqual([]);
    expect(
      addedVisibleParts({
        after: [CARD, RESULT, text("Done.")],
        before: [CARD],
      }),
    ).toEqual([text("Done.")]);
  });

  test("reasoning and whitespace are not an answer; a new call is", () => {
    expect(
      addedVisibleParts({ after: [THINKING, text(" \n ")], before: [] }),
    ).toEqual([]);
    expect(
      addedVisibleParts({
        after: [CARD, { ...CARD, id: "call-2" }],
        before: [CARD],
      }),
    ).toEqual([{ ...CARD, id: "call-2" }]);
  });

  test("text the message already held is matched by what it holds", () => {
    expect(
      addedVisibleParts({
        after: [text("Hello."), text("Hello.")],
        before: [text("Hello.")],
      }),
    ).toEqual([text("Hello.")]);
  });
});

describe("a settled turn against what it showed", () => {
  test("a completed turn that answered is sound", () => {
    expect(oraclesOf({})).toEqual([]);
  });

  test("a completed continuation that added nothing breaks completed-shows-answer", () => {
    expect(
      oraclesOf({ after: [CARD, RESULT, THINKING], before: [CARD] }),
    ).toEqual([CHAT_ORACLE.turnCompletedShowsAnswer]);
  });

  test("an empty completion must settle as a retryable empty response", () => {
    const failed = {
      after: [],
      chunks: errored,
      reloadShowsError: true,
      storedOutcome: { error: "empty_completion", type: "failed" },
    } as const;
    expect(
      oraclesOf({
        ...failed,
        turn: row({
          failureCode: "empty-response",
          failureRetryable: true,
          status: "failed",
        }),
      }),
    ).toEqual([]);
    expect(
      oraclesOf({
        ...failed,
        turn: row({
          failureCode: "provider-error",
          failureRetryable: true,
          status: "failed",
        }),
      }),
    ).toEqual([CHAT_ORACLE.turnEmptyFailsRetryably]);
    expect(
      oraclesOf({
        ...failed,
        turn: row({
          failureCode: "empty-response",
          failureRetryable: false,
          status: "failed",
        }),
      }),
    ).toEqual([CHAT_ORACLE.turnEmptyFailsRetryably]);
  });

  test("a provider's failure keeps its own retryability", () => {
    expect(
      oraclesOf({
        after: [],
        chunks: errored,
        reloadShowsError: true,
        storedOutcome: { error: "model_unavailable", type: "failed" },
        turn: row({
          failureCode: "provider-error",
          failureRetryable: false,
          status: "failed",
        }),
      }),
    ).toEqual([]);
  });

  test("a failure the reload does not show breaks failed-shows-error", () => {
    const turn = row({
      failureCode: "provider-error",
      failureRetryable: true,
      status: "failed",
    });
    expect(
      oraclesOf({
        chunks: errored,
        reloadShowsError: false,
        storedOutcome: { error: "unknown", type: "failed" },
        turn,
      }),
    ).toEqual([CHAT_ORACLE.turnFailedShowsError]);
    expect(
      oraclesOf({
        chunks: errored,
        reloadShowsError: true,
        storedOutcome: { type: "completed" },
        turn,
      }),
    ).toEqual([CHAT_ORACLE.turnFailedShowsError]);
  });

  test("a response must end in one terminal event that matches the turn", () => {
    // No terminal event at all.
    expect(oraclesOf({ chunks: finished.slice(0, 1) })).toEqual([
      CHAT_ORACLE.turnOneTerminal,
    ]);
    // A run error on a turn that completed, and events after it.
    expect(oraclesOf({ chunks: [...errored, ...finished.slice(1)] })).toEqual([
      CHAT_ORACLE.turnOneTerminal,
    ]);
    // Two run errors.
    expect(
      oraclesOf({
        chunks: [...errored, ...errored.slice(1)],
        reloadShowsError: true,
        storedOutcome: { error: "unknown", type: "failed" },
        turn: row({
          failureCode: "provider-error",
          failureRetryable: true,
          status: "failed",
        }),
      }),
    ).toEqual([CHAT_ORACLE.turnOneTerminal]);
    // Two finishes of one run.
    expect(oraclesOf({ chunks: [...finished, ...finished.slice(1)] })).toEqual([
      CHAT_ORACLE.turnOneTerminal,
    ]);
    // A tool cycle: each model call finishes with its calls, then the run.
    expect(
      oraclesOf({
        chunks: [
          ...finished.slice(0, 1),
          {
            finishReason: "tool_calls",
            runId: "run",
            threadId: "thread",
            type: EventType.RUN_FINISHED,
          },
          ...finished.slice(1),
        ],
      }),
    ).toEqual([]);
    // A fallback attempt: the chat model's run, then the fallback's own.
    expect(
      oraclesOf({
        chunks: [
          ...finished,
          {
            runId: "fallback",
            threadId: "thread",
            type: EventType.RUN_STARTED,
          },
          {
            runId: "fallback",
            threadId: "thread",
            type: EventType.RUN_FINISHED,
          },
        ],
      }),
    ).toEqual([]);
    // A response the page stopped reading is not held to it.
    expect(
      oraclesOf({ chunks: finished.slice(0, 1), ended: "stopped" }),
    ).toEqual([]);
  });

  test("a turn that waits on the user, or was stopped, claims no answer", () => {
    for (const status of [
      "awaiting-user",
      "cancelled",
      "interrupted",
    ] as const) {
      expect(
        oraclesOf({ after: [CARD], before: [CARD], turn: row({ status }) }),
      ).toEqual([]);
    }
  });
});

describe("what the page shows against a reload", () => {
  test("an error shown live must show on reload, and the reverse", () => {
    expect(
      findLiveOutcomeViolations({
        live: { error: true },
        reload: { error: true },
      }),
    ).toEqual([]);
    expect(
      findLiveOutcomeViolations({
        live: { error: false },
        reload: { error: true },
      }).map(({ oracle }) => oracle),
    ).toEqual([CHAT_ORACLE.turnLiveOutcomeEqualsReload]);
  });
});
