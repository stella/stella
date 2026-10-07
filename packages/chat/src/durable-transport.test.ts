import { ChatClient } from "@tanstack/ai-client";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";
import { rejectionOf } from "@stll/property-testing/rejection";

import { createDurableChatTransport } from "./durable-transport";

const RUN_ID = "run-rejoin";
const THREAD_ID = "thread-rejoin";
const encoder = new TextEncoder();
const events = [
  { type: "RUN_STARTED", runId: RUN_ID, threadId: THREAD_ID },
  { type: "TEXT_MESSAGE_START", messageId: "answer", role: "assistant" },
  ...["First", " café", "\n", "العربية", " complete."].map((delta) => ({
    type: "TEXT_MESSAGE_CONTENT",
    messageId: "answer",
    delta,
  })),
  { type: "TEXT_MESSAGE_END", messageId: "answer" },
  { type: "RUN_FINISHED", runId: RUN_ID, threadId: THREAD_ID },
];
const response = (from: number, cut: number | undefined) => {
  let position = from;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (cut !== undefined && position === cut) {
          controller.error(new TypeError("Connection dropped"));
          return;
        }
        const event = events.at(position);
        if (event === undefined) {
          controller.close();
          return;
        }
        controller.enqueue(
          encoder.encode(`id: ${position}\ndata: ${JSON.stringify(event)}\n\n`),
        );
        position += 1;
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );
};
const setup = (cut?: number) => {
  let calls = 0;
  let probes = 0;
  const fetchClient = Object.assign(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      if (init?.method === "GET") {
        const last = new Headers(init.headers).get("Last-Event-ID");
        return response(last === null ? 0 : Number(last) + 1, undefined);
      }
      return response(0, cut);
    },
    { preconnect: () => undefined },
  );
  const transport = createDurableChatTransport({
    initialTurn: { type: "settled" },
    threadId: THREAD_ID,
    initialMessages: [],
    sendUrl: "https://chat.test/chat",
    joinUrl: () => "https://chat.test/join",
    fetchClient,
    probe: async () => {
      probes += 1;
      return { type: "running", turnId: "turn-rejoin", runId: RUN_ID };
    },
    onReconnectChange: () => undefined,
    onTranscript: () => undefined,
    onError: (error) => {
      throw error;
    },
    wait: async () => undefined,
    random: () => 0,
  });
  return { transport, calls: () => calls, probes: () => probes };
};
const collect = async (stream: AsyncIterable<unknown>) => {
  const chunks: unknown[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
};
describe("durable chat transport", () => {
  test("every delivered chunk boundary rejoins without duplicated or missing events", async () => {
    const uninterrupted = setup();
    const expected = await collect(
      uninterrupted.transport.connection.connect([], {}, undefined, {
        runId: RUN_ID,
        threadId: THREAD_ID,
      }),
    );
    for (let cut = 1; cut < events.length; cut += 1) {
      const interrupted = setup(cut);
      const actual = await collect(
        interrupted.transport.connection.connect([], {}, undefined, {
          runId: RUN_ID,
          threadId: THREAD_ID,
        }),
      );
      expect(actual).toEqual(expected);
      expect(interrupted.calls()).toBe(2);
      expect(interrupted.probes()).toBe(1);
    }
  });
  test("chat rejoin preserves events at generated disconnect boundaries", async () => {
    await assertProperty(
      "chat rejoin preserves events at generated disconnect boundaries",
      fc.asyncProperty(
        fc.integer({ min: 1, max: events.length - 1 }),
        async (cut) => {
          const uninterrupted = setup();
          const interrupted = setup(cut);
          const run = { runId: RUN_ID, threadId: THREAD_ID };
          expect(
            await collect(
              interrupted.transport.connection.connect([], {}, undefined, run),
            ),
          ).toEqual(
            await collect(
              uninterrupted.transport.connection.connect(
                [],
                {},
                undefined,
                run,
              ),
            ),
          );
          expect(interrupted.calls()).toBe(2);
        },
      ),
      { numRuns: 30 },
    );
  });
  test("server truth restores a running turn without storing transcript text on the device", async () => {
    const { transport } = setup();
    const snapshot = await transport.persistence.getItem(THREAD_ID);
    expect(snapshot).toEqual({
      messages: [],
      resume: { resumeState: { threadId: THREAD_ID, runId: RUN_ID } },
    });
  });
  test("settled probe falls back without opening a provider request", async () => {
    let requests = 0;
    let reloads = 0;
    const transport = createDurableChatTransport({
      initialTurn: { type: "settled" },
      threadId: THREAD_ID,
      initialMessages: [],
      sendUrl: "https://chat.test/chat",
      joinUrl: () => "https://chat.test/join",
      fetchClient: Object.assign(
        async () => {
          requests += 1;
          return response(0, undefined);
        },
        { preconnect: () => undefined },
      ),
      probe: async () => ({ type: "transcript", turnId: "turn-rejoin" }),
      onReconnectChange: () => undefined,
      onTranscript: () => {
        reloads += 1;
      },
      onError: (error) => {
        throw error;
      },
    });
    const chunks = await collect(transport.connection.joinRun(RUN_ID));
    expect(requests).toBe(0);
    expect(reloads).toBe(1);
    expect(chunks.at(-1)).toMatchObject({
      type: "RUN_FINISHED",
      runId: RUN_ID,
    });
  });
  test("a preparing turn is probed with jittered backoff until its run is bound", async () => {
    let probes = 0;
    const delays: number[] = [];
    const transport = createDurableChatTransport({
      initialTurn: { type: "settled" },
      threadId: THREAD_ID,
      initialMessages: [],
      sendUrl: "https://chat.test/chat",
      joinUrl: () => "https://chat.test/join",
      fetchClient: Object.assign(async () => response(0, undefined), {
        preconnect: () => undefined,
      }),
      probe: async () => {
        probes += 1;
        return probes < 3
          ? { type: "preparing", turnId: "turn-rejoin" }
          : { type: "running", turnId: "turn-rejoin", runId: RUN_ID };
      },
      random: () => 0,
      wait: async (delay) => {
        delays.push(delay);
      },
      onReconnectChange: () => undefined,
      onTranscript: () => undefined,
      onError: (error) => {
        throw error;
      },
    });
    expect(await transport.persistence.getItem(THREAD_ID)).toMatchObject({
      resume: { resumeState: { runId: RUN_ID } },
    });
    expect(delays).toEqual([250, 500]);
    expect(probes).toBe(3);
  });

  test("parked native approval is restored from the persisted server snapshot", async () => {
    const resumeSnapshot = {
      resumeState: { threadId: THREAD_ID, runId: RUN_ID },
      pendingInterrupts: [
        {
          id: "approval",
          reason: "tool-approval",
          toolCallId: "call-approval",
          responseSchema: { type: "boolean" },
        },
      ],
    };
    const transport = createDurableChatTransport({
      initialTurn: { type: "settled" },
      threadId: THREAD_ID,
      initialMessages: [],
      sendUrl: "https://chat.test/chat",
      joinUrl: () => "https://chat.test/join",
      fetchClient: Object.assign(async () => response(0, undefined), {
        preconnect: () => undefined,
      }),
      probe: async () => ({
        type: "transcript",
        turnId: "turn-rejoin",
        resumeSnapshot,
      }),
      onReconnectChange: () => undefined,
      onTranscript: () => undefined,
      onError: (error) => {
        throw error;
      },
    });
    expect(await transport.persistence.getItem(THREAD_ID)).toEqual({
      messages: [],
      resume: resumeSnapshot,
    });
  });

  test("reloading a parked approval restores its card and resumes the same native turn once", async () => {
    const requests: unknown[] = [];
    let reloads = 0;
    const restored = Promise.withResolvers<undefined>();
    const completed = Promise.withResolvers<undefined>();
    let loading: "idle" | "started" = "idle";
    const resumeSnapshot = {
      resumeState: { threadId: THREAD_ID, runId: RUN_ID },
      pendingInterrupts: [
        {
          id: "approval_call-approval",
          reason: "tool_call",
          toolCallId: "call-approval",
          metadata: {
            kind: "approval",
            toolName: "save-draft",
            input: { title: "Confidentiality terms" },
            "tanstack:interruptBinding": {
              v: 1,
              kind: "tool-approval",
              interruptId: "approval_call-approval",
              interruptedRunId: RUN_ID,
              generation: 0,
              toolName: "save-draft",
              toolCallId: "call-approval",
              originalArgs: { title: "Confidentiality terms" },
              inputSchemaHash: "server-owned",
              approvalSchemaHash: "server-owned",
              responseSchemaHash: "server-owned",
            },
          },
        },
      ],
    };
    const transport = createDurableChatTransport({
      initialTurn: { type: "parked", runId: RUN_ID },
      threadId: THREAD_ID,
      initialMessages: [
        {
          id: "parked-answer",
          role: "assistant",
          parts: [
            {
              type: "tool-call",
              id: "call-approval",
              name: "save-draft",
              arguments: '{"title":"Confidentiality terms"}',
              state: "approval-requested",
            },
          ],
        },
      ],
      sendUrl: "https://chat.test/chat",
      joinUrl: () => "https://chat.test/join",
      fetchClient: Object.assign(
        async (_input: RequestInfo | URL, init?: RequestInit) => {
          if (typeof init?.body !== "string") {
            throw new TypeError("Expected a JSON request body");
          }
          const body: unknown = JSON.parse(init.body);
          requests.push(body);
          return response(0, undefined);
        },
        { preconnect: () => undefined },
      ),
      probe: async () => ({
        type: "transcript",
        turnId: "turn-rejoin",
        resumeSnapshot,
      }),
      onReconnectChange: () => undefined,
      onTranscript: () => {
        reloads += 1;
      },
      onError: (error) => {
        restored.reject(error);
        completed.reject(error);
      },
    });
    const client = new ChatClient({
      threadId: THREAD_ID,
      connection: transport.connection,
      persistence: transport.persistence,
      onInterruptStateChange: ({ interrupts }) => {
        if (interrupts.length === 1) {
          restored.resolve(undefined);
        }
      },
      onLoadingChange: (isLoading) => {
        if (isLoading) {
          loading = "started";
        }
        if (!isLoading && loading === "started") {
          completed.resolve(undefined);
        }
      },
      onError: (error) => {
        restored.reject(error);
        completed.reject(error);
      },
    });
    client.attach();
    try {
      await restored.promise;
      expect(reloads).toBe(0);
      expect(requests).toHaveLength(0);
      expect(client.getResumeState()).toEqual({
        threadId: THREAD_ID,
        runId: RUN_ID,
      });
      const approval = client.getInterrupts().at(0);
      // Dynamic server tools are bound as generic native interrupts, as in web.
      expect(approval?.kind).toBe("generic");
      if (approval?.kind !== "generic") {
        return;
      }
      expect(approval.canResolve).toBe(true);
      expect(client.getMessages().at(-1)?.parts).toMatchObject([
        { type: "tool-call", state: "approval-requested" },
      ]);
      approval.resolveInterrupt({ approved: true });
      await completed.promise;
      expect(requests).toHaveLength(1);
      expect(requests.at(0)).toMatchObject({
        threadId: THREAD_ID,
        parentRunId: RUN_ID,
        resume: [
          {
            interruptId: "approval_call-approval",
            status: "resolved",
            payload: { approved: true },
          },
        ],
      });
      expect(client.getInterrupts()).toHaveLength(0);
      expect(
        client
          .getMessages()
          .some(({ parts }) =>
            parts.some(
              (part) =>
                part.type === "text" && part.content.endsWith(" complete."),
            ),
          ),
      ).toBe(true);
    } finally {
      client.detach();
    }
  });

  test("a malformed JSON join response is surfaced instead of treated as a settled transcript", async () => {
    const errors: Error[] = [];
    let reloads = 0;
    const transport = createDurableChatTransport({
      initialTurn: { type: "settled" },
      threadId: THREAD_ID,
      initialMessages: [],
      sendUrl: "https://chat.test/chat",
      joinUrl: () => "https://chat.test/join",
      fetchClient: Object.assign(
        async () => Response.json({ type: "unknown-state" }),
        { preconnect: () => undefined },
      ),
      probe: async () => ({
        type: "running",
        turnId: "turn-rejoin",
        runId: RUN_ID,
      }),
      onReconnectChange: () => undefined,
      onTranscript: () => {
        reloads += 1;
      },
      onError: (error) => {
        errors.push(error);
      },
    });
    expect(
      await rejectionOf(collect(transport.connection.joinRun(RUN_ID))),
    ).toMatchObject({
      message: expect.stringContaining("502"),
    });
    expect(errors.at(0)?.message).toBe("Invalid chat rejoin response.");
    expect(reloads).toBe(0);
  });
  test("loader lifecycle refreshes changed server truth once and retains the same parked turn", async () => {
    const parkedSnapshot = {
      resumeState: { threadId: THREAD_ID, runId: RUN_ID },
      pendingInterrupts: [{ id: "approval", reason: "tool_call" }],
    };
    const cases = [
      {
        initialTurn: { type: "active" },
        resumeSnapshot: undefined,
        expectedReloads: 1,
      },
      {
        initialTurn: { type: "active" },
        resumeSnapshot: parkedSnapshot,
        expectedReloads: 1,
      },
      {
        initialTurn: { type: "settled" },
        resumeSnapshot: undefined,
        expectedReloads: 0,
      },
      {
        initialTurn: { type: "parked", runId: RUN_ID },
        resumeSnapshot: undefined,
        expectedReloads: 1,
      },
      {
        initialTurn: { type: "parked", runId: "previous-run" },
        resumeSnapshot: parkedSnapshot,
        expectedReloads: 1,
      },
      {
        initialTurn: { type: "parked", runId: RUN_ID },
        resumeSnapshot: parkedSnapshot,
        expectedReloads: 0,
      },
    ] as const;
    for (const { initialTurn, resumeSnapshot, expectedReloads } of cases) {
      let reloads = 0;
      const transport = createDurableChatTransport({
        initialTurn,
        threadId: THREAD_ID,
        initialMessages: [
          {
            id: "partial",
            role: "assistant",
            parts: [{ type: "text", content: "Drafting" }],
          },
        ],
        sendUrl: "https://chat.test/chat",
        joinUrl: () => "https://chat.test/join",
        fetchClient: Object.assign(async () => response(0, undefined), {
          preconnect: () => undefined,
        }),
        probe: async () => ({
          type: "transcript",
          turnId: "turn-rejoin",
          ...(resumeSnapshot === undefined
            ? {}
            : {
                resumeSnapshot: {
                  resumeState: resumeSnapshot.resumeState,
                  pendingInterrupts: [...resumeSnapshot.pendingInterrupts],
                },
              }),
        }),
        onReconnectChange: () => undefined,
        onTranscript: () => {
          reloads += 1;
        },
        onError: (error) => {
          throw error;
        },
      });
      await transport.persistence.getItem(THREAD_ID);
      await transport.persistence.getItem(THREAD_ID);
      expect(reloads).toBe(expectedReloads);
    }
  });
});
