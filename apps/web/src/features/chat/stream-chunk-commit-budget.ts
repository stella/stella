import type { StreamChunk } from "@tanstack/ai";

// How often the thread page may commit while a response streams, by the kind
// of chunk that streams (oracle `chat.render.stream-commits-bounded`). A
// provider can send any of these as hundreds of tiny deltas a second; the
// page must not commit once per delta. `stream-chunk-commit-budget.dom.test.tsx`
// streams each kind in tiny deltas through the page's real runtime and holds
// the commit rate to its budget, and the e2e spec
// `chat-stream-commit-budget.spec.ts` does the same on the running app, with
// the mock model streaming each kind (by its `mockAiMarker`).
//
// Calibration: the canary (`lib/render-storm-canary.ts`) reports a storm above
// 80 commits a second held for two seconds, the floor of a damped render loop.
// Streaming that tells the page about new chunks at most every 50 ms commits
// about 20 times a second, and one emit can commit twice when the page syncs a
// second store from it. A kind's budget sits above that and below the canary,
// so a page that commits per delta fails here long before it ships a storm.

/** A kind of chunk that streams repeatedly while a response is written. */
export type StreamChunkKind =
  | "reasoning"
  | "status"
  | "subagent"
  | "text"
  | "tool-input"
  | "tool-output";

/** The most the page may commit per second while `kind` streams. */
const STREAMING_COMMITS_PER_SECOND = 45;

type StreamChunkBudget = {
  /** The most commits per second while this kind streams. */
  commitsPerSecond: number;
  /**
   * Text that makes the mock model (`apps/api/src/dev/mock-ai-stream-kinds.ts`,
   * `MOCK_AI_STREAM_KIND_MARKERS`) stream this kind as tiny deltas. The web
   * app cannot import the api, so the two maps are pinned together by
   * `e2e/unit/stream-chunk-mock-markers.test.ts`.
   */
  mockAiMarker: string;
  /** What the stream of this kind is, for a reader of a failure. */
  streams: string;
};

export const STREAM_CHUNK_COMMIT_BUDGET = {
  reasoning: {
    commitsPerSecond: STREAMING_COMMITS_PER_SECOND,
    mockAiMarker: "Stream reasoning in tiny deltas please",
    streams: "reasoning deltas of a thinking block",
  },
  status: {
    commitsPerSecond: STREAMING_COMMITS_PER_SECOND,
    mockAiMarker: "Stream status updates in tiny deltas please",
    streams: "step, activity, state and custom progress events",
  },
  subagent: {
    commitsPerSecond: STREAMING_COMMITS_PER_SECOND,
    mockAiMarker: "Stream a subagent run in tiny deltas please",
    streams: "a subagent run's own text deltas, inside its card",
  },
  text: {
    commitsPerSecond: STREAMING_COMMITS_PER_SECOND,
    mockAiMarker: "Stream the answer text in tiny deltas please",
    streams: "text deltas of the answer",
  },
  "tool-input": {
    commitsPerSecond: STREAMING_COMMITS_PER_SECOND,
    mockAiMarker: "Stream a tool input in tiny deltas please",
    streams: "argument deltas of one tool call",
  },
  "tool-output": {
    commitsPerSecond: STREAMING_COMMITS_PER_SECOND,
    mockAiMarker: "Stream tool outputs in tiny deltas please",
    streams: "results of many small tool calls, one after another",
  },
} as const satisfies Record<StreamChunkKind, StreamChunkBudget>;

/** Why an event type never streams repeatedly within one response. */
type NotStreamed = { notStreamed: string };

const ONCE_PER_RUN = "Once per run.";
const ONCE_PER_MESSAGE = "Once per message or block.";
const ONCE_PER_CALL = "Once per tool call.";
const IGNORED_BY_CLIENT =
  "The client's stream processor has no case for it, so it never reaches the page.";

/**
 * Every event type the installed SDK can stream, by the chunk kind it streams
 * as, or why it never streams repeatedly. Keyed by the SDK's own union, so a
 * new event type fails typecheck here until it is placed.
 */
export const STREAM_EVENT_KIND = {
  ACTIVITY_DELTA: "status",
  ACTIVITY_SNAPSHOT: "status",
  CUSTOM: "status",
  MESSAGES_SNAPSHOT: { notStreamed: "Once per response, before the run." },
  RAW: { notStreamed: IGNORED_BY_CLIENT },
  REASONING_ENCRYPTED_VALUE: { notStreamed: ONCE_PER_MESSAGE },
  REASONING_END: { notStreamed: ONCE_PER_MESSAGE },
  REASONING_MESSAGE_CHUNK: { notStreamed: IGNORED_BY_CLIENT },
  REASONING_MESSAGE_CONTENT: "reasoning",
  REASONING_MESSAGE_END: { notStreamed: ONCE_PER_MESSAGE },
  REASONING_MESSAGE_START: { notStreamed: ONCE_PER_MESSAGE },
  REASONING_START: { notStreamed: ONCE_PER_MESSAGE },
  RUN_ERROR: { notStreamed: ONCE_PER_RUN },
  RUN_FINISHED: { notStreamed: ONCE_PER_RUN },
  RUN_STARTED: { notStreamed: ONCE_PER_RUN },
  STATE_DELTA: "status",
  STATE_SNAPSHOT: "status",
  STEP_FINISHED: "status",
  STEP_STARTED: "status",
  SUBAGENT_ERROR: "subagent",
  SUBAGENT_FINISHED: "subagent",
  SUBAGENT_STARTED: "subagent",
  TEXT_MESSAGE_CHUNK: { notStreamed: IGNORED_BY_CLIENT },
  TEXT_MESSAGE_CONTENT: "text",
  TEXT_MESSAGE_END: { notStreamed: ONCE_PER_MESSAGE },
  TEXT_MESSAGE_START: { notStreamed: ONCE_PER_MESSAGE },
  TOOL_CALL_ARGS: "tool-input",
  TOOL_CALL_CHUNK: { notStreamed: IGNORED_BY_CLIENT },
  TOOL_CALL_END: { notStreamed: ONCE_PER_CALL },
  TOOL_CALL_RESULT: "tool-output",
  TOOL_CALL_START: { notStreamed: ONCE_PER_CALL },
} as const satisfies Record<StreamChunk["type"], NotStreamed | StreamChunkKind>;

/**
 * The kind a chunk streams as. A chunk a subagent's run writes carries its
 * run id, and the client's stream processor routes it into that subagent's
 * card whatever its type: it streams as the subagent.
 */
export const streamChunkKindOf = (
  chunk: StreamChunk,
): NotStreamed | StreamChunkKind =>
  "subagentRunId" in chunk && typeof chunk.subagentRunId === "string"
    ? "subagent"
    : STREAM_EVENT_KIND[chunk.type];
