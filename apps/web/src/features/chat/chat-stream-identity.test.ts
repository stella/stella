import { EventType } from "@tanstack/ai";
import type { ModelMessage, StreamChunk } from "@tanstack/ai";
import { ChatClient, fetchServerSentEvents } from "@tanstack/ai-client";
import type { RunAgentInputContext, UIMessage } from "@tanstack/ai-client";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fc from "fast-check";

import { sleep } from "@stll/concurrency/sleep";
import { assertProperty } from "@stll/property-testing";

import {
  isCanonicalChatUIMessage,
  projectCanonicalChatUIMessages,
} from "@/components/chat/chat-ui-tools";
import type {
  ChatClientTools,
  ChatUIMessage,
  PersistedChatMessage,
} from "@/components/chat/chat-ui-tools";
import {
  toPersistedChatMessage,
  toPersistedChatMessages,
} from "@/features/chat/chat-persisted-messages";
import { keepShownRejoinMessages } from "@/features/chat/chat-rejoin-messages";
import {
  createChatRuntime,
  resetChatRequestStateForTests,
  sendThreadChatMessage,
} from "@/features/chat/chat-runtime";
import type { ChatRuntime } from "@/features/chat/chat-runtime";
import {
  keepPostedMessages,
  keepPostedMessagesInSnapshots,
  keepReasoningSteps,
} from "@/features/chat/chat-snapshot-history";
import { buildWireSnapshot } from "@/features/chat/chat-test-fixtures";
import { toChatThreadId } from "@/lib/chat-thread-ref";
import { toSafeId } from "@/lib/safe-id";

// A memoized message row or part card skips a render only when the chunk
// leaves its object as it was. These tests drive the SDK client the runtime
// uses and project its messages the way the page does, then check that a
// chunk replaces only what it changed and costs nothing for the rest.

const ANSWER_ID = "answer";
const REGENERATED_ID = "answer-regenerated";
const TOOL_NAME = "mcp__records__lookup";

/** The messages the page renders for one client emit: the runtime's
 *  projection, then the session's canonical check. */
const show = (messages: UIMessage<ChatClientTools>[]): ChatUIMessage[] =>
  projectCanonicalChatUIMessages(toPersistedChatMessages(messages));

/** Whether the cached projections of `messages` equal the projections
 *  computed afresh: the caches key on message objects, so this fails once
 *  any message changes in place. */
const matchesFreshProjection = (
  messages: readonly UIMessage<ChatClientTools>[],
): boolean => {
  const persisted = toPersistedChatMessages(messages);
  return (
    Bun.deepEquals(persisted, messages.map(toPersistedChatMessage), true) &&
    persisted.every(isCanonicalChatUIMessage)
  );
};

type WatchedMessage = { id: string; parts: readonly object[] };

/** Remembers every message, parts array and part the page received, and
 *  reports each one that later reappears with other contents. */
const createChangeWatch = () => {
  const seen = new WeakMap<object, string>();
  const changed: string[] = [];
  const watch = (label: string, value: object) => {
    const contents = JSON.stringify(value);
    const before = seen.get(value);
    if (before === undefined) {
      seen.set(value, contents);
    } else if (before !== contents) {
      changed.push(`${label} changed in place: ${before} -> ${contents}`);
    }
  };
  return {
    changed,
    observe: (messages: readonly WatchedMessage[]) => {
      for (const message of messages) {
        watch(`message ${message.id}`, message);
        watch(`parts of ${message.id}`, message.parts);
        for (const [index, part] of message.parts.entries()) {
          watch(`part ${String(index)} of ${message.id}`, part);
        }
      }
    },
  };
};

type ToolCallOp = { args: string[] };
type AnswerOp =
  | { kind: "reasoning"; delta: string }
  | { kind: "status" }
  | { kind: "snapshot" }
  | { kind: "text"; delta: string }
  | { calls: ToolCallOp[]; kind: "tools" };

/** How a run ends: it finishes, finishes after a snapshot of the messages
 *  the page holds, is stopped by the user, or waits on the approval of its
 *  last tool call. */
type RunEnd = "approval" | "finish" | "snapshot" | "stop";
type RunSpec = { end: RunEnd; ops: AnswerOp[] };

/** The chunks an answer streams for `ops`, in protocol order, and its tool
 *  calls. Parallel calls start together, interleave their arguments, then
 *  end and report. */
const answerBody = (
  ops: readonly AnswerOp[],
  answerId: string,
): { calls: string[]; chunks: StreamChunk[] } => {
  const chunks: StreamChunk[] = [];
  const calls: string[] = [];
  let steps = 0;
  for (const op of ops) {
    switch (op.kind) {
      case "text":
        chunks.push({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: answerId,
          delta: op.delta,
        });
        break;
      case "reasoning":
        chunks.push({
          type: EventType.REASONING_MESSAGE_CONTENT,
          messageId: `${answerId}-reasoning-${String(steps)}`,
          delta: op.delta,
        });
        break;
      case "snapshot":
        // Materialized from the current messages when the stream yields it.
        chunks.push(buildWireSnapshot([]));
        break;
      case "status":
        steps += 1;
        chunks.push(
          { type: EventType.STEP_STARTED, stepName: `step-${String(steps)}` },
          { type: EventType.STEP_FINISHED, stepName: `step-${String(steps)}` },
        );
        break;
      case "tools": {
        const first = calls.length;
        const started = op.calls.map((call, index) => ({
          ...call,
          id: `${answerId}-call-${String(first + index + 1)}`,
        }));
        for (const { id } of started) {
          calls.push(id);
          chunks.push({
            type: EventType.TOOL_CALL_START,
            toolCallId: id,
            toolCallName: TOOL_NAME,
            parentMessageId: answerId,
          });
        }
        const longest = Math.max(...started.map(({ args }) => args.length));
        for (let index = 0; index < longest; index += 1) {
          for (const { args, id } of started) {
            const delta = args.at(index);
            if (delta !== undefined) {
              chunks.push({
                type: EventType.TOOL_CALL_ARGS,
                toolCallId: id,
                delta,
              });
            }
          }
        }
        for (const { id } of started) {
          chunks.push({ type: EventType.TOOL_CALL_END, toolCallId: id });
        }
        for (const { id } of started) {
          chunks.push({
            type: EventType.TOOL_CALL_RESULT,
            messageId: `result-${id}`,
            toolCallId: id,
            content: JSON.stringify({ rows: [id] }),
          });
        }
        break;
      }
      default:
        op satisfies never;
    }
  }
  return { calls, chunks };
};

// Arbitrary sizes: small transcripts and answers keep each run fast while
// still mixing every part and chunk kind.
const MIN_ONE = 1;
const MAX_TEXT = 6;
const MAX_QUERY = 12;
const MAX_ARG_PIECES = 4;
const MAX_PARALLEL_CALLS = 4;
const MAX_TURN_PARTS = 6;
const MAX_TURNS = 4;
const MAX_ANSWER_OPS = 12;
const MAX_POSTED = 8;
const MAX_ADDED = 2;

/** Whitespace-only text is what the projection rewrites, so the arbitraries
 *  produce it often. */
const textArb = fc.oneof(
  fc.constantFrom(" ", "\n\n", "Clause", " 4.2", "café", "العربية"),
  fc.string({ maxLength: MAX_TEXT }),
);

/** Tool arguments split into the deltas a provider streams. */
const argsArb = fc
  .tuple(
    fc.string({ maxLength: MAX_QUERY }),
    fc.integer({ min: 1, max: MAX_ARG_PIECES }),
  )
  .map(([query, pieces]) => {
    const raw = JSON.stringify({ query });
    const size = Math.ceil(raw.length / pieces);
    return Array.from({ length: pieces }, (_, index) =>
      raw.slice(index * size, (index + 1) * size),
    ).filter((piece) => piece !== "");
  });

const answerOpArb: fc.Arbitrary<AnswerOp> = fc.oneof(
  textArb.map((delta) => ({ kind: "text" as const, delta })),
  textArb.map((delta) => ({ kind: "reasoning" as const, delta })),
  fc.constant({ kind: "status" as const }),
  fc.constant({ kind: "snapshot" as const }),
  fc
    .array(fc.record({ args: argsArb }), {
      minLength: MIN_ONE,
      maxLength: MAX_PARALLEL_CALLS,
    })
    .map((calls) => ({ kind: "tools" as const, calls })),
);

type FinishedPart = PersistedChatMessage["parts"][number];

const finishedCall = (id: string, query: string): FinishedPart[] => [
  {
    type: "tool-call",
    id,
    name: TOOL_NAME,
    arguments: JSON.stringify({ query }),
    input: { query },
    state: "complete",
    output: { rows: [query] },
  },
  {
    type: "tool-result",
    toolCallId: id,
    content: JSON.stringify({ rows: [query] }),
    state: "complete",
  },
];

/** A settled transcript of `turns`, each a question and an answer built
 *  from the given finished parts. */
const transcript = (
  turns: readonly (readonly FinishedPart[])[],
): PersistedChatMessage[] =>
  turns.flatMap((parts, turn) => [
    {
      id: `question-${String(turn)}`,
      role: "user" as const,
      parts: [{ type: "text" as const, content: `Question ${String(turn)}` }],
    },
    {
      id: `reply-${String(turn)}`,
      role: "assistant" as const,
      parts: [...parts],
    },
  ]);

type HistoryPart =
  | { content: string; kind: "text" | "thinking" }
  | { kind: "call"; query: string };

const historyArb = fc
  .array(
    fc.array(
      fc.oneof(
        fc.record({
          content: textArb,
          kind: fc.constantFrom("text" as const, "thinking" as const),
        }),
        fc.record({
          kind: fc.constant("call" as const),
          query: fc.string({ maxLength: MAX_QUERY }),
        }),
      ),
      { maxLength: MAX_TURN_PARTS },
    ),
    { maxLength: MAX_TURNS },
  )
  .map((turns: HistoryPart[][]) => {
    let calls = 0;
    return transcript(
      turns.map((parts) =>
        parts.flatMap((part): FinishedPart[] => {
          switch (part.kind) {
            case "text":
            case "thinking":
              return [{ type: part.kind, content: part.content }];
            case "call":
              calls += 1;
              return finishedCall(`history-call-${String(calls)}`, part.query);
            default:
              return part satisfies never;
          }
        }),
      ),
    );
  });

const runSpecArb: fc.Arbitrary<RunSpec> = fc.record({
  end: fc.constantFrom<RunEnd>("approval", "finish", "snapshot", "stop"),
  ops: fc.array(answerOpArb, {
    minLength: MIN_ONE,
    maxLength: MAX_ANSWER_OPS,
  }),
});

/** A settled transcript, the question's answer, the user's approval of a
 *  call it waits on and the text that continues it, and a regenerated
 *  answer. */
type Session = {
  approved: boolean;
  continuation: AnswerOp[];
  first: RunSpec;
  history: PersistedChatMessage[];
  regenerate: RunSpec | null;
};

const sessionArb: fc.Arbitrary<Session> = fc.record({
  approved: fc.boolean(),
  continuation: fc.array(
    textArb.map((delta) => ({ kind: "text" as const, delta })),
    { maxLength: MAX_ANSWER_OPS },
  ),
  first: runSpecArb,
  history: historyArb,
  regenerate: fc.option(runSpecArb, { nil: null }),
});

/** What made the client emit: a chunk, or a page action. */
type Cause = StreamChunk | "approval" | "regenerate" | "send" | "stop";

type Emit = {
  cause: Cause;
  /** STEP_STARTED changes SDK state without emitting messages. */
  stepName: string | undefined;
  /** The cached projections equal fresh ones over the same messages. */
  fresh: boolean;
  shown: ChatUIMessage[];
};

const isUiMessage = (message: ModelMessage | UIMessage): message is UIMessage =>
  "parts" in message && Array.isArray(message.parts);

const IDLE_WAIT_TICKS = 2000;

/** Plays `session` through the SDK client, its connection wrapped as the
 *  runtime wraps it, and records what the page shows on every emit with
 *  its cause, and every object that changed in place. */
const streamSession = async ({
  session,
  onMessages = show,
}: {
  session: Session;
  onMessages?: (messages: UIMessage<ChatClientTools>[]) => ChatUIMessage[];
}): Promise<{ changed: string[]; emits: Emit[]; stopped: boolean }> => {
  const emits: Emit[] = [];
  let stopped = false;
  const watch = createChangeWatch();
  let cause: Cause = "send";
  let stepName: string | undefined;
  let latest: UIMessage<ChatClientTools>[] = [];
  let approvalId: string | undefined;
  let stop: () => void = () => undefined;
  const runs: { answerId: string; spec: RunSpec }[] = [
    { answerId: ANSWER_ID, spec: session.first },
  ];
  const runChunks = async function* (
    run: RunAgentInputContext,
  ): AsyncGenerator<StreamChunk> {
    const started = {
      type: EventType.RUN_STARTED,
      runId: run.runId,
      threadId: run.threadId,
    } as const;
    const finished = {
      type: EventType.RUN_FINISHED,
      runId: run.runId,
      threadId: run.threadId,
      finishReason: "stop",
    } as const;
    const next = runs.shift();
    yield started;
    if (next === undefined) {
      yield finished;
      return;
    }
    const { answerId, spec } = next;
    const body = answerBody(spec.ops, answerId);
    const call = body.calls.at(-1);
    // Server tools report before the run ends; the call awaiting approval
    // has no result yet.
    const awaited = spec.end === "approval" ? call : undefined;
    const chunks = body.chunks.filter(
      (chunk) =>
        chunk.type !== EventType.TOOL_CALL_RESULT ||
        chunk.toolCallId !== awaited,
    );
    yield {
      type: EventType.TEXT_MESSAGE_START,
      messageId: answerId,
      role: "assistant",
    };
    for (const chunk of chunks) {
      yield chunk.type === EventType.MESSAGES_SNAPSHOT
        ? buildWireSnapshot(latest)
        : chunk;
    }
    if (spec.end === "stop") {
      cause = "stop";
      stopped = true;
      stop();
      return;
    }
    yield { type: EventType.TEXT_MESSAGE_END, messageId: answerId };
    if (spec.end === "snapshot") {
      // The server's history equals what the page holds.
      yield buildWireSnapshot(latest);
    }
    if (awaited !== undefined) {
      approvalId = `approval-${awaited}`;
      yield {
        type: EventType.RUN_FINISHED,
        runId: run.runId,
        threadId: run.threadId,
        outcome: {
          type: "interrupt",
          interrupts: [
            {
              id: approvalId,
              reason: "approval_required",
              toolCallId: awaited,
              metadata: { kind: "approval", toolName: TOOL_NAME },
            },
          ],
        },
      };
      return;
    }
    yield finished;
  };
  const client = new ChatClient<ChatClientTools, unknown, readonly []>({
    initialMessages: session.history,
    connection: {
      connect: (messages, _data, _signal, run) => {
        if (run === undefined || !messages.every(isUiMessage)) {
          throw new Error("The client sent no run context or model messages");
        }
        return keepPostedMessagesInSnapshots(messages, runChunks(run));
      },
    },
    onChunk: (chunk) => {
      cause = chunk;
      if (
        chunk.type === EventType.RUN_STARTED ||
        chunk.type === EventType.MESSAGES_SNAPSHOT
      ) {
        stepName = undefined;
      } else if (chunk.type === EventType.STEP_STARTED) {
        stepName = chunk.stepName;
      }
      // STEP_FINISHED retains the SDK's current thinking step.
    },
    onMessagesChange: (messages) => {
      latest = messages;
      const shown = onMessages(messages);
      watch.observe(messages);
      watch.observe(shown);
      emits.push({
        cause,
        stepName,
        fresh: matchesFreshProjection(messages),
        shown,
      });
    },
  });
  stop = () => {
    client.stop();
  };
  const settle = async () => {
    for (
      let tick = 0;
      tick < IDLE_WAIT_TICKS && client.getIsLoading();
      tick += 1
    ) {
      await sleep(0);
    }
  };
  client.attach();
  try {
    await client.sendMessage("Find the records");
    await settle();
    if (approvalId !== undefined) {
      runs.push({
        answerId: ANSWER_ID,
        spec: { end: "finish", ops: session.continuation },
      });
      cause = "approval";
      await client.addToolApprovalResponse({
        id: approvalId,
        approved: session.approved,
      });
      await settle();
    }
    if (session.regenerate !== null) {
      runs.splice(0, runs.length, {
        answerId: REGENERATED_ID,
        spec: session.regenerate,
      });
      cause = "regenerate";
      await client.reload();
      await settle();
    }
  } finally {
    client.detach();
  }
  return { changed: watch.changed, emits, stopped };
};

/** The tool calls a RUN_FINISHED asks the user to approve. */
const awaitedCalls = (chunk: StreamChunk): readonly string[] =>
  chunk.type === EventType.RUN_FINISHED && chunk.outcome?.type === "interrupt"
    ? chunk.outcome.interrupts.flatMap(({ toolCallId }) =>
        toolCallId === undefined ? [] : [toolCallId],
      )
    : [];

/** Whether `chunk` may replace `part`, a part the page showed before it. */
const chunkMayReplace = (
  chunk: StreamChunk,
  part: ChatUIMessage["parts"][number],
  parts: readonly ChatUIMessage["parts"][number][],
): boolean => {
  switch (chunk.type) {
    case EventType.TEXT_MESSAGE_CONTENT:
    case EventType.TEXT_MESSAGE_END:
    case EventType.RUN_FINISHED:
      return (
        // The streaming segment is the answer's last part.
        (part.type === "text" && part === parts.at(-1)) ||
        (part.type === "tool-call" && awaitedCalls(chunk).includes(part.id))
      );
    case EventType.REASONING_MESSAGE_CONTENT:
      return part === parts.findLast(({ type }) => type === "thinking");
    case EventType.TOOL_CALL_START:
    case "TOOL_CALL_START":
    case EventType.TOOL_CALL_ARGS:
    case EventType.TOOL_CALL_END:
    case "TOOL_CALL_END":
    case EventType.TOOL_CALL_RESULT:
      return (
        (part.type === "tool-call" && part.id === chunk.toolCallId) ||
        (part.type === "tool-result" && part.toolCallId === chunk.toolCallId)
      );
    // Chunks that carry no part of the answer the page already showed.
    case "ACTIVITY_DELTA":
    case "ACTIVITY_SNAPSHOT":
    case "CUSTOM":
    case EventType.TEXT_MESSAGE_START:
    case EventType.TEXT_MESSAGE_CHUNK:
    case EventType.TOOL_CALL_CHUNK:
    case EventType.STATE_SNAPSHOT:
    case EventType.STATE_DELTA:
    case EventType.MESSAGES_SNAPSHOT:
    case EventType.RAW:
    case EventType.RUN_STARTED:
    case EventType.RUN_ERROR:
    case EventType.STEP_STARTED:
    case EventType.STEP_FINISHED:
    case EventType.REASONING_START:
    case EventType.REASONING_MESSAGE_START:
    case EventType.REASONING_MESSAGE_END:
    case EventType.REASONING_MESSAGE_CHUNK:
    case EventType.REASONING_END:
    case EventType.REASONING_ENCRYPTED_VALUE:
    case EventType.SUBAGENT_STARTED:
    case EventType.SUBAGENT_FINISHED:
    case EventType.SUBAGENT_ERROR:
      return false;
    default:
      return chunk satisfies never;
  }
};

/** Chunks after which the SDK hands back every message as a new object:
 *  TOOL_CALL_RESULT (`updateToolCallWithOutput` copies each message, keeping
 *  its parts) and MESSAGES_SNAPSHOT (rebuilt from the wire). */
const REBUILDS_MESSAGES: ReadonlySet<StreamChunk["type"]> = new Set([
  EventType.MESSAGES_SNAPSHOT,
  EventType.TOOL_CALL_RESULT,
]);

const STREAMED_IDS: ReadonlySet<string> = new Set([ANSWER_ID, REGENERATED_ID]);

type ReasoningTargetOptions = {
  cause: StreamChunk;
  message: ChatUIMessage;
  historyIds: ReadonlySet<string>;
  activeAssistantId: string | undefined;
  stepName: string | undefined;
};

/** The SDK attaches reasoning to its active assistant, which may be an
 * auto-created message after a tool result. The wire messageId identifies
 * the thinking step, not necessarily that assistant message. */
const reasoningTargetsMessage = ({
  cause,
  message,
  historyIds,
  activeAssistantId,
  stepName,
}: ReasoningTargetOptions) =>
  cause.type === EventType.REASONING_MESSAGE_CONTENT &&
  message.id === activeAssistantId &&
  !historyIds.has(message.id) &&
  message.role === "assistant" &&
  message.parts.some(
    (part) =>
      part.type === "thinking" &&
      "stepId" in part &&
      (part.stepId === cause.messageId ||
        (stepName !== undefined && part.stepId === stepName)),
  );

type ToolTargetOptions = {
  cause: StreamChunk;
  message: ChatUIMessage;
  historyIds: ReadonlySet<string>;
  activeAssistantId: string | undefined;
  previous: readonly ChatUIMessage[];
};

/** START reuses the active assistant when its preferred parent has no state.
 * ARGS/END route to the owner recorded by START, identified here by the
 * unique tool-call part already visible in the previous emit. An approval
 * interrupt updates only the active owner containing the awaited call. */
const toolTargetsMessage = ({
  cause,
  message,
  historyIds,
  activeAssistantId,
  previous,
}: ToolTargetOptions) => {
  if (historyIds.has(message.id) || message.role !== "assistant") {
    return false;
  }
  switch (cause.type) {
    case EventType.TOOL_CALL_START:
      return (
        message.id === activeAssistantId &&
        message.parts.some(
          (part) => part.type === "tool-call" && part.id === cause.toolCallId,
        )
      );
    case EventType.RUN_FINISHED:
      return (
        message.id === activeAssistantId &&
        message.parts.some(
          (part) =>
            part.type === "tool-call" && awaitedCalls(cause).includes(part.id),
        )
      );
    case EventType.TOOL_CALL_ARGS:
    case EventType.TOOL_CALL_END: {
      const owners = previous.filter(({ parts }) =>
        parts.some(
          (part) => part.type === "tool-call" && part.id === cause.toolCallId,
        ),
      );
      return owners.length === 1 && owners.at(0)?.id === message.id;
    }
    default:
      return false;
  }
};

/** Immediate text emission uses the same active fallback owner as START.
 * Its last text must contain precisely the previous segment plus this delta. */
const textTargetsMessage = ({
  cause,
  message,
  historyIds,
  activeAssistantId,
  previous,
}: ToolTargetOptions) => {
  if (
    cause.type !== EventType.TEXT_MESSAGE_CONTENT ||
    cause.delta === "" ||
    message.id !== activeAssistantId ||
    historyIds.has(message.id) ||
    message.role !== "assistant"
  ) {
    return false;
  }
  const previousMessage = previous.find(({ id }) => id === message.id);
  const previousPart = previousMessage?.parts.at(-1);
  const part = message.parts.at(-1);
  return (
    previousMessage !== undefined &&
    part?.type === "text" &&
    part !== previousPart &&
    part.content ===
      (previousPart?.type === "text" ? previousPart.content : "") + cause.delta
  );
};

type SessionPath =
  | "approval-requested"
  | "approval-responded"
  | "continued after approval"
  | "regenerated"
  | "snapshot"
  | "stopped"
  | "tool result";

/** Every path the property claims to cover. */
const SESSION_PATHS = {
  "approval-requested": true,
  "approval-responded": true,
  "continued after approval": true,
  regenerated: true,
  snapshot: true,
  stopped: true,
  "tool result": true,
} as const satisfies Record<SessionPath, true>;

/** The paths one session's emits went through. */
const reachedPaths = (
  emits: readonly Emit[],
  stopped: boolean,
): SessionPath[] => {
  const paths: SessionPath[] = [];
  const approvalAt = emits.findIndex(({ cause }) => cause === "approval");
  const parts = emits.flatMap(({ shown }) =>
    shown.flatMap((message) => message.parts),
  );
  const states = new Set(
    parts.flatMap((part) => (part.type === "tool-call" ? [part.state] : [])),
  );
  const chunkTypes = new Set(
    emits.flatMap(({ cause }) =>
      typeof cause === "object" ? [cause.type] : [],
    ),
  );
  if (states.has("approval-requested")) {
    paths.push("approval-requested");
  }
  if (states.has("approval-responded")) {
    paths.push("approval-responded");
  }
  if (
    approvalAt !== -1 &&
    emits
      .slice(approvalAt)
      .some(
        ({ cause }) =>
          typeof cause === "object" &&
          cause.type === EventType.TEXT_MESSAGE_CONTENT,
      )
  ) {
    paths.push("continued after approval");
  }
  if (
    emits.some(({ shown }) => shown.some(({ id }) => id === REGENERATED_ID))
  ) {
    paths.push("regenerated");
  }
  if (chunkTypes.has(EventType.MESSAGES_SNAPSHOT)) {
    paths.push("snapshot");
  }
  if (stopped) {
    paths.push("stopped");
  }
  if (chunkTypes.has(EventType.TOOL_CALL_RESULT)) {
    paths.push("tool result");
  }
  return paths;
};

type StreamIdentityObservation = {
  changed: readonly string[];
  emits: readonly Emit[];
  history: readonly UIMessage<ChatClientTools>[];
};

const expectStableStreamIdentity = ({
  changed,
  emits,
  history,
}: StreamIdentityObservation) => {
  expect(changed).toEqual([]);
  const historyIds = new Set(history.map(({ id }) => id));
  for (const [index, next] of emits.entries()) {
    expect({ cause: next.cause, fresh: next.fresh }).toMatchObject({
      fresh: true,
    });
    const previous = emits.at(index - 1);
    const { cause, stepName } = next;
    // A page action (approval, stop, regenerate) may rebuild messages.
    if (index === 0 || previous === undefined || typeof cause !== "object") {
      continue;
    }
    const before = new Map(
      previous.shown.map((message) => [message.id, message]),
    );
    // This harness appends each new assistant to the transcript; snapshots
    // preserve that order. The SDK's reverse-insertion active selection thus
    // belongs to this one current-run assistant, even if earlier ones kept
    // the same thinking step name.
    const activeAssistantId = next.shown.findLast(
      ({ id, role }) => role === "assistant" && !historyIds.has(id),
    )?.id;
    for (const message of next.shown) {
      const shown = before.get(message.id);
      if (shown === undefined) {
        continue;
      }
      if (
        !STREAMED_IDS.has(message.id) &&
        !REBUILDS_MESSAGES.has(cause.type) &&
        !reasoningTargetsMessage({
          cause,
          message,
          historyIds,
          activeAssistantId,
          stepName,
        }) &&
        !toolTargetsMessage({
          cause,
          message,
          historyIds,
          activeAssistantId,
          previous: previous.shown,
        }) &&
        !textTargetsMessage({
          cause,
          message,
          historyIds,
          activeAssistantId,
          previous: previous.shown,
        })
      ) {
        expect(message).toBe(shown);
      }
      if (cause.type === EventType.MESSAGES_SNAPSHOT) {
        continue;
      }
      const kept = new Set(message.parts);
      for (const part of shown.parts) {
        if (!kept.has(part)) {
          expect({
            chunk: cause.type,
            message: message.id,
            replaced: part,
            allowed: chunkMayReplace(cause, part, shown.parts),
          }).toMatchObject({ allowed: true });
        }
      }
    }
  }
};

describe("streamed chunks keep what they do not change", () => {
  test("every chunk leaves the messages and parts it does not touch as the same objects", async () => {
    const reached = new Set<SessionPath>();
    await assertProperty(
      "every chunk leaves the messages and parts it does not touch as the same objects",
      fc.asyncProperty(sessionArb, async (session) => {
        const { changed, emits, stopped } = await streamSession({ session });
        expectStableStreamIdentity({
          changed,
          emits,
          history: session.history,
        });
        for (const path of reachedPaths(emits, stopped)) {
          reached.add(path);
        }
      }),
      { numRuns: 60 },
    );
    // The runs reached every path the property claims to cover.
    expect<readonly string[]>([...reached].toSorted()).toEqual(
      Object.keys(SESSION_PATHS).toSorted(),
    );
  });

  test("reused thinking step names do not exempt an earlier assistant clone", () => {
    const earlier = {
      id: "earlier-fallback",
      role: "assistant" as const,
      parts: [
        { type: "thinking" as const, content: "Earlier", stepId: "step" },
      ],
    };
    const active = {
      id: "active-fallback",
      role: "assistant" as const,
      parts: [
        { type: "thinking" as const, content: "Current", stepId: "step" },
      ],
    };
    const cause = {
      type: EventType.REASONING_MESSAGE_CONTENT,
      messageId: "step",
      delta: " reasoning",
    } as const;
    const before = {
      cause,
      stepName: "step",
      fresh: true,
      shown: [earlier, active],
    };
    const continued = {
      ...active,
      parts: [
        {
          type: "thinking" as const,
          content: "Current reasoning",
          stepId: "step",
        },
      ],
    };
    expectStableStreamIdentity({
      changed: [],
      history: [],
      emits: [
        before,
        { cause, stepName: "step", fresh: true, shown: [earlier, continued] },
      ],
    });
    expect(() =>
      expectStableStreamIdentity({
        changed: [],
        history: [],
        emits: [
          before,
          {
            cause,
            stepName: "step",
            fresh: true,
            shown: [{ ...earlier }, continued],
          },
        ],
      }),
    ).toThrow("expect(received).toBe(expected)");
  });

  test("tools reuse the reasoning assistant created after a snapshot", async () => {
    const history = transcript([
      [{ type: "text", content: "Earlier settled answer" }],
    ]);
    const observed = await streamSession({
      session: {
        approved: false,
        continuation: [],
        first: { end: "approval", ops: [{ kind: "snapshot" }] },
        history,
        regenerate: {
          end: "approval",
          ops: [
            { kind: "snapshot" },
            { kind: "reasoning", delta: " " },
            { kind: "tools", calls: [{ args: ['{"query":""}'] }] },
            { kind: "text", delta: "After tool" },
            { kind: "text", delta: " and more" },
          ],
        },
      },
    });
    expectStableStreamIdentity({ ...observed, history });
    const historyIds = new Set(history.map(({ id }) => id));
    const reached = new Set<StreamChunk["type"]>();
    let unrelatedCloneChecked = false;
    for (const [index, next] of observed.emits.entries()) {
      const previous = observed.emits.at(index - 1);
      const { cause } = next;
      if (index === 0 || previous === undefined || typeof cause !== "object") {
        continue;
      }
      const activeAssistantId = next.shown.findLast(
        ({ id, role }) => role === "assistant" && !historyIds.has(id),
      )?.id;
      if (
        next.shown.some(
          (message) =>
            !STREAMED_IDS.has(message.id) &&
            (toolTargetsMessage({
              cause,
              message,
              historyIds,
              activeAssistantId,
              previous: previous.shown,
            }) ||
              textTargetsMessage({
                cause,
                message,
                historyIds,
                activeAssistantId,
                previous: previous.shown,
              })),
        )
      ) {
        reached.add(cause.type);
        if (
          !unrelatedCloneChecked &&
          cause.type === EventType.TOOL_CALL_START
        ) {
          const untouched = next.shown.find(
            ({ id }) =>
              historyIds.has(id) &&
              previous.shown.some((message) => message.id === id),
          );
          if (untouched !== undefined) {
            const corrupted = {
              ...next,
              shown: next.shown.map((message) =>
                message === untouched ? { ...message } : message,
              ),
            };
            expect(() =>
              expectStableStreamIdentity({
                changed: observed.changed,
                history,
                emits: observed.emits.map((emit, emitIndex) =>
                  emitIndex === index ? corrupted : emit,
                ),
              }),
            ).toThrow("expect(received).toBe(expected)");
            unrelatedCloneChecked = true;
          }
        }
      }
    }
    expect(unrelatedCloneChecked).toBe(true);
    expect(reached).toEqual(
      new Set([
        EventType.TOOL_CALL_START,
        EventType.TOOL_CALL_ARGS,
        EventType.TOOL_CALL_END,
        EventType.TEXT_MESSAGE_CONTENT,
        EventType.RUN_FINISHED,
      ]),
    );
  });

  test("reasoning after tool results owns its SDK assistant without replacing history", async () => {
    const history = transcript([
      [{ type: "text", content: "Earlier settled answer" }],
    ]);
    const session = {
      approved: true,
      continuation: [],
      first: {
        end: "stop",
        ops: [
          { kind: "status" },
          { kind: "status" },
          { kind: "text", delta: "Answer" },
          { kind: "tools", calls: [{ args: ['{"query":"first"}'] }] },
          {
            kind: "tools",
            calls: [
              { args: ['{"query":"second"}'] },
              { args: ['{"query":"third"}'] },
              { args: ['{"query":"fourth"}'] },
              { args: ['{"query":"fifth"}'] },
            ],
          },
          { kind: "text", delta: "\n\n" },
          { kind: "snapshot" },
          { kind: "status" },
          { kind: "reasoning", delta: "Reasoning after tool results" },
          { kind: "reasoning", delta: " and more reasoning" },
          { kind: "status" },
          { kind: "status" },
        ],
      },
      history,
      regenerate: {
        end: "snapshot",
        ops: [
          { kind: "text", delta: "\n\n" },
          { kind: "text", delta: "" },
          { kind: "reasoning", delta: "Continued reasoning" },
          { kind: "status" },
          { kind: "tools", calls: [{ args: ['{"query":"reloaded"}'] }] },
          { kind: "reasoning", delta: "Next reasoning" },
          { kind: "reasoning", delta: " and more" },
        ],
      },
    } satisfies Session;
    const observed = await streamSession({ session });
    expectStableStreamIdentity({ ...observed, history });
    const historyIds = new Set(history.map(({ id }) => id));
    const reachedFallbackReasoning = observed.emits.some(
      ({ cause, shown, stepName }) => {
        if (typeof cause !== "object") {
          return false;
        }
        return shown.some(
          (message) =>
            !STREAMED_IDS.has(message.id) &&
            reasoningTargetsMessage({
              cause,
              message,
              historyIds,
              activeAssistantId: shown.findLast(
                ({ id, role }) => role === "assistant" && !historyIds.has(id),
              )?.id,
              stepName,
            }),
        );
      },
    );
    expect(reachedFallbackReasoning).toBe(true);
  });

  test("no chunk, tool result or snapshot reads the 200 finished tool calls it leaves alone", async () => {
    let counting = false;
    let reads = 0;
    const watchedParts = new WeakSet<object>();
    const watched = <Part extends object>(part: Part): Part => {
      const proxy = new Proxy(part, {
        get: (target, key, receiver) => {
          if (counting) {
            reads += 1;
          }
          return Reflect.get(target, key, receiver);
        },
      });
      watchedParts.add(proxy);
      return proxy;
    };
    // Twenty settled turns of ten finished calls, each answer opening with
    // the whitespace text a failed run can leave.
    const history = transcript(
      Array.from({ length: 20 }, (_, turn) => [
        { type: "text" as const, content: "\n\n" },
        ...Array.from({ length: 10 }, (_slot, call) =>
          finishedCall(
            `history-${String(turn)}-${String(call)}`,
            `query ${String(call)}`,
          ),
        ).flat(),
        { type: "text" as const, content: `Answer ${String(turn)}` },
      ]),
    ).map((message) => ({ ...message, parts: message.parts.map(watched) }));
    const finishedCalls = history
      .flatMap(({ parts }) => parts)
      .filter((part) => part.type === "tool-call");
    expect(finishedCalls).toHaveLength(200);

    const ops: AnswerOp[] = [
      ...Array.from({ length: 30 }, (_, index) => ({
        kind: "reasoning" as const,
        delta: `step ${String(index)} `,
      })),
      { kind: "status" },
      {
        kind: "tools",
        calls: [{ args: Array.from({ length: 30 }, () => " ") }],
      },
      ...Array.from({ length: 40 }, (_, index) => ({
        kind: "text" as const,
        delta: `word ${String(index)} `,
      })),
    ];
    const measured: { reads: number; watched: number }[] = [];
    const { emits } = await streamSession({
      session: {
        approved: false,
        continuation: [],
        first: { end: "snapshot", ops },
        history,
        regenerate: null,
      },
      onMessages: (messages) => {
        reads = 0;
        counting = true;
        try {
          return show(messages);
        } finally {
          counting = false;
          measured.push({
            reads,
            watched: messages
              .flatMap(({ parts }) => parts)
              .filter((part) => watchedParts.has(part)).length,
          });
        }
      },
    });
    const byCause = (type: StreamChunk["type"]) =>
      emits.flatMap(({ cause }, index) =>
        typeof cause === "object" && cause.type === type
          ? [measured.at(index)]
          : [],
      );
    const historyParts = history.flatMap(({ parts }) => parts).length;
    // The first emit projects the transcript once: the watched parts reach
    // the projection, so the zero counts below are not vacuous.
    expect(measured.at(0)?.watched).toBe(historyParts);
    expect(measured.at(0)?.reads).toBeGreaterThan(finishedCalls.length);
    // A tool result makes the SDK rebuild every message around the same
    // parts; the page reads none of them again.
    const results = byCause(EventType.TOOL_CALL_RESULT);
    expect(results).toEqual([{ reads: 0, watched: historyParts }]);
    // Every later emit that still holds finished parts reads none of them.
    // A snapshot rebuilds every part from the wire (no watched part
    // survives it), so its parts are new objects the page has not seen.
    expect(byCause(EventType.MESSAGES_SNAPSHOT)).toHaveLength(1);
    expect(emits.length).toBeGreaterThan(100);
    for (const { reads: emitReads, watched: held } of measured.slice(1)) {
      expect({ held, reads: emitReads }).toEqual({
        held,
        reads: 0,
      });
    }
  });
});

describe("snapshot and rejoin merges keep what the page shows", () => {
  const message = (id: string, role: "assistant" | "user") =>
    ({ id, parts: [{ type: "text", content: id }], role }) satisfies UIMessage;

  const caseArb = fc
    .tuple(
      fc.array(fc.boolean(), { maxLength: MAX_POSTED, minLength: MIN_ONE }),
      fc.nat({ max: MAX_ADDED }),
    )
    .map(([kept, added]) => {
      const posted = kept.map((_, index) =>
        message(
          `posted-${String(index)}`,
          index % 2 === 0 ? "user" : "assistant",
        ),
      );
      const snapshot = [
        ...posted.filter(
          (_, index) => kept[index] === true || index === posted.length - 1,
        ),
        ...Array.from({ length: added }, (_, index) =>
          message(`added-${String(index)}`, "assistant"),
        ),
      ].map(({ id, parts, role }) => ({ content: "", id, parts, role }));
      return { posted, snapshot };
    });

  test("a snapshot merge hands back the snapshot's own message objects", () => {
    assertProperty(
      "a snapshot merge hands back the snapshot's own message objects",
      fc.property(caseArb, ({ posted, snapshot }) => {
        const reasoned = keepReasoningSteps(snapshot);
        expect(reasoned).toHaveLength(snapshot.length);
        for (const [index, entry] of snapshot.entries()) {
          expect(reasoned.at(index)).toBe(entry);
        }
        const merged = new Set(keepPostedMessages(posted, reasoned));
        for (const entry of snapshot) {
          expect(merged.has(entry)).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });

  test("a rejoin keeps the shown answer object until replay catches up, then the replayed objects", () => {
    const question = message("question", "user");
    const shownAnswer = {
      id: ANSWER_ID,
      role: "assistant" as const,
      parts: [{ type: "text" as const, content: "Drafting the clause" }],
    } satisfies UIMessage;
    const behind = [
      question,
      { ...shownAnswer, parts: [{ type: "text" as const, content: "Dra" }] },
    ];
    const held = keepShownRejoinMessages([question, shownAnswer], behind);
    expect(held.at(0)).toBe(question);
    expect(held.at(1)).toBe(shownAnswer);

    const caughtUp = [
      question,
      {
        ...shownAnswer,
        parts: [{ type: "text" as const, content: "Drafting the clause now" }],
      },
    ];
    const replayed = keepShownRejoinMessages([question, shownAnswer], caughtUp);
    expect(replayed).toHaveLength(caughtUp.length);
    for (const [index, entry] of caughtUp.entries()) {
      expect(replayed.at(index)).toBe(entry);
    }
  });
});

describe("the chat runtime keeps settled messages while an answer streams", () => {
  const previousFetch = globalThis.fetch;
  beforeEach(() => {
    resetChatRequestStateForTests();
  });
  afterEach(() => {
    globalThis.fetch = previousFetch;
  });

  const SSE_HEADERS = { "Content-Type": "text/event-stream" };

  /** Answers each page request with a stream the test writes to, and keeps
   *  an identical copy of it for the replay client. */
  const installServer = () => {
    const encoder = new TextEncoder();
    const replayBodies: ReadableStream<Uint8Array>[] = [];
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let requests = 0;
    globalThis.fetch = Object.assign(
      async () => {
        await Promise.resolve();
        const body = new ReadableStream<Uint8Array>({
          start: (streamController) => {
            controller = streamController;
          },
        });
        const [page, replay] = body.tee();
        replayBodies.push(replay);
        requests += 1;
        return new Response(page, { headers: SSE_HEADERS });
      },
      { preconnect: previousFetch.preconnect },
    );
    return {
      close: () => {
        controller?.close();
      },
      push: (...events: Record<string, unknown>[]) => {
        for (const event of events) {
          controller?.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        }
      },
      replayFetch: Object.assign(
        async () => {
          await Promise.resolve();
          const body = replayBodies.shift();
          if (body === undefined) {
            throw new Error("The replay asked for a stream the page never got");
          }
          return new Response(body, { headers: SSE_HEADERS });
        },
        { preconnect: () => undefined },
      ),
      requests: () => requests,
    };
  };

  /** The client reads the stream a chunk per task: wait until it has read
   *  as far as the test needs. */
  const waitFor = async (reached: () => boolean) => {
    for (let index = 0; index < 2000 && !reached(); index += 1) {
      await sleep(0);
    }
    expect(reached()).toBe(true);
  };

  const answer = (runtime: ChatRuntime, id = ANSWER_ID) =>
    runtime.getSnapshot().messages.find((message) => message.id === id);

  /** The fields both clients derive from the stream; each stamps its own
   *  send time on the question. */
  const comparable = (messages: readonly PersistedChatMessage[]) =>
    messages.map(({ id, metadata, parts, role }) => ({
      id,
      metadata,
      parts,
      role,
    }));

  test("every chunk hands subscribers the settled messages and parts they already hold", async () => {
    const server = installServer();
    const history = transcript([
      [
        { type: "text", content: "\n\n" },
        ...finishedCall("settled-call", "terms"),
        { type: "text", content: "Found the terms" },
      ],
    ]);
    const runtime = createChatRuntime({
      activeTurnId: null,
      context: undefined,
      initialMessages: history,
      key: { scope: "global", threadId: toChatThreadId("thread-identity") },
      onError: () => undefined,
      onFinish: () => undefined,
      reloadThread: () => undefined,
      scheduleEmit: () => () => undefined,
    });
    // A second SDK client reads the same stream with nothing cached: the
    // page's cached projection must equal a fresh projection of its
    // messages after every chunk.
    const upstream = fetchServerSentEvents("https://chat.test", {
      fetchClient: server.replayFetch,
    });
    const replay = new ChatClient<ChatClientTools, unknown, readonly []>({
      initialMessages: history,
      connection: {
        connect: (messages, data, signal, run) => {
          if (!messages.every(isUiMessage)) {
            throw new Error("The replay sent model messages");
          }
          return keepPostedMessagesInSnapshots(
            messages,
            upstream.connect(messages, data, signal, run),
          );
        },
      },
    });
    replay.attach();
    const watch = createChangeWatch();
    const expectFresh = async () => {
      const fresh = () =>
        comparable(replay.getMessages().map(toPersistedChatMessage));
      const shown = () => comparable(runtime.getSnapshot().messages);
      await waitFor(() => Bun.deepEquals(shown(), fresh(), true));
      expect(shown()).toEqual(fresh());
      const messages = runtime.getSnapshot().messages;
      watch.observe(messages);
      expect(messages.every(isCanonicalChatUIMessage)).toBe(true);
      expect<readonly PersistedChatMessage[]>(
        projectCanonicalChatUIMessages(messages),
      ).toEqual(messages);
    };

    const question = {
      content: "Find the records",
      id: toSafeId<"chatMessage">("018f0000-0000-7000-8000-000000000001"),
    };
    const sent = sendThreadChatMessage(runtime, question);
    await waitFor(() => server.requests() === 1);
    const replayed = replay.sendMessage(question);
    server.push(
      {
        type: "RUN_STARTED",
        runId: "run-identity",
        threadId: "thread-identity",
      },
      { type: "TEXT_MESSAGE_START", messageId: ANSWER_ID, role: "assistant" },
    );
    await waitFor(() => answer(runtime) !== undefined);
    await expectFresh();
    let settled = runtime.getSnapshot().messages.slice(0, history.length);
    // The page drops the settled reply's whitespace part, so the reply it
    // shows is the runtime's own object, not the one it was seeded with.
    expect(history.at(1)?.parts).toHaveLength(4);
    expect(settled.at(1)?.parts).toHaveLength(3);
    const expectSettled = ({ parts }: { parts: "only" | "with messages" }) => {
      const messages = runtime.getSnapshot().messages;
      for (const [index, message] of settled.entries()) {
        const current = messages.at(index);
        if (parts === "with messages") {
          expect(current).toBe(message);
        }
        for (const [partIndex, part] of message.parts.entries()) {
          expect(current?.parts.at(partIndex)).toBe(part);
        }
      }
    };
    const streamText = async (id: string, words: number) => {
      let text = "";
      for (let index = 0; index < words; index += 1) {
        const delta = `word ${String(index)} `;
        text += delta;
        const expected = text;
        server.push({ type: "TEXT_MESSAGE_CONTENT", messageId: id, delta });
        await waitFor(
          () =>
            answer(runtime, id)?.parts.some(
              (part) => part.type === "text" && part.content === expected,
            ) === true,
        );
        expectSettled({ parts: "with messages" });
        await expectFresh();
      }
    };

    await streamText(ANSWER_ID, 10);
    server.push(
      {
        type: "TOOL_CALL_START",
        toolCallId: "streamed-call",
        toolCallName: TOOL_NAME,
        parentMessageId: ANSWER_ID,
      },
      { type: "TOOL_CALL_ARGS", toolCallId: "streamed-call", delta: '{"q":' },
    );
    await waitFor(
      () =>
        answer(runtime)?.parts.some(
          (part) => part.type === "tool-call" && part.arguments === '{"q":',
        ) === true,
    );
    expectSettled({ parts: "with messages" });
    await expectFresh();

    server.push(
      { type: "TOOL_CALL_ARGS", toolCallId: "streamed-call", delta: '"x"}' },
      { type: "TOOL_CALL_END", toolCallId: "streamed-call" },
      {
        type: "TOOL_CALL_RESULT",
        messageId: "result-streamed-call",
        toolCallId: "streamed-call",
        content: JSON.stringify({ rows: ["x"] }),
      },
    );
    await waitFor(
      () =>
        answer(runtime)?.parts.some((part) => part.type === "tool-result") ===
        true,
    );
    // The SDK rebuilds every message around the same parts on a result.
    expectSettled({ parts: "only" });
    await expectFresh();

    server.push({ type: "TEXT_MESSAGE_END", messageId: ANSWER_ID });
    await expectFresh();
    server.push(
      { ...buildWireSnapshot(replay.getMessages()) },
      {
        type: "RUN_FINISHED",
        runId: "run-identity",
        threadId: "thread-identity",
        finishReason: "stop",
      },
    );
    server.close();
    await sent;
    await replayed;
    await expectFresh();

    // Regenerating keeps the question and history; the new answer streams
    // past them.
    const regenerated = runtime.reload();
    await waitFor(() => server.requests() === 2);
    const replayRegenerated = replay.reload();
    server.push(
      { type: "RUN_STARTED", runId: "run-again", threadId: "thread-identity" },
      {
        type: "TEXT_MESSAGE_START",
        messageId: REGENERATED_ID,
        role: "assistant",
      },
    );
    await waitFor(() => answer(runtime, REGENERATED_ID) !== undefined);
    await expectFresh();
    settled = runtime
      .getSnapshot()
      .messages.filter(({ id }) => id !== REGENERATED_ID);
    expect(settled.map(({ id }) => id)).toEqual([
      ...history.map(({ id }) => id),
      question.id,
    ]);
    await streamText(REGENERATED_ID, 10);
    server.push(
      { type: "TEXT_MESSAGE_END", messageId: REGENERATED_ID },
      {
        type: "RUN_FINISHED",
        runId: "run-again",
        threadId: "thread-identity",
        finishReason: "stop",
      },
    );
    server.close();
    await regenerated;
    await replayRegenerated;
    await expectFresh();
    replay.detach();
    expect(watch.changed).toEqual([]);
  });
});
