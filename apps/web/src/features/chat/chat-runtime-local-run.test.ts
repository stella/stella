import { panic } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";

import {
  CHAT_LOCAL_RUN_REQUESTS_METADATA_KEY,
  type ChatLocalRunRequest,
  type ChatLocalRunRequestAnswerOutcome,
} from "@stll/api-contract/chat-local-run-request";
import {
  CHAT_LOCAL_RUN_COMPUTER_EVENT,
  CHAT_LOCAL_RUN_STEER_EVENT,
  CHAT_LOCAL_RUN_STEER_SOURCE,
  type ChatLocalRunComputerEvent,
} from "@stll/api-contract/chat-run-target";
import {
  CHAT_TURN_STEERING,
  CHAT_TURN_STEERING_EVENT,
  type ChatTurnSteering,
} from "@stll/api-contract/chat-send-intent";

import { openMemberWaitKeys } from "@/components/chat/chat-ui-tools";
import type { PersistedChatMessage } from "@/components/chat/chat-ui-tools";
import { toChatThreadId } from "@/lib/chat-thread-ref";
import { toSafeId } from "@/lib/safe-id";

import { createChatRuntime } from "./chat-runtime";

const previousFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = previousFetch;
});

const RUN_ID = "run-local";
const THREAD_ID = "thread-local";

const computerEvent = (value: ChatLocalRunComputerEvent) => ({
  type: "CUSTOM",
  name: CHAT_LOCAL_RUN_COMPUTER_EVENT,
  value,
});

/**
 * A server whose running turn the page rejoins: the run log replays what the
 * test sends, and the stream stays open until the test ends it.
 */
const installRunningTurn = () => {
  const encoder = new TextEncoder();
  let sent = 0;
  let joined: ReadableStreamDefaultController<Uint8Array> | null = null;
  /** Whether the run log ended, before the page joined it or after. */
  let ended = false;
  const queued: unknown[] = [];
  /** The bodies of the steers the page posted, in order. */
  const steers: unknown[] = [];
  const steerPosted = Promise.withResolvers<undefined>();
  /** The answers to the run's requests the page posted, in order. */
  const answers: { path: string; body: unknown }[] = [];
  let answerPosted = Promise.withResolvers<undefined>();
  /** What the server says to each answer, in order; held until the test
   *  settles it. */
  const answerReplies: PromiseWithResolvers<Response>[] = [];
  /** Writes the page made other than steering and answering. */
  const others: string[] = [];
  const write = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    event: unknown,
  ) => {
    controller.enqueue(
      encoder.encode(`id: ${String(sent)}\ndata: ${JSON.stringify(event)}\n\n`),
    );
    sent += 1;
  };
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (new URL(url, "http://localhost").pathname.endsWith("/steer")) {
        const request =
          input instanceof Request
            ? input
            : new Request(new URL(url, "http://localhost"), init);
        steers.push(await request.json());
        steerPosted.resolve(undefined);
        // Taken to the computer; the turn's stream says what became of it.
        return Response.json({ steer: { type: "queued" } });
      }
      const pathname = new URL(url, "http://localhost").pathname;
      if (/\/requests\/[^/]+\/answer$/u.test(pathname)) {
        const request =
          input instanceof Request
            ? input
            : new Request(new URL(url, "http://localhost"), init);
        answers.push({ path: pathname, body: await request.json() });
        const reply = Promise.withResolvers<Response>();
        answerReplies.push(reply);
        answerPosted.resolve(undefined);
        return await reply.promise;
      }
      if (url.includes("/join")) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start: (controller) => {
              joined = controller;
              for (const event of queued.splice(0)) {
                write(controller, event);
              }
              if (ended) {
                controller.close();
              }
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      }
      // Reading where the turn stands is how a rejoin begins; anything else
      // (a send, a continuation) would be the page acting on the turn.
      const method =
        init?.method ?? (input instanceof Request ? input.method : "GET");
      if (method !== "GET") {
        others.push(`${method} ${pathname}`);
      }
      return Response.json({
        type: "running",
        turnId: "turn-local",
        runId: RUN_ID,
      });
    },
    { preconnect: () => undefined },
  );
  return {
    send: (...events: unknown[]) => {
      for (const event of events) {
        if (joined === null) {
          queued.push(event);
        } else {
          write(joined, event);
        }
      }
    },
    end: () => {
      if (!ended) {
        ended = true;
        joined?.close();
      }
    },
    steers,
    /** Settles once the page has posted a steer. */
    steerPosted: steerPosted.promise,
    answers,
    others,
    /** Settles once the page has posted an answer since the last reply. */
    answerPosted: () => answerPosted.promise,
    /** The server's reply to the latest answer the page posted. */
    replyToAnswer: (response: Response) => {
      const reply =
        answerReplies.at(-1) ?? panic("No answer is waiting on a reply");
      answerPosted = Promise.withResolvers<undefined>();
      reply.resolve(response);
    },
  };
};

const TURN_ID = "018f0000-0000-7000-8000-00000000000b";

const QUESTION_MESSAGE: PersistedChatMessage = {
  id: "question",
  role: "user",
  parts: [{ type: "text", content: "Which leases end this year?" }],
};

/** A page loaded while its thread's turn still runs: a reload mid-turn. */
const openLoadedTurn = (
  activeTurnSteering?: ChatTurnSteering,
  initialMessages: PersistedChatMessage[] = [QUESTION_MESSAGE],
  onError: (error: Error) => void = () => undefined,
) =>
  createChatRuntime({
    activeTurnId: toSafeId<"chatTurn">(TURN_ID),
    activeTurnSteering,
    context: undefined,
    initialMessages,
    key: { scope: "global", threadId: toChatThreadId(THREAD_ID) },
    onError,
    onFinish: () => undefined,
    reloadThread: () => undefined,
  });

const awaitSnapshot = async (
  runtime: ReturnType<typeof openLoadedTurn>,
  condition: (snapshot: ReturnType<typeof runtime.getSnapshot>) => boolean,
) => {
  if (condition(runtime.getSnapshot())) {
    return;
  }
  const done = Promise.withResolvers<undefined>();
  const unsubscribe = runtime.subscribe(() => {
    if (condition(runtime.getSnapshot())) {
      done.resolve(undefined);
    }
  });
  try {
    await done.promise;
  } finally {
    unsubscribe();
  }
};

const answerText = (runtime: ReturnType<typeof openLoadedTurn>) =>
  runtime
    .getSnapshot()
    .messages.filter(({ role }) => role === "assistant")
    .flatMap(({ parts }) =>
      parts.flatMap((part) => (part.type === "text" ? [part.content] : [])),
    )
    .join("");

test("a page loaded while the turn's computer is away shows the wait until output resumes", async () => {
  const server = installRunningTurn();
  server.send(
    { type: "RUN_STARTED", runId: RUN_ID, threadId: THREAD_ID },
    { type: "TEXT_MESSAGE_START", messageId: "answer", role: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "answer", delta: "Lease " },
    computerEvent({ status: "waiting" }),
  );
  const runtime = openLoadedTurn();
  const unsubscribe = runtime.subscribe(() => undefined);
  try {
    await awaitSnapshot(runtime, (snapshot) => snapshot.computerWait !== null);
    expect(runtime.getSnapshot()).toMatchObject({
      isLoading: true,
      computerWait: { status: "waiting" },
    });
    expect(answerText(runtime)).toBe("Lease ");
    // The page joined this turn; its live status counts from the server.
    expect(runtime.getSnapshot().turnSentAt).toBeNull();

    server.send(computerEvent({ status: "connected" }), {
      type: "TEXT_MESSAGE_CONTENT",
      messageId: "answer",
      delta: "one",
    });
    await awaitSnapshot(runtime, (snapshot) => snapshot.computerWait === null);
    // The computer is back while the turn still runs, not because it ended.
    expect(runtime.getSnapshot().isLoading).toBe(true);

    server.send(
      { type: "TEXT_MESSAGE_END", messageId: "answer" },
      { type: "RUN_FINISHED", runId: RUN_ID, threadId: THREAD_ID },
    );
    server.end();
    await awaitSnapshot(runtime, (snapshot) => !snapshot.isLoading);
    expect(answerText(runtime)).toBe("Lease one");
    expect(runtime.getSnapshot().computerWait).toBeNull();
  } finally {
    unsubscribe();
  }
});

test("a turn that ends while its computer is away leaves no wait behind", async () => {
  const server = installRunningTurn();
  server.send(
    { type: "RUN_STARTED", runId: RUN_ID, threadId: THREAD_ID },
    computerEvent({ status: "waiting" }),
  );
  const runtime = openLoadedTurn();
  const unsubscribe = runtime.subscribe(() => undefined);
  try {
    await awaitSnapshot(runtime, (snapshot) => snapshot.computerWait !== null);
    server.send({
      type: "RUN_ERROR",
      runId: RUN_ID,
      threadId: THREAD_ID,
      message: "The computer stopped running the turn.",
      code: "local_runner_unavailable",
    });
    server.end();
    await awaitSnapshot(runtime, (snapshot) => !snapshot.isLoading);
    expect(runtime.getSnapshot().computerWait).toBeNull();
  } finally {
    unsubscribe();
  }
});

test("a turn its computer has not picked up yet waits from when it was sent, until the computer has it", async () => {
  const sentAt = "2026-11-11T08:56:51.000Z";
  const server = installRunningTurn();
  server.send(
    { type: "RUN_STARTED", runId: RUN_ID, threadId: THREAD_ID },
    computerEvent({ status: "delivering", since: sentAt }),
  );
  const runtime = openLoadedTurn();
  const unsubscribe = runtime.subscribe(() => undefined);
  try {
    await awaitSnapshot(runtime, (snapshot) => snapshot.computerWait !== null);
    expect(runtime.getSnapshot().computerWait).toEqual({
      status: "delivering",
      since: sentAt,
    });
    server.send(computerEvent({ status: "connected" }), {
      type: "TEXT_MESSAGE_START",
      messageId: "answer",
      role: "assistant",
    });
    await awaitSnapshot(runtime, (snapshot) => snapshot.computerWait === null);
    expect(runtime.getSnapshot().isLoading).toBe(true);
    server.send({ type: "RUN_FINISHED", runId: RUN_ID, threadId: THREAD_ID });
    server.end();
    await awaitSnapshot(runtime, (snapshot) => !snapshot.isLoading);
  } finally {
    unsubscribe();
  }
});

test("a turn takes a message mid-turn only once the server says so, from the page or the turn's stream", async () => {
  const server = installRunningTurn();
  // The page read before the turn's computer was known to take messages.
  const runtime = openLoadedTurn(CHAT_TURN_STEERING.notSteerable);
  const unsubscribe = runtime.subscribe(() => undefined);
  try {
    expect(runtime.getSnapshot().turnSteering).toBe(
      CHAT_TURN_STEERING.notSteerable,
    );
    server.send(
      { type: "RUN_STARTED", runId: RUN_ID, threadId: THREAD_ID },
      {
        type: "CUSTOM",
        name: CHAT_TURN_STEERING_EVENT,
        value: { steering: CHAT_TURN_STEERING.steerable },
      },
    );
    await awaitSnapshot(
      runtime,
      (snapshot) => snapshot.turnSteering === CHAT_TURN_STEERING.steerable,
    );
    // An event it cannot read changes nothing.
    server.send({
      type: "CUSTOM",
      name: CHAT_TURN_STEERING_EVENT,
      value: { steering: "sometimes" },
    });
    server.send({ type: "RUN_FINISHED", runId: RUN_ID, threadId: THREAD_ID });
    server.end();
    await awaitSnapshot(runtime, (snapshot) => !snapshot.isLoading);
    // A wait outlives its request, so what the turn takes outlives it too.
    expect(runtime.getSnapshot().turnSteering).toBe(
      CHAT_TURN_STEERING.steerable,
    );
  } finally {
    unsubscribe();
  }
});

test("a page opened on a turn that takes messages says so before its stream does", () => {
  expect(
    openLoadedTurn(CHAT_TURN_STEERING.steerable).getSnapshot().turnSteering,
  ).toBe(CHAT_TURN_STEERING.steerable);
  // Absent, as on a file thread, the turn takes none.
  expect(openLoadedTurn().getSnapshot().turnSteering).toBe(
    CHAT_TURN_STEERING.notSteerable,
  );
});

test("a message handed to the running turn is always one the page queued, at the revision it read", async () => {
  const server = installRunningTurn();
  const runtime = openLoadedTurn(CHAT_TURN_STEERING.steerable);
  const unsubscribe = runtime.subscribe(() => undefined);
  const inputId = "018f0000-0000-7000-8000-0000000000c1";
  try {
    server.send({ type: "RUN_STARTED", runId: RUN_ID, threadId: THREAD_ID });
    await awaitSnapshot(runtime, (snapshot) => snapshot.isLoading);

    const steering = runtime.steerLocalTurn({
      inputId,
      text: "Only the Prague leases, please.",
      revision: 3,
    });
    await server.steerPosted;
    // The queue shows the message until the turn takes it, and the server
    // removes it from the queue at this revision when the turn does.
    expect(server.steers).toEqual([
      {
        inputId,
        text: "Only the Prague leases, please.",
        source: { type: CHAT_LOCAL_RUN_STEER_SOURCE.queued, revision: 3 },
      },
    ]);

    server.send({
      type: "CUSTOM",
      name: CHAT_LOCAL_RUN_STEER_EVENT,
      value: { inputId, status: "steered" },
    });
    expect(await steering).toEqual({ type: "steered" });

    server.send({ type: "RUN_FINISHED", runId: RUN_ID, threadId: THREAD_ID });
    server.end();
    await awaitSnapshot(runtime, (snapshot) => !snapshot.isLoading);
  } finally {
    unsubscribe();
  }
});

// --- What the run on the member's computer asks, beside its running turn ---

const ANSWER_ID = "answer-local";
const CALL_ID = "local:run-local:item_cmd";
const QUESTION_CALL_ID = "local:run-local:item_q";
const APPROVAL_REQUEST_ID = "018f0000-0000-7000-8000-0000000000a1";
const QUESTION_REQUEST_ID = "018f0000-0000-7000-8000-0000000000a2";

const approvalRequest = {
  requestId: APPROVAL_REQUEST_ID,
  toolCallId: CALL_ID,
  status: "pending",
  ask: {
    kind: "approval",
    message: "Run the formatter over the draft",
    reason: null,
    toolName: "command_execution",
    input: { command: "format draft.txt" },
    approvalKind: null,
    decisions: ["approve", "approve_for_session", "deny"],
  },
} as const satisfies ChatLocalRunRequest;

const questionRequest = {
  requestId: QUESTION_REQUEST_ID,
  toolCallId: QUESTION_CALL_ID,
  status: "pending",
  ask: {
    kind: "question",
    questions: [
      {
        id: "law",
        header: "Governing law",
        prompt: "Which law governs the lease?",
        options: [
          { label: "Czech", description: "" },
          { label: "Slovak", description: "" },
        ],
        allowsFreeText: false,
        multiSelect: false,
        secret: false,
      },
    ],
  },
} as const satisfies ChatLocalRunRequest;

/** The run opens its answer and a call of `toolName`, as the stream does. */
const openedCall = (toolCallId: string, toolName: string) => [
  { type: "RUN_STARTED", runId: RUN_ID, threadId: THREAD_ID },
  { type: "TEXT_MESSAGE_START", messageId: ANSWER_ID, role: "assistant" },
  {
    type: "TOOL_CALL_START",
    parentMessageId: ANSWER_ID,
    toolCallId,
    toolCallName: toolName,
    toolName,
  },
  { type: "TOOL_CALL_ARGS", toolCallId, delta: "{}" },
  {
    type: "TOOL_CALL_END",
    toolCallId,
    toolCallName: toolName,
    toolName,
    input: {},
  },
];

/** The stream restating every request of the answer, as the API does. */
const restated = (...requests: ChatLocalRunRequest[]) => ({
  type: "TEXT_MESSAGE_START",
  messageId: ANSWER_ID,
  role: "assistant",
  metadata: { [CHAT_LOCAL_RUN_REQUESTS_METADATA_KEY]: requests },
});

const outcome = (value: ChatLocalRunRequestAnswerOutcome) =>
  Response.json({ outcome: value });

const answerPath = (requestId: string) =>
  `/chat/threads/${THREAD_ID}/turns/${TURN_ID}/requests/${requestId}/answer`;

type Snapshot = ReturnType<ReturnType<typeof openLoadedTurn>["getSnapshot"]>;

/** Whether the page holds the call `request` is about, with the request as
 *  the stream last restated it on the call's answer. */
const holdsRequest = (snapshot: Snapshot, request: ChatLocalRunRequest) =>
  snapshot.messages.some(
    ({ metadata, parts }) =>
      parts.some(
        (part) => part.type === "tool-call" && part.id === request.toolCallId,
      ) &&
      JSON.stringify(metadata?.[CHAT_LOCAL_RUN_REQUESTS_METADATA_KEY]) ===
        JSON.stringify([request]),
  );

/** A page rejoined on the running turn, which has asked `request`. */
const openAsking = async (
  request: ChatLocalRunRequest,
  toolName: string,
  onError?: (error: Error) => void,
) => {
  const server = installRunningTurn();
  const runtime = openLoadedTurn(undefined, [QUESTION_MESSAGE], onError);
  const unsubscribe = runtime.subscribe(() => undefined);
  server.send(...openedCall(request.toolCallId, toolName), restated(request));
  await awaitSnapshot(runtime, (snapshot) => holdsRequest(snapshot, request));
  return {
    server,
    runtime,
    /** The run ends, and the page with it. */
    close: async () => {
      if (runtime.getSnapshot().isLoading) {
        server.send({
          type: "RUN_FINISHED",
          runId: RUN_ID,
          threadId: THREAD_ID,
        });
        server.end();
        await awaitSnapshot(runtime, (snapshot) => !snapshot.isLoading);
      }
      unsubscribe();
    },
  };
};

describe("a step the run asks the member to approve", () => {
  test("is answered once, at the run's request, while its turn still runs", async () => {
    const { close, runtime, server } = await openAsking(
      approvalRequest,
      "command_execution",
    );
    try {
      const response = { approved: true, id: APPROVAL_REQUEST_ID } as const;
      // A second click while the first answer is on its way joins it.
      const first = runtime.resolveToolApproval(response);
      const second = runtime.resolveToolApproval(response);
      await server.answerPosted();
      expect(runtime.getSnapshot().isLoading).toBe(true);
      server.replyToAnswer(outcome({ type: "answered" }));
      await Promise.all([first, second]);

      expect(server.answers).toHaveLength(1);
      expect(server.answers[0]?.path).toEndWith(
        answerPath(APPROVAL_REQUEST_ID),
      );
      expect(server.answers[0]?.body).toEqual({
        answer: { type: "approval", decision: "approve" },
      });
      // The turn never paused: nothing resumed it or sent it again.
      expect(server.others).toEqual([]);
      expect(runtime.getSnapshot()).toMatchObject({
        isLoading: true,
        error: undefined,
      });

      server.send(restated({ ...approvalRequest, status: "resolved" }), {
        type: "RUN_FINISHED",
        runId: RUN_ID,
        threadId: THREAD_ID,
      });
      server.end();
      await awaitSnapshot(runtime, (snapshot) => !snapshot.isLoading);
    } finally {
      await close();
    }
  });

  test.each([
    [{ approved: true }, "approve"],
    [{ approved: true, scope: "session" }, "approve_for_session"],
    [{ approved: false }, "deny"],
  ] as const)("answers %o as %s", async (response, decision) => {
    const { close, runtime, server } = await openAsking(
      approvalRequest,
      "command_execution",
    );
    try {
      const answering = runtime.resolveToolApproval({
        ...response,
        id: APPROVAL_REQUEST_ID,
      });
      await server.answerPosted();
      server.replyToAnswer(outcome({ type: "answered" }));
      await answering;
      expect(server.answers.map(({ body }) => body)).toEqual([
        { answer: { type: "approval", decision } },
      ]);
    } finally {
      await close();
    }
  });

  test("an answer that did not reach the run fails visibly, and the next click sends it again", async () => {
    const errors: Error[] = [];
    const { close, runtime, server } = await openAsking(
      approvalRequest,
      "command_execution",
      (error) => {
        errors.push(error);
      },
    );
    try {
      const response = { approved: true, id: APPROVAL_REQUEST_ID } as const;
      const failed = runtime.resolveToolApproval(response);
      await server.answerPosted();
      server.replyToAnswer(
        Response.json({ message: "Unavailable" }, { status: 503 }),
      );
      await failed;
      expect(errors).not.toEqual([]);
      expect(runtime.getSnapshot().error).toBeDefined();

      const retried = runtime.resolveToolApproval(response);
      await server.answerPosted();
      server.replyToAnswer(outcome({ type: "answered" }));
      await retried;
      expect(server.answers.map(({ body }) => body)).toEqual([
        { answer: { type: "approval", decision: "approve" } },
        { answer: { type: "approval", decision: "approve" } },
      ]);
    } finally {
      await close();
    }
  });
});

describe("a question the run asks beside its turn", () => {
  test("is read from the answer's metadata as the stream restates it, and closes when it does", async () => {
    const { close, runtime, server } = await openAsking(
      questionRequest,
      "request_user_input",
    );
    try {
      expect(runtime.getSnapshot()).toMatchObject({
        isLoading: true,
        localRunQuestion: {
          interruptId: QUESTION_REQUEST_ID,
          questions: questionRequest.ask.questions,
        },
      });

      server.send(restated({ ...questionRequest, status: "resolved" }));
      await awaitSnapshot(
        runtime,
        (snapshot) => snapshot.localRunQuestion === null,
      );
      expect(runtime.getSnapshot().isLoading).toBe(true);
    } finally {
      await close();
    }
  });

  test("reads the same on a page reloaded mid-turn as on the page that streamed it", async () => {
    const { close, runtime } = await openAsking(
      questionRequest,
      "request_user_input",
    );
    try {
      const live = runtime.getSnapshot();
      expect(openMemberWaitKeys(live)).toContain(
        `interrupt:${QUESTION_REQUEST_ID}`,
      );
      // The answer as the thread stores it: the stream's metadata, and no
      // resume snapshot behind it.
      expect(live.messages.at(-1)?.metadata).not.toHaveProperty(
        "resumeSnapshot",
      );

      // A reload mid-turn: the page loads the stored answer and joins the
      // turn, whose stream replays the run from its start.
      const rejoined = installRunningTurn();
      rejoined.send(
        ...openedCall(QUESTION_CALL_ID, "request_user_input"),
        restated(questionRequest),
      );
      const reloaded = openLoadedTurn(undefined, [...live.messages]);
      const unsubscribeReloaded = reloaded.subscribe(() => undefined);
      try {
        await awaitSnapshot(
          reloaded,
          (snapshot) =>
            snapshot.status === "streaming" &&
            snapshot.localRunQuestion !== null,
        );
        expect(reloaded.getSnapshot().localRunQuestion).toEqual(
          live.localRunQuestion,
        );
        expect(openMemberWaitKeys(reloaded.getSnapshot())).toEqual(
          openMemberWaitKeys(live),
        );
      } finally {
        rejoined.send({
          type: "RUN_FINISHED",
          runId: RUN_ID,
          threadId: THREAD_ID,
        });
        rejoined.end();
        await awaitSnapshot(reloaded, (snapshot) => !snapshot.isLoading);
        unsubscribeReloaded();
      }
    } finally {
      await close();
    }
  });

  test.each([
    [{ law: ["Czech"] }, { type: "question", answers: { law: ["Czech"] } }],
    [null, { type: "dismiss" }],
  ] as const)(
    "answers %o at the run's request as %o",
    async (given, answer) => {
      const { close, runtime, server } = await openAsking(
        questionRequest,
        "request_user_input",
      );
      try {
        const delivery = runtime.answerLocalRunQuestion(
          QUESTION_REQUEST_ID,
          given,
        );
        await server.answerPosted();
        server.replyToAnswer(outcome({ type: "answered" }));
        expect(await delivery).toBe("sent");
        expect(server.answers.map(({ body }) => body)).toEqual([{ answer }]);
        expect(server.answers[0]?.path).toEndWith(
          answerPath(QUESTION_REQUEST_ID),
        );
        expect(server.others).toEqual([]);
      } finally {
        await close();
      }
    },
  );
});
