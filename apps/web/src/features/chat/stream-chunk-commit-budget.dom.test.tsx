import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { EventType } from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai";
import { Result, panic } from "better-result";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";

import {
  STREAM_CHUNK_COMMIT_BUDGET,
  STREAM_EVENT_KIND,
  streamChunkKindOf,
} from "@/features/chat/stream-chunk-commit-budget";
import type { StreamChunkKind } from "@/features/chat/stream-chunk-commit-budget";
import { browserStorage } from "@/lib/account/browser-storage";

const localArea = () =>
  browserStorage("local") ?? panic("Test requires local browser storage");
const sessionArea = () =>
  browserStorage("session") ?? panic("Test requires session browser storage");

// Oracle `chat.render.stream-commits-bounded`: while a response streams, the
// thread page commits at most its budget a second, whatever kind of chunk
// streams. Each kind in `STREAM_CHUNK_COMMIT_BUDGET` streams here as hundreds
// of tiny deltas, a few milliseconds apart, through the page's real runtime
// and messages view; a fake server stands where the network is, and a
// `Profiler` at the page's root counts its commits while the deltas arrive.

// A DOM for this file only. Everything that touches the DOM is loaded after
// it exists.
GlobalRegistrator.register({ url: "http://localhost:3000/chat" });

const ORACLE = "chat.render.stream-commits-bounded";

const originalFetch = globalThis.fetch;
let routeRequest:
  | ((input: string | URL | Request, init?: RequestInit) => Promise<Response>)
  | undefined;
globalThis.fetch = Object.assign(
  async (input: string | URL | Request, init?: RequestInit) => {
    if (routeRequest === undefined) {
      return Response.json({ message: "No server" }, { status: 503 });
    }
    return await routeRequest(input, init);
  },
  { preconnect: () => undefined },
);

const testing = await import("@testing-library/react");
const { openChatThreadDomPage } =
  await import("@/components/chat/chat-thread-dom-page");
const { __resetChatRequestStateForTests } =
  await import("@/features/chat/queries");
const { toSafeId } = await import("@/lib/safe-id");

const actEnvironment: unknown = Reflect.get(
  globalThis,
  "IS_REACT_ACT_ENVIRONMENT",
);
beforeAll(() => {
  // The stream arrives on its own schedule, as the network delivers it, not
  // inside a test's `act()`.
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
});

afterAll(async () => {
  await new Promise((resolve) => {
    setTimeout(resolve, 50);
  });
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironment);
  globalThis.fetch = originalFetch;
  await GlobalRegistrator.unregister();
});

afterEach(() => {
  testing.cleanup();
  routeRequest = undefined;
  __resetChatRequestStateForTests();
  sessionArea().clear();
  localArea().clear();
});

const ORGANIZATION_ID = "00000000-0000-7000-8000-00000000ffff";
const API_ORIGIN = "http://localhost:3001";
const THREAD_ID = "00000000-0000-7000-8000-00000000c0de";
const USER_MESSAGE_ID = "00000000-0000-7000-8000-000000000001";
const ANSWER_ID = "00000000-0000-7000-8000-000000000003";

/** How many deltas a kind streams, and how far apart. */
const DELTAS = 400;
const DELTA_INTERVAL_MS = 2;

// --- The streams ------------------------------------------------------------

const TIMESTAMP = 1_767_225_600_000;

const answerText = (): StreamChunk[] => [
  {
    type: EventType.TEXT_MESSAGE_START,
    messageId: ANSWER_ID,
    role: "assistant",
    timestamp: TIMESTAMP,
  },
  {
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId: ANSWER_ID,
    delta: "Done.",
    timestamp: TIMESTAMP,
  },
  {
    type: EventType.TEXT_MESSAGE_END,
    messageId: ANSWER_ID,
    timestamp: TIMESTAMP,
  },
];

const deltas = (count: number) =>
  Array.from({ length: count }, (_, index) => `d${String(index)} `);

const toolCall = (
  toolCallId: string,
  args: readonly string[],
): StreamChunk[] => [
  {
    type: EventType.TOOL_CALL_START,
    toolCallId,
    toolCallName: "list_templates",
    parentMessageId: ANSWER_ID,
    timestamp: TIMESTAMP,
  },
  ...args.map((delta): StreamChunk => ({
    type: EventType.TOOL_CALL_ARGS,
    toolCallId,
    delta,
    timestamp: TIMESTAMP,
  })),
  { type: EventType.TOOL_CALL_END, toolCallId, timestamp: TIMESTAMP },
];

const toolResult = (toolCallId: string): StreamChunk => ({
  type: EventType.TOOL_CALL_RESULT,
  toolCallId,
  messageId: `result-${toolCallId}`,
  content: '{"templates":[]}',
  timestamp: TIMESTAMP,
});

/** A note the tool input's deltas spell, as one JSON string. */
const argumentDeltas = (count: number): string[] => [
  '{"note":"',
  ...deltas(count - 2),
  '"}',
];

/**
 * What the server streams for each kind: the burst of that kind's deltas,
 * and what the run then settles with. Keyed by every kind, so a new kind
 * fails typecheck here until it has a stream.
 */
const STREAMS = {
  reasoning: () => [
    {
      type: EventType.REASONING_START,
      messageId: "reasoning-1",
      timestamp: TIMESTAMP,
    },
    {
      type: EventType.REASONING_MESSAGE_START,
      messageId: "reasoning-1",
      role: "reasoning",
      timestamp: TIMESTAMP,
    },
    ...deltas(DELTAS).map((delta): StreamChunk => ({
      type: EventType.REASONING_MESSAGE_CONTENT,
      messageId: "reasoning-1",
      delta,
      timestamp: TIMESTAMP,
    })),
    {
      type: EventType.REASONING_MESSAGE_END,
      messageId: "reasoning-1",
      timestamp: TIMESTAMP,
    },
    {
      type: EventType.REASONING_END,
      messageId: "reasoning-1",
      timestamp: TIMESTAMP,
    },
    ...answerText(),
  ],
  status: () => [
    ...Array.from({ length: DELTAS / 4 }, (_, index): StreamChunk[] => {
      const stepName = `step-${String(index)}`;
      return [
        { type: EventType.STEP_STARTED, stepName, timestamp: TIMESTAMP },
        {
          type: EventType.ACTIVITY_SNAPSHOT,
          messageId: "activity-1",
          activityType: "progress",
          content: { done: index },
          timestamp: TIMESTAMP,
        },
        {
          type: EventType.STATE_DELTA,
          delta: [{ op: "replace", path: "/done", value: index }],
          timestamp: TIMESTAMP,
        },
        { type: EventType.STEP_FINISHED, stepName, timestamp: TIMESTAMP },
      ];
    }).flat(),
    ...answerText(),
  ],
  subagent: () => [
    {
      type: EventType.SUBAGENT_STARTED,
      subagentRunId: "subagent-1",
      name: "Clause finder",
      timestamp: TIMESTAMP,
    },
    {
      type: EventType.TEXT_MESSAGE_START,
      messageId: "subagent-message-1",
      role: "assistant",
      subagentRunId: "subagent-1",
      timestamp: TIMESTAMP,
    },
    ...deltas(DELTAS).map((delta): StreamChunk => ({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "subagent-message-1",
      delta,
      subagentRunId: "subagent-1",
      timestamp: TIMESTAMP,
    })),
    {
      type: EventType.TEXT_MESSAGE_END,
      messageId: "subagent-message-1",
      subagentRunId: "subagent-1",
      timestamp: TIMESTAMP,
    },
    {
      type: EventType.SUBAGENT_FINISHED,
      subagentRunId: "subagent-1",
      timestamp: TIMESTAMP,
    },
    ...answerText(),
  ],
  text: () => [
    {
      type: EventType.TEXT_MESSAGE_START,
      messageId: ANSWER_ID,
      role: "assistant",
      timestamp: TIMESTAMP,
    },
    ...deltas(DELTAS).map((delta): StreamChunk => ({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: ANSWER_ID,
      delta,
      timestamp: TIMESTAMP,
    })),
    {
      type: EventType.TEXT_MESSAGE_END,
      messageId: ANSWER_ID,
      timestamp: TIMESTAMP,
    },
  ],
  "tool-input": () => [
    {
      type: EventType.TEXT_MESSAGE_START,
      messageId: ANSWER_ID,
      role: "assistant",
      timestamp: TIMESTAMP,
    },
    ...toolCall("call-input", argumentDeltas(DELTAS)),
    toolResult("call-input"),
    ...answerText(),
  ],
  "tool-output": () => [
    {
      type: EventType.TEXT_MESSAGE_START,
      messageId: ANSWER_ID,
      role: "assistant",
      timestamp: TIMESTAMP,
    },
    // Each result lands as its own chunk: many small calls, answered one
    // after another as a fan-out of tools finishes.
    ...Array.from({ length: DELTAS / 4 }, (_, index) =>
      toolCall(`call-${String(index)}`, ["{}"]),
    ).flat(),
    ...Array.from({ length: DELTAS / 4 }, (_, index) =>
      toolResult(`call-${String(index)}`),
    ),
    ...answerText(),
  ],
} as const satisfies Record<StreamChunkKind, () => StreamChunk[]>;

/** The events of `kind` in a stream: what the burst is made of. */
const eventsOfKind = (
  events: readonly StreamChunk[],
  kind: StreamChunkKind,
): StreamChunk[] => events.filter((event) => streamChunkKindOf(event) === kind);

// --- The fake server --------------------------------------------------------

type Burst = { firstAt: number | undefined; lastAt: number | undefined };

/**
 * Answers the page's chat request with `events` of `kind`, one event every
 * `DELTA_INTERVAL_MS`, framed by the run's start and end; records when the
 * first and the last of the kind's own events reached the page.
 */
const createStreamingServer = (
  kind: StreamChunkKind,
  events: readonly StreamChunk[],
) => {
  const burst: Burst = { firstAt: undefined, lastAt: undefined };
  const unexpected: string[] = [];
  let finished = false;

  const threadPage = () =>
    Response.json({
      activeTurnId: null,
      attachedFiles: { fileCount: 0, files: [] },
      context: null,
      contextMatterIds: [],
      forkProvenance: { type: "none" },
      lastActivityAt: null,
      messages: [],
      model: null,
      olderCursor: null,
      reasoningEffort: null,
      threadExists: false,
      threadRevision: "revision-0",
      usedAnonymization: false,
      webSearchAvailable: false,
      webSearchEnabled: false,
    });

  const answerChat = (runId: string): Response => {
    const stream: StreamChunk[] = [
      {
        type: EventType.RUN_STARTED,
        runId,
        threadId: THREAD_ID,
        timestamp: TIMESTAMP,
      },
      ...events,
      {
        type: EventType.RUN_FINISHED,
        runId,
        threadId: THREAD_ID,
        finishReason: "stop",
        timestamp: TIMESTAMP,
      },
    ];
    const encoder = new TextEncoder();
    let index = 0;
    return new Response(
      new ReadableStream<Uint8Array>({
        pull: async (controller) => {
          await new Promise((resolve) => {
            setTimeout(resolve, DELTA_INTERVAL_MS);
          });
          const event = stream[index];
          index += 1;
          if (event === undefined) {
            finished = true;
            controller.close();
            return;
          }
          if (streamChunkKindOf(event) === kind) {
            const now = performance.now();
            burst.firstAt ??= now;
            burst.lastAt = now;
          }
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  };

  const fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    await Promise.resolve();
    const url = new URL(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";
    if (url.origin === API_ORIGIN && url.pathname === "/v1/chat") {
      const body: unknown = JSON.parse(
        typeof init?.body === "string" ? init.body : "null",
      );
      const runId =
        typeof body === "object" && body !== null
          ? Reflect.get(body, "runId")
          : undefined;
      return answerChat(typeof runId === "string" ? runId : "run-budget");
    }
    if (
      url.origin === API_ORIGIN &&
      method === "GET" &&
      url.pathname === `/v1/chat/threads/${THREAD_ID}/messages`
    ) {
      return threadPage();
    }
    unexpected.push(`${method} ${url.pathname}`);
    return Response.json({ message: "Not served" }, { status: 404 });
  };

  return { burst, fetch, finished: () => finished, unexpected };
};

// --- The measurement --------------------------------------------------------

const sleep = async (ms: number) =>
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Streams `kind` to a freshly loaded page; returns the page's commit rate
 *  while the kind's deltas arrived. */
const commitRateWhileStreaming = async (kind: StreamChunkKind) => {
  const events = STREAMS[kind]();
  const server = createStreamingServer(kind, events);
  routeRequest = server.fetch;
  const commitTimes: number[] = [];
  const page = await openChatThreadDomPage({
    onRender: (_id, _phase, _actual, _base, _start, commitTime) => {
      commitTimes.push(commitTime);
    },
    organizationId: ORGANIZATION_ID,
    threadId: THREAD_ID,
  });
  const sent = Result.tryPromise(
    async () =>
      await page.session().sendMessage({
        content: "Stream please",
        id: toSafeId<"chatMessage">(USER_MESSAGE_ID),
      }),
  );
  for (let wait = 0; wait < 2000 && !server.finished(); wait += 1) {
    await sleep(5);
  }
  // Let the page settle what the end of the run started.
  await sleep(100);
  expect(await sent).toEqual(Result.ok(undefined));
  const { firstAt, lastAt } = server.burst;
  if (firstAt === undefined || lastAt === undefined) {
    return expect.unreachable(`No ${kind} event reached the page`);
  }
  const commits = commitTimes.filter(
    (at) => at >= firstAt && at <= lastAt,
  ).length;
  return {
    commits,
    commitsPerSecond: Math.round((commits * 1000) / (lastAt - firstAt)),
    finished: server.finished(),
    kindEvents: eventsOfKind(events, kind).length,
    unexpected: server.unexpected,
  };
};

const KINDS = Object.keys(STREAM_CHUNK_COMMIT_BUDGET).filter(
  (kind): kind is StreamChunkKind => kind in STREAM_CHUNK_COMMIT_BUDGET,
);

describe(`${ORACLE}: the thread page's commit rate while each kind of chunk streams`, () => {
  test("every budgeted kind is the kind of some event type, and every event type's kind has a budget", () => {
    const placed = new Set(
      Object.values(STREAM_EVENT_KIND).filter(
        (kind): kind is StreamChunkKind => typeof kind === "string",
      ),
    );
    expect([...placed].toSorted()).toEqual(KINDS.toSorted());
  });

  test("every kind's stream carries that kind as many tiny deltas", () => {
    // The fixture reaches the fault: a kind that streamed a handful of
    // events could not tell a page that commits per delta from one that
    // does not.
    expect(
      KINDS.filter(
        (kind) => eventsOfKind(STREAMS[kind](), kind).length < DELTAS / 4,
      ),
    ).toEqual([]);
  });

  for (const kind of KINDS) {
    const { commitsPerSecond: budget, streams } =
      STREAM_CHUNK_COMMIT_BUDGET[kind];
    test(`the thread page commits at a bounded rate while ${kind} streams`, async () => {
      const measured = await commitRateWhileStreaming(kind);
      expect(measured.unexpected).toEqual([]);
      expect(measured.finished).toBe(true);
      const detail = `${ORACLE}: ${String(measured.commits)} commits while ${streams} streamed (${String(measured.kindEvents)} events), budget ${String(budget)}/s`;
      expect(measured.commitsPerSecond, detail).toBeLessThanOrEqual(budget);
    }, 30_000);
  }
});
