import { appendFileSync } from "node:fs";
import * as v from "valibot";

/**
 * A stand-in for `codex app-server` that replays a handwritten transcript
 * over real stdio, so the adapter's process, framing and protocol handling
 * run unmodified in tests without a model provider. Every message it
 * receives is appended to `$FAKE_CODEX_LOG` for the test to inspect.
 *
 * Usage: `bun scripts/fake-codex-app-server.ts <scenario>`.
 */

export type FakeStep =
  /** Wait for the client's next request with this method and answer it. */
  | {
      expect: string;
      result?: unknown;
      error?: { code: number; message: string };
    }
  | { notify: string; params: unknown }
  /** Send a server request and wait for the client's response. */
  | { request: string; params: unknown }
  | { raw: string }
  | { sleep: number }
  | { exit: number };

const USER_AGENT = "stella/0.165.0 (Mac OS 27.0; arm64) test";
export const FAKE_THREAD_ID = "thread-a";
export const FAKE_RESUMED_THREAD_ID = "thread-old";
export const FAKE_TURN_ID = "turn-1";

const signedIn = {
  account: { type: "chatgpt", email: null, planType: "plus" },
  requiresOpenaiAuth: false,
};

const handshake = (account: unknown = signedIn): FakeStep[] => [
  {
    expect: "initialize",
    result: {
      userAgent: USER_AGENT,
      codexHome: "/fake-home",
      platformFamily: "unix",
      platformOs: "macos",
    },
  },
  { expect: "account/read", result: account },
];

const turn = (
  status: string,
  error: unknown = null,
  startedAt: number | null = 1,
) => ({
  id: FAKE_TURN_ID,
  items: [],
  status,
  error,
  startedAt,
});

const startTurn = (startedAt: number | null = 1): FakeStep[] => [
  {
    expect: "turn/start",
    result: { turn: turn("inProgress", null, startedAt) },
  },
];

const freshTurn = (startedAt: number | null = 1): FakeStep[] => [
  ...handshake(),
  { expect: "thread/start", result: { thread: { id: FAKE_THREAD_ID } } },
  ...startTurn(startedAt),
];

const item = (phase: "started" | "completed", body: object): FakeStep => ({
  notify: `item/${phase}`,
  params: { threadId: FAKE_THREAD_ID, turnId: FAKE_TURN_ID, item: body },
});

const completed = (status = "completed", error: unknown = null): FakeStep => ({
  notify: "turn/completed",
  params: { threadId: FAKE_THREAD_ID, turn: turn(status, error) },
});

const command = (id: string, status: string, extra: object = {}) => ({
  type: "commandExecution",
  id,
  command: "ls",
  cwd: "/workspace",
  status,
  aggregatedOutput: null,
  exitCode: null,
  ...extra,
});

export const FAKE_MCP_CALL = {
  type: "mcpToolCall",
  id: "call-mcp",
  server: "stella",
  tool: "search",
  arguments: { query: "lease" },
};

const agentMessage = (id: string, text: string, extra: object = {}) => ({
  type: "agentMessage",
  id,
  text,
  phase: null,
  memoryCitation: null,
  delivery: null,
  questions: null,
  ...extra,
});

export const FAKE_SCENARIOS = {
  /** Reasoning, an MCP tool call, a command and a streamed answer. */
  tool_calls: [
    ...freshTurn(),
    {
      notify: "turn/started",
      params: { threadId: FAKE_THREAD_ID, turn: turn("inProgress") },
    },
    item("completed", {
      type: "reasoning",
      id: "r-1",
      summary: ["Searching the matter."],
      content: [],
    }),
    item("started", {
      ...FAKE_MCP_CALL,
      status: "inProgress",
      result: null,
      error: null,
    }),
    item("completed", {
      ...FAKE_MCP_CALL,
      status: "completed",
      result: {
        content: [{ type: "text", text: "2 results" }],
        structuredContent: null,
      },
      error: null,
    }),
    item("started", command("call-cmd", "inProgress")),
    item(
      "completed",
      command("call-cmd", "completed", {
        aggregatedOutput: "notes.md\n",
        exitCode: 0,
      }),
    ),
    {
      notify: "item/agentMessage/delta",
      params: {
        threadId: FAKE_THREAD_ID,
        turnId: FAKE_TURN_ID,
        itemId: "m-1",
        delta: "Found",
      },
    },
    item("completed", agentMessage("m-1", "Found two leases.")),
    {
      notify: "thread/tokenUsage/updated",
      params: {
        threadId: FAKE_THREAD_ID,
        turnId: FAKE_TURN_ID,
        tokenUsage: {
          last: {
            totalTokens: 150,
            inputTokens: 120,
            cachedInputTokens: 20,
            cacheWriteInputTokens: 0,
            outputTokens: 30,
            reasoningOutputTokens: 5,
          },
        },
      },
    },
    completed(),
  ],
  approval: [
    ...freshTurn(),
    item("started", {
      ...command("call-rm", "inProgress"),
      command: "rm draft.md",
    }),
    {
      request: "item/commandExecution/requestApproval",
      params: {
        kind: "command",
        threadId: FAKE_THREAD_ID,
        turnId: FAKE_TURN_ID,
        itemId: "call-rm",
        startedAtMs: 1,
        environmentId: null,
        reason: "Deletes a file",
        command: "rm draft.md",
      },
    },
    item("completed", {
      ...command("call-rm", "declined"),
      command: "rm draft.md",
    }),
    item("completed", agentMessage("m-2", "Left it in place.")),
    completed(),
  ],
  blocking_question: [
    ...freshTurn(),
    {
      request: "item/tool/requestUserInput",
      params: {
        threadId: FAKE_THREAD_ID,
        turnId: FAKE_TURN_ID,
        itemId: "ask-1",
        isBlocking: true,
        autoResolutionMs: null,
        questions: [
          {
            id: "law",
            header: "Governing law",
            question: "Which law governs the lease?",
            isOther: false,
            isSecret: false,
            options: [
              { label: "Czech", description: "Czech Civil Code" },
              { label: "Slovak", description: "Slovak Civil Code" },
            ],
          },
        ],
      },
    },
    item("completed", agentMessage("m-3", "Using Czech law.")),
    completed(),
  ],
  async_question: [
    ...freshTurn(),
    item(
      "completed",
      agentMessage("m-4", "Which party do you represent?", {
        delivery: "async",
        questions: [
          {
            title: "Which party do you represent?",
            options: ["Landlord", "Tenant"],
          },
        ],
      }),
    ),
    completed(),
  ],
  /** A queued turn: `turn/start` has no start time until `turn/started`. */
  interrupt_queued: [
    ...freshTurn(null),
    { sleep: 150 },
    {
      notify: "turn/started",
      params: { threadId: FAKE_THREAD_ID, turn: turn("inProgress") },
    },
    item("started", command("call-long", "inProgress")),
    { expect: "turn/interrupt", result: {} },
    completed("interrupted"),
  ],
  resume_missing: [
    ...handshake(),
    {
      expect: "thread/resume",
      error: {
        code: -32_600,
        message: `no rollout found for thread id ${FAKE_RESUMED_THREAD_ID}`,
      },
    },
    { expect: "thread/start", result: { thread: { id: FAKE_THREAD_ID } } },
    ...startTurn(),
    completed(),
  ],
  resume_ok: [
    ...handshake(),
    {
      expect: "thread/resume",
      result: { thread: { id: FAKE_RESUMED_THREAD_ID } },
    },
    ...startTurn(),
    {
      notify: "turn/completed",
      params: { threadId: FAKE_RESUMED_THREAD_ID, turn: turn("completed") },
    },
  ],
  resume_archived: [
    ...handshake(),
    {
      expect: "thread/resume",
      error: {
        code: -32_600,
        message: `session ${FAKE_RESUMED_THREAD_ID} is archived`,
      },
    },
    { expect: "thread/unarchive", result: {} },
    {
      expect: "thread/resume",
      result: { thread: { id: FAKE_RESUMED_THREAD_ID } },
    },
    ...startTurn(),
    {
      notify: "turn/completed",
      params: { threadId: FAKE_RESUMED_THREAD_ID, turn: turn("completed") },
    },
  ],
  signed_out: handshake({ account: null, requiresOpenaiAuth: true }),
  auth_expired: [
    ...freshTurn(),
    completed("failed", {
      message: "Your access token could not be refreshed.",
      codexErrorInfo: "unauthorized",
      additionalDetails: null,
    }),
  ],
  usage_limit: [
    ...freshTurn(),
    {
      notify: "account/rateLimits/updated",
      params: {
        rateLimits: {
          limitId: "codex",
          limitName: null,
          primary: {
            usedPercent: 100,
            windowDurationMins: 300,
            resetsAt: 1_793_196_000,
          },
          secondary: {
            usedPercent: 40,
            windowDurationMins: 10_080,
            resetsAt: 1_793_700_000,
          },
          credits: null,
          individualLimit: null,
          planType: "plus",
          rateLimitReachedType: null,
        },
      },
    },
    {
      notify: "error",
      params: {
        threadId: FAKE_THREAD_ID,
        turnId: FAKE_TURN_ID,
        willRetry: true,
        error: {
          message: "Reconnecting",
          codexErrorInfo: null,
          additionalDetails: null,
        },
      },
    },
    completed("failed", {
      message: "You've hit your usage limit.",
      codexErrorInfo: "usageLimitExceeded",
      additionalDetails: null,
    }),
  ],
  malformed: [...freshTurn(), { raw: "{this is not json" }, { sleep: 5000 }],
  crash: [
    ...freshTurn(),
    item("started", command("call-x", "inProgress")),
    { exit: 3 },
  ],
  /** Requests stella never enables are answered at once, not left pending. */
  unanswerable_requests: [
    ...freshTurn(),
    { request: "future/method", params: {} },
    {
      request: "item/tool/call",
      params: {
        threadId: FAKE_THREAD_ID,
        turnId: FAKE_TURN_ID,
        callId: "dyn-1",
        namespace: null,
        tool: "x",
        arguments: {},
      },
    },
    {
      request: "mcpServer/elicitation/request",
      params: {
        threadId: FAKE_THREAD_ID,
        turnId: FAKE_TURN_ID,
        serverName: "stella",
        mode: "url",
        _meta: null,
        message: "Open this",
        url: "https://example.test",
        elicitationId: "e-1",
      },
    },
    completed(),
  ],
  probe: [
    ...handshake(),
    {
      expect: "model/list",
      result: {
        data: [
          {
            id: "gpt-test",
            model: "gpt-test",
            displayName: "GPT Test",
            description: "",
            hidden: false,
            isDefault: true,
            supportedReasoningEfforts: [
              { reasoningEffort: "medium", description: "" },
            ],
            defaultReasoningEffort: "medium",
            inputModalities: ["text", "image"],
          },
        ],
        nextCursor: "page-2",
      },
    },
    {
      expect: "model/list",
      result: {
        data: [
          {
            id: "gpt-hidden",
            model: "gpt-hidden",
            displayName: "Hidden",
            description: "",
            hidden: true,
            isDefault: false,
            supportedReasoningEfforts: [],
            defaultReasoningEffort: "low",
            inputModalities: ["text"],
          },
        ],
        nextCursor: null,
      },
    },
  ],
} as const satisfies Record<string, readonly FakeStep[]>;

export type FakeScenario = keyof typeof FAKE_SCENARIOS;

const isScenario = (name: string): name is FakeScenario =>
  Object.hasOwn(FAKE_SCENARIOS, name);

const IncomingSchema = v.looseObject({
  id: v.optional(v.union([v.string(), v.number()])),
  method: v.optional(v.string()),
});
type Incoming = v.InferOutput<typeof IncomingSchema>;

const run = async (
  steps: readonly FakeStep[],
  log: (entry: object) => void,
) => {
  const requests: Incoming[] = [];
  const responses: Incoming[] = [];
  const state: { wake: (() => void) | null; closed: boolean } = {
    wake: null,
    closed: false,
  };
  const write = (message: object) => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };
  const wakeReader = () => {
    const wake = state.wake;
    state.wake = null;
    if (wake !== null) {
      wake();
    }
  };

  const reading = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const bytes of Bun.stdin.stream()) {
      buffer += decoder.decode(bytes, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const raw: unknown = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        log({ received: raw });
        const message = v.parse(IncomingSchema, raw);
        if (message.method !== undefined && message.id !== undefined) {
          requests.push(message);
        } else if (message.method === undefined) {
          responses.push(message);
        }
        wakeReader();
      }
    }
    state.closed = true;
    wakeReader();
  })();

  const take = async (queue: Incoming[]): Promise<Incoming | null> => {
    for (;;) {
      const message = queue.shift();
      if (message !== undefined) {
        return message;
      }
      if (state.closed) {
        return null;
      }
      const { promise, resolve } = Promise.withResolvers<undefined>();
      state.wake = () => resolve(undefined);
      await promise;
    }
  };

  let serverRequestId = 1000;
  for (const step of steps) {
    if ("expect" in step) {
      const message = await take(requests);
      if (message === null) {
        return;
      }
      if (message.method !== step.expect) {
        log({ unexpected: message.method, wanted: step.expect });
        process.exit(97);
      }
      write(
        step.error === undefined
          ? { id: message.id, result: step.result ?? {} }
          : { id: message.id, error: step.error },
      );
    } else if ("notify" in step) {
      write({ method: step.notify, params: step.params });
    } else if ("request" in step) {
      serverRequestId += 1;
      write({ id: serverRequestId, method: step.request, params: step.params });
      if ((await take(responses)) === null) {
        return;
      }
    } else if ("raw" in step) {
      process.stdout.write(`${step.raw}\n`);
    } else if ("sleep" in step) {
      await Bun.sleep(step.sleep);
    } else {
      process.exit(step.exit);
    }
  }
  // A real server exits once its client closes stdin.
  await reading;
};

if (import.meta.main) {
  const scenario = process.argv[2] ?? "";
  const logPath = process.env["FAKE_CODEX_LOG"] ?? "";
  const log = (entry: object) => {
    appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
  };
  log({
    startup: { codexHome: process.env["CODEX_HOME"], cwd: process.cwd() },
  });
  if (!isScenario(scenario)) {
    log({ unknownScenario: scenario });
    process.exit(98);
  }
  await run(FAKE_SCENARIOS[scenario], log);
  process.exit(0);
}
