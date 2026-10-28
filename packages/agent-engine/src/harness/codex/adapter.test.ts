import {
  type ModelMessage,
  normalizeStreamChunk,
  type StreamChunk,
  StreamProcessor,
} from "@tanstack/ai";
import {
  type CodexThreadEvent,
  translateThreadEvents,
} from "@tanstack/ai-codex";
import { Result } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  FAKE_MCP_CALL,
  FAKE_RESUMED_THREAD_ID,
  FAKE_THREAD_ID,
  type FakeScenario,
} from "../../../scripts/fake-codex-app-server";
import type { HarnessTurn, HarnessTurnInput } from "../adapter";
import { type HarnessEvent, harnessSessionId } from "../events";
import { harnessEventsToChunks } from "../stream-chunks";
import { createCodexHarnessAdapter } from "./adapter";

const FAKE_SERVER = path.join(
  import.meta.dir,
  "../../../scripts/fake-codex-app-server.ts",
);
const MCP_TOKEN = "run-token-123";

const cleanups: (() => void)[] = [];
const backgroundErrors: unknown[] = [];
afterEach(() => {
  expect(backgroundErrors.splice(0)).toEqual([]);
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

const harnessFor = (scenario: FakeScenario) => {
  const root = mkdtempSync(path.join(tmpdir(), "stella-codex-adapter-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const codexHome = path.join(root, "codex-home");
  const workspaceDir = path.join(root, "workspace");
  const logPath = path.join(root, "fake.log");
  mkdirSync(codexHome);
  mkdirSync(workspaceDir);
  const adapter = createCodexHarnessAdapter({
    launch: { executable: process.execPath, args: [FAKE_SERVER, scenario] },
    codexHome,
    environment: { FAKE_CODEX_LOG: logPath, PATH: process.env["PATH"] ?? "" },
    clientVersion: "0.0.1",
    gracePeriodMs: 1000,
    onBackgroundError: (error) => {
      backgroundErrors.push(error);
    },
  });
  /** Messages the fake server received, in order. */
  const received = (): {
    method?: string;
    id?: unknown;
    params?: unknown;
    result?: unknown;
    error?: unknown;
  }[] =>
    readFileSync(logPath, "utf-8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.received !== undefined)
      .map((entry) => entry.received);
  const startup = () =>
    JSON.parse(readFileSync(logPath, "utf-8").split("\n")[0] ?? "{}").startup;
  return { adapter, codexHome, workspaceDir, received, startup };
};

const transcript: ModelMessage[] = [
  { role: "user", content: "Find the leases." },
  { role: "assistant", content: "There are two folders." },
  { role: "user", content: "Search both." },
];

const turnInput = (
  workspaceDir: string,
  overrides: Partial<HarnessTurnInput> = {},
): HarnessTurnInput => ({
  runId: "run-1",
  threadId: "stella-thread-1",
  workspaceDir,
  model: "gpt-test",
  instructions: "Use the stella MCP server.",
  policy: { network: "open", fs: "workspace" },
  mcp: {
    serverName: "stella",
    url: "https://mcp.example.test/mcp",
    token: MCP_TOKEN,
  },
  transcript,
  continuation: { type: "fresh" },
  ...overrides,
});

const start = async (
  scenario: FakeScenario,
  overrides: Partial<HarnessTurnInput> = {},
) => {
  const harness = harnessFor(scenario);
  const started = await harness.adapter.startTurn(
    turnInput(harness.workspaceDir, overrides),
  );
  if (Result.isError(started)) {
    throw started.error;
  }
  return { ...harness, turn: started.value };
};

type Collected = { events: HarnessEvent[]; done: Promise<void> };

/** Read events as they arrive; `onEvent` may answer or interrupt mid-stream. */
const collect = (
  turn: HarnessTurn,
  onEvent: (event: HarnessEvent) => Promise<void> | void = () => undefined,
): Collected => {
  const events: HarnessEvent[] = [];
  const done = (async () => {
    for await (const event of turn.events) {
      events.push(event);
      await onEvent(event);
    }
  })();
  return { events, done };
};

const run = async (
  scenario: FakeScenario,
  options: {
    overrides?: Partial<HarnessTurnInput>;
    onEvent?: (event: HarnessEvent, turn: HarnessTurn) => Promise<void> | void;
  } = {},
) => {
  const started = await start(scenario, options.overrides);
  const collected = collect(started.turn, (event) =>
    options.onEvent?.(event, started.turn),
  );
  await collected.done;
  await started.turn.dispose();
  return { ...started, events: collected.events };
};

const terminal = (events: readonly HarnessEvent[]) => events.at(-1);

describe("Codex adapter over a stdio app-server", () => {
  test("runs with the stella-owned CODEX_HOME in the workspace and sends the MCP bearer only over stdio", async () => {
    const { events, received, startup, codexHome, workspaceDir } =
      await run("tool_calls");
    expect(startup()).toEqual({ codexHome, cwd: realpathSync(workspaceDir) });
    const threadStart = received().find(
      ({ method }) => method === "thread/start",
    );
    expect(threadStart?.params).toMatchObject({
      model: "gpt-test",
      cwd: workspaceDir,
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      config: {
        "sandbox_workspace_write.network_access": true,
        "mcp_servers.stella": {
          url: "https://mcp.example.test/mcp",
          http_headers: { Authorization: `Bearer ${MCP_TOKEN}` },
        },
      },
    });
    expect(terminal(events)).toEqual({
      type: "turn.completed",
      usage: {
        inputTokens: 120,
        cachedInputTokens: 20,
        outputTokens: 30,
        reasoningOutputTokens: 5,
      },
    });
  });

  test("a local turn persists the same message as the cloud translator for the same native turn", async () => {
    const { events } = await run("tool_calls");
    const fold = (chunks: readonly StreamChunk[]) => {
      const processor = new StreamProcessor({ initialMessages: [] });
      for (const chunk of chunks) {
        processor.processChunk(chunk);
      }
      return processor
        .getMessages()
        .map(({ role, parts }) => ({ role, parts }));
    };
    const counter = () => {
      let next = 0;
      return () => `id-${(next += 1)}`;
    };
    async function* from<T>(items: readonly T[]) {
      yield* items;
    }
    const local: StreamChunk[] = [];
    for await (const chunk of harnessEventsToChunks(from(events), {
      harness: "codex",
      model: "gpt-test",
      runId: "run-1",
      threadId: "stella-thread-1",
      generateId: counter(),
      now: () => 0,
    })) {
      local.push(chunk);
    }
    // The same turn as `codex exec --experimental-json` reports it.
    const exec: CodexThreadEvent[] = [
      { type: "thread.started", thread_id: FAKE_THREAD_ID },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: { id: "r-1", type: "reasoning", text: "Searching the matter." },
      },
      {
        type: "item.started",
        item: {
          id: FAKE_MCP_CALL.id,
          type: "mcp_tool_call",
          server: "stella",
          tool: "search",
          arguments: FAKE_MCP_CALL.arguments,
          status: "in_progress",
        },
      },
      {
        type: "item.completed",
        item: {
          id: FAKE_MCP_CALL.id,
          type: "mcp_tool_call",
          server: "stella",
          tool: "search",
          arguments: FAKE_MCP_CALL.arguments,
          result: { content: [{ type: "text", text: "2 results" }] },
          status: "completed",
        },
      },
      {
        type: "item.started",
        item: {
          id: "call-cmd",
          type: "command_execution",
          command: "ls",
          status: "in_progress",
        },
      },
      {
        type: "item.completed",
        item: {
          id: "call-cmd",
          type: "command_execution",
          command: "ls",
          aggregated_output: "notes.md\n",
          exit_code: 0,
          status: "completed",
        },
      },
      {
        type: "item.updated",
        item: { id: "m-1", type: "agent_message", text: "Found" },
      },
      {
        type: "item.completed",
        item: { id: "m-1", type: "agent_message", text: "Found two leases." },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 120,
          cached_input_tokens: 20,
          output_tokens: 30,
          reasoning_output_tokens: 5,
        },
      },
    ];
    const cloud: StreamChunk[] = [];
    for await (const chunk of translateThreadEvents(from(exec), {
      model: "gpt-test",
      runId: "run-1",
      threadId: "stella-thread-1",
      genId: counter(),
    })) {
      cloud.push(...normalizeStreamChunk(chunk));
    }
    const stored = fold(cloud);
    expect(stored.flatMap(({ parts }) => parts).length).toBeGreaterThan(4);
    expect(fold(local)).toEqual(stored);
  });

  test("an approval offers the native decisions and replies with the chosen one verbatim", async () => {
    const { events, received } = await run("approval", {
      onEvent: async (event, turn) => {
        if (event.type !== "approval.requested") {
          return;
        }
        expect(event.request.toolCall).toEqual({
          id: "call-rm",
          name: "command_execution",
          input: { command: "rm draft.md" },
        });
        expect(event.request.options.map(({ decision }) => decision)).toEqual([
          "approve",
          "approve_for_session",
          "deny",
        ]);
        const replied = await turn.respond({
          type: "approval",
          requestId: event.request.requestId,
          decision: "deny",
        });
        expect(Result.isOk(replied)).toBe(true);
        const again = await turn.respond({
          type: "approval",
          requestId: event.request.requestId,
          decision: "approve",
        });
        expect(Result.isError(again) && again.error.reason).toBe(
          "already_resolved",
        );
      },
    });
    const reply = received().find(
      (message) => message.method === undefined && message.id === 1001,
    );
    expect(reply).toEqual({ id: 1001, result: { decision: "decline" } });
    const types = events.map(({ type }) => type);
    expect(types).toContain("interaction.resolved");
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool.completed",
        result: expect.objectContaining({ status: "failed" }),
      }),
    );
    expect(terminal(events)?.type).toBe("turn.completed");
  });

  test("a blocking question takes option labels and rejects answers it did not offer", async () => {
    const { events, received } = await run("blocking_question", {
      onEvent: async (event, turn) => {
        if (event.type !== "question.requested") {
          return;
        }
        expect(event.request.answerWith).toBe("response");
        const { requestId } = event.request;
        const wrong = await turn.respond({
          type: "answers",
          requestId,
          answers: { law: ["German"] },
        });
        expect(Result.isError(wrong) && wrong.error.reason).toBe(
          "invalid_response",
        );
        const missing = await turn.respond({
          type: "answers",
          requestId,
          answers: {},
        });
        expect(Result.isError(missing) && missing.error.reason).toBe(
          "invalid_response",
        );
        const wrongKind = await turn.respond({
          type: "approval",
          requestId,
          decision: "approve",
        });
        expect(Result.isError(wrongKind) && wrongKind.error.reason).toBe(
          "invalid_response",
        );
        expect(
          Result.isOk(
            await turn.respond({
              type: "answers",
              requestId,
              answers: { law: ["Czech"] },
            }),
          ),
        ).toBe(true);
      },
    });
    expect(received()).toContainEqual({
      id: 1001,
      result: { answers: { law: { answers: ["Czech"] } } },
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool.completed",
        toolCall: expect.objectContaining({
          id: "ask-1",
          name: "request_user_input",
        }),
      }),
    );
    expect(terminal(events)?.type).toBe("turn.completed");
  });

  test("an async question completes the turn and is answered by the next message, not a response", async () => {
    const { events } = await run("async_question", {
      onEvent: async (event, turn) => {
        if (event.type !== "question.requested") {
          return;
        }
        expect(event.request.answerWith).toBe("next_message");
        expect(
          event.request.questions[0]?.options.map(({ label }) => label),
        ).toEqual(["Landlord", "Tenant"]);
        const replied = await turn.respond({
          type: "answers",
          requestId: event.request.requestId,
          answers: { "0": ["Tenant"] },
        });
        expect(Result.isError(replied) && replied.error.reason).toBe(
          "answer_with_message",
        );
      },
    });
    expect(events.some(({ type }) => type === "question.requested")).toBe(true);
    expect(terminal(events)?.type).toBe("turn.completed");
  });

  test("interrupting a queued turn waits for it to start, then stops it", async () => {
    const { events, received } = await run("interrupt_queued", {
      onEvent: async (event, turn) => {
        if (event.type === "session.started") {
          await turn.interrupt();
        }
      },
    });
    const methods = received().map(({ method }) => method);
    expect(methods).toContain("turn/interrupt");
    expect(
      received().find(({ method }) => method === "turn/interrupt")?.params,
    ).toEqual({
      threadId: FAKE_THREAD_ID,
      turnId: "turn-1",
    });
    expect(terminal(events)).toEqual({ type: "turn.interrupted" });
  });

  test("resuming a missing session falls back to the transcript and says so", async () => {
    const { events, received } = await run("resume_missing", {
      overrides: {
        continuation: {
          type: "resume",
          sessionId: harnessSessionId(FAKE_RESUMED_THREAD_ID),
        },
      },
    });
    expect(events[0]).toEqual({
      type: "session.started",
      sessionId: harnessSessionId(FAKE_THREAD_ID),
      continuation: {
        type: "resume_unavailable",
        reason: "session_not_found",
        message: `no rollout found for thread id ${FAKE_RESUMED_THREAD_ID}`,
      },
    });
    const prompt = JSON.stringify(
      received().find(({ method }) => method === "turn/start")?.params,
    );
    expect(prompt).toContain("Find the leases.");
    expect(prompt).toContain("Search both.");
  });

  test("a resumed session gets only the new message", async () => {
    const { events, received } = await run("resume_ok", {
      overrides: {
        continuation: {
          type: "resume",
          sessionId: harnessSessionId(FAKE_RESUMED_THREAD_ID),
        },
      },
    });
    expect(events[0]).toMatchObject({ continuation: { type: "resumed" } });
    expect(
      received().find(({ method }) => method === "thread/resume")?.params,
    ).toMatchObject({
      threadId: FAKE_RESUMED_THREAD_ID,
      excludeTurns: true,
    });
    expect(
      received().find(({ method }) => method === "turn/start")?.params,
    ).toMatchObject({
      threadId: FAKE_RESUMED_THREAD_ID,
      input: [{ type: "text", text: "Search both." }],
    });
    expect(terminal(events)?.type).toBe("turn.completed");
  });

  test("an archived session is unarchived and then resumed", async () => {
    const { events, received } = await run("resume_archived", {
      overrides: {
        continuation: {
          type: "resume",
          sessionId: harnessSessionId(FAKE_RESUMED_THREAD_ID),
        },
      },
    });
    expect(
      received()
        .map(({ method }) => method)
        .filter((m) => m?.startsWith("thread/")),
    ).toEqual(["thread/resume", "thread/unarchive", "thread/resume"]);
    expect(events[0]).toMatchObject({ continuation: { type: "resumed" } });
  });

  test("a signed-out harness refuses the turn before any session starts", async () => {
    const harness = harnessFor("signed_out");
    const started = await harness.adapter.startTurn(
      turnInput(harness.workspaceDir),
    );
    expect(Result.isError(started) && started.error.reason).toBe(
      "auth_required",
    );
    expect(harness.received().map(({ method }) => method)).not.toContain(
      "thread/start",
    );
  });

  test("auth and usage-limit failures map to their typed states", async () => {
    const auth = await run("auth_expired");
    expect(terminal(auth.events)).toEqual({
      type: "turn.failed",
      failure: {
        type: "auth_required",
        message: "Your access token could not be refreshed.",
      },
    });
    const limited = await run("usage_limit");
    expect(limited.events).toContainEqual({
      type: "retrying",
      message: "Reconnecting",
    });
    expect(terminal(limited.events)).toEqual({
      type: "turn.failed",
      failure: {
        type: "usage_limit",
        message: "You've hit your usage limit.",
        resetsAt: "2026-10-28T14:00:00.000Z",
      },
    });
  });

  test("a malformed line fails the turn as a protocol violation", async () => {
    const { events } = await run("malformed");
    expect(terminal(events)).toMatchObject({
      type: "turn.failed",
      failure: { type: "protocol_violation" },
    });
  });

  test("a crashed harness fails the turn with its exit code", async () => {
    const { events } = await run("crash");
    expect(terminal(events)).toMatchObject({
      type: "turn.failed",
      failure: { type: "harness_exited", exitCode: 3 },
    });
  });

  test("requests stella never enables are answered at once", async () => {
    const { events, received } = await run("unanswerable_requests");
    const replies = received().filter(({ method }) => method === undefined);
    expect(replies).toEqual([
      {
        id: 1001,
        error: {
          code: -32_601,
          message: "Stella does not answer future/method.",
        },
      },
      { id: 1002, result: { contentItems: [], success: false } },
      { id: 1003, result: { action: "decline", content: null, _meta: null } },
    ]);
    expect(terminal(events)?.type).toBe("turn.completed");
  });

  test("a probe reports version, account, visible models and capabilities without a session", async () => {
    const harness = harnessFor("probe");
    const probed = await harness.adapter.probe();
    if (Result.isError(probed)) {
      throw probed.error;
    }
    expect(probed.value).toEqual({
      version: "0.165.0",
      auth: { type: "signed_in", method: "chatgpt", plan: "plus" },
      models: [
        {
          id: "gpt-test",
          displayName: "GPT Test",
          isDefault: true,
          reasoningEfforts: ["medium"],
          inputModalities: ["text", "image"],
        },
      ],
      capabilities: ["approvals", "interrupt", "resume"],
    });
    const methods = harness.received().map(({ method }) => method);
    expect(methods).not.toContain("thread/start");
    expect(methods).not.toContain("turn/start");
    expect(
      harness
        .received()
        .filter(({ method }) => method === "model/list")
        .at(1)?.params,
    ).toEqual({
      cursor: "page-2",
    });
  });

  test("refuses a CODEX_HOME that is the user's own", () => {
    expect(() =>
      createCodexHarnessAdapter({
        launch: { executable: process.execPath, args: [] },
        codexHome: path.join(process.env["HOME"] ?? "/", ".codex"),
        environment: {},
        clientVersion: "0.0.1",
        gracePeriodMs: 10,
        onBackgroundError: () => undefined,
      }),
    ).toThrow("CODEX_HOME must be stella's");
  });
});
