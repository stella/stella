import {
  type ModelMessage,
  type StreamChunk,
  StreamProcessor,
} from "@tanstack/ai";
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
import * as v from "valibot";

import {
  FAKE_APPROVAL_REASON,
  FAKE_CLAUDE_VERSION,
  FAKE_MCP_CALL,
  FAKE_PERMISSION_SUGGESTION,
  FAKE_RESUMED_SESSION_ID,
  FAKE_UNLISTED_DEFAULT,
  type FakeScenarioName,
} from "../../../scripts/fake-claude-code-cli";
import type { FakeScenario as FakeCodexScenario } from "../../../scripts/fake-codex-app-server";
import {
  FAKE_STELLA_ANSWER,
  FAKE_STELLA_SERVER,
} from "../../../scripts/fake-stella-turn";
import type { HarnessTurn, HarnessTurnInput } from "../adapter";
import { createCodexHarnessAdapter } from "../codex/adapter";
import {
  bundledHarnessCompatibility,
  resolveHarnessCompatibility,
} from "../compatibility";
import { type HarnessEvent, harnessSessionId } from "../events";
import { harnessEventsToChunks } from "../stream-chunks";
import { createClaudeCodeHarnessAdapter } from "./adapter";

const FAKE_CLI = path.join(
  import.meta.dir,
  "../../../scripts/fake-claude-code-cli.ts",
);
const FAKE_CODEX = path.join(
  import.meta.dir,
  "../../../scripts/fake-codex-app-server.ts",
);
const MCP_TOKEN = "run-token-123";
const INSTRUCTIONS = "Use the stella MCP server.";

/** Variables a stray shell or parent session could hand the CLI. */
const STRAY_ENVIRONMENT = {
  ANTHROPIC_API_KEY: "sk-ant-stray",
  ANTHROPIC_AUTH_TOKEN: "stray-token",
  ANTHROPIC_BASE_URL: "https://proxy.example.test",
  CLAUDE_CODE_USE_BEDROCK: "1",
  CLAUDE_CODE_OAUTH_TOKEN: "stray-oauth",
  CLAUDE_CONFIG_DIR: "/opt/stray/claude-config",
  CLAUDECODE: "1",
  AWS_BEARER_TOKEN_BEDROCK: "stray-bedrock",
  FAKE_KEEP: "1",
};

const cleanups: (() => void)[] = [];
const backgroundErrors: unknown[] = [];
afterEach(() => {
  expect(backgroundErrors.splice(0)).toEqual([]);
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

const LogEntrySchema = v.looseObject({
  received: v.optional(
    v.looseObject({
      type: v.string(),
      request_id: v.optional(v.string()),
      request: v.optional(v.looseObject({ subtype: v.string() })),
      response: v.optional(v.unknown()),
      message: v.optional(v.unknown()),
    }),
  ),
  startup: v.optional(
    v.object({
      args: v.array(v.string()),
      cwd: v.string(),
      env: v.record(v.string(), v.string()),
    }),
  ),
});

const harnessFor = (scenario: FakeScenarioName) => {
  const root = mkdtempSync(path.join(tmpdir(), "stella-claude-adapter-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const claudeConfigDir = path.join(root, "claude-config");
  const workspaceDir = path.join(root, "workspace");
  const logPath = path.join(root, "fake.log");
  mkdirSync(claudeConfigDir);
  mkdirSync(workspaceDir);
  const adapter = createClaudeCodeHarnessAdapter({
    launch: { executable: process.execPath, args: [FAKE_CLI, scenario] },
    claudeConfigDir,
    environment: {
      ...STRAY_ENVIRONMENT,
      FAKE_CLAUDE_LOG: logPath,
      PATH: process.env["PATH"] ?? "",
    },
    gracePeriodMs: 1000,
    onBackgroundError: (error) => {
      backgroundErrors.push(error);
    },
  });
  const entries = () =>
    readFileSync(logPath, "utf-8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => v.parse(LogEntrySchema, JSON.parse(line)));
  /** Messages the fake CLI received, in order. */
  const received = () =>
    entries().flatMap(({ received: message }) =>
      message === undefined ? [] : [message],
    );
  /** Each CLI process's startup, in order. */
  const startups = () =>
    entries().flatMap(({ startup }) =>
      startup === undefined ? [] : [startup],
    );
  const controlRequests = (subtype: string) =>
    received().filter(
      (message) =>
        message.type === "control_request" &&
        message.request?.subtype === subtype,
    );
  /** The client's answers to the fake CLI's control requests. */
  const answers = () =>
    received().flatMap((message) =>
      message.type === "control_response" ? [message.response] : [],
    );
  return {
    adapter,
    claudeConfigDir,
    workspaceDir,
    received,
    startups,
    controlRequests,
    answers,
  };
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
  model: "sonnet",
  instructions: INSTRUCTIONS,
  policy: { network: "open", fs: "workspace" },
  mcp: {
    serverName: FAKE_STELLA_SERVER,
    url: "https://mcp.example.test/mcp",
    token: MCP_TOKEN,
  },
  transcript,
  continuation: { type: "fresh" },
  ...overrides,
});

const run = async (
  scenario: FakeScenarioName,
  options: {
    overrides?: Partial<HarnessTurnInput>;
    onEvent?: (event: HarnessEvent, turn: HarnessTurn) => Promise<void> | void;
  } = {},
) => {
  const harness = harnessFor(scenario);
  const started = await harness.adapter.startTurn(
    turnInput(harness.workspaceDir, options.overrides),
  );
  if (Result.isError(started)) {
    throw started.error;
  }
  const turn = started.value;
  const events: HarnessEvent[] = [];
  for await (const event of turn.events) {
    events.push(event);
    await options.onEvent?.(event, turn);
  }
  await turn.dispose();
  return { ...harness, events };
};

const terminal = (events: readonly HarnessEvent[]) => events.at(-1);

const toolCompletions = (events: readonly HarnessEvent[]) =>
  events.flatMap((event) => (event.type === "tool.completed" ? [event] : []));

/** The user message the turn sent, as text. */
const promptOf = (received: readonly { type: string; message?: unknown }[]) =>
  JSON.stringify(received.find(({ type }) => type === "user")?.message);

/** Fold chunks the way persistence does and return what would be stored. */
const storedMessages = async (
  events: readonly HarnessEvent[],
  harness: "codex" | "claude-code",
) => {
  let next = 0;
  async function* from() {
    yield* events;
  }
  const processor = new StreamProcessor({ initialMessages: [] });
  const chunks: StreamChunk[] = [];
  for await (const chunk of harnessEventsToChunks(from(), {
    harness,
    model: "test-model",
    runId: "run-1",
    threadId: "stella-thread-1",
    generateId: () => `id-${String((next += 1))}`,
    now: () => 0,
  })) {
    chunks.push(chunk);
  }
  for (const chunk of chunks) {
    processor.processChunk(chunk);
  }
  return processor.getMessages().map(({ role, parts }) => ({ role, parts }));
};

/** The Codex adapter on the same stella tool calls, through its own fake. */
const codexEvents = async (scenario: FakeCodexScenario) => {
  const root = mkdtempSync(path.join(tmpdir(), "stella-claude-codex-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const codexHome = path.join(root, "codex-home");
  mkdirSync(codexHome);
  const adapter = createCodexHarnessAdapter({
    launch: { executable: process.execPath, args: [FAKE_CODEX, scenario] },
    codexHome,
    environment: {
      FAKE_CODEX_LOG: path.join(root, "fake.log"),
      PATH: process.env["PATH"] ?? "",
    },
    clientVersion: "0.0.1",
    gracePeriodMs: 1000,
    onBackgroundError: (error) => {
      backgroundErrors.push(error);
    },
  });
  const started = await adapter.startTurn(
    turnInput(root, { model: "gpt-test" }),
  );
  if (Result.isError(started)) {
    throw started.error;
  }
  const events: HarnessEvent[] = [];
  for await (const event of started.value.events) {
    events.push(event);
  }
  await started.value.dispose();
  return events;
};

describe("Claude Code adapter over stream-json stdio", () => {
  test("runs in the workspace with the stella config dir, without billing overrides, and sends secrets only over stdio", async () => {
    const { events, startups, received, claudeConfigDir, workspaceDir } =
      await run("tool_calls");
    const [startup] = startups();
    expect(startup?.cwd).toBe(realpathSync(workspaceDir));
    expect(startup?.env).toEqual({
      CLAUDE_CONFIG_DIR: claudeConfigDir,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
      FAKE_KEEP: "1",
    });
    const args = startup?.args ?? [];
    const sessionId = args[args.indexOf("--session-id") + 1];
    expect(args).toEqual([
      "--output-format",
      "stream-json",
      "--verbose",
      "--input-format",
      "stream-json",
      "--permission-prompt-tool",
      "stdio",
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--include-partial-messages",
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      "mcp__stella",
      "--session-id",
      sessionId ?? "",
      "--model",
      "sonnet",
    ]);
    expect(args.join(" ")).not.toContain(MCP_TOKEN);
    expect(args.join(" ")).not.toContain(INSTRUCTIONS);
    const [initialize, register] = received();
    expect(initialize).toMatchObject({
      type: "control_request",
      request: { subtype: "initialize", appendSystemPrompt: INSTRUCTIONS },
    });
    expect(register).toMatchObject({
      type: "control_request",
      request: {
        subtype: "mcp_set_servers",
        servers: {
          stella: {
            type: "http",
            url: "https://mcp.example.test/mcp",
            headers: { Authorization: `Bearer ${MCP_TOKEN}` },
          },
        },
      },
    });
    const prompt = promptOf(received());
    expect(prompt).toContain("Find the leases.");
    expect(prompt).toContain("Search both.");
    expect(events[0]).toEqual({
      type: "session.started",
      sessionId: harnessSessionId(sessionId ?? ""),
      continuation: { type: "fresh" },
    });
    expect(terminal(events)).toEqual({
      type: "turn.completed",
      usage: {
        inputTokens: 130,
        cachedInputTokens: 20,
        outputTokens: 30,
        reasoningOutputTokens: 0,
      },
    });
  });

  test("streams text, reasoning and tool calls as harness events", async () => {
    const { events } = await run("tool_calls");
    expect(events.slice(1, -1)).toEqual([
      {
        type: "reasoning.completed",
        messageId: "msg-1:thinking-1",
        text: "Searching the matter.",
      },
      {
        type: "tool.started",
        toolCall: {
          id: FAKE_MCP_CALL.id,
          name: FAKE_MCP_CALL.name,
          input: FAKE_MCP_CALL.input,
        },
      },
      {
        type: "tool.completed",
        toolCall: {
          id: FAKE_MCP_CALL.id,
          name: FAKE_MCP_CALL.name,
          input: FAKE_MCP_CALL.input,
        },
        result: { content: "2 results", status: "succeeded" },
      },
      {
        type: "tool.started",
        toolCall: {
          id: "call-cmd",
          name: "command_execution",
          input: { command: "ls" },
        },
      },
      {
        type: "tool.completed",
        toolCall: {
          id: "call-cmd",
          name: "command_execution",
          input: { command: "ls" },
        },
        result: {
          content: JSON.stringify({
            aggregated_output: "notes.md\n",
            status: "completed",
          }),
          status: "succeeded",
        },
      },
      { type: "text.delta", messageId: "msg-3:0", delta: "Found" },
      { type: "text.delta", messageId: "msg-3:0", delta: " two" },
      {
        type: "text.completed",
        messageId: "msg-3:0",
        text: "Found two leases.",
      },
    ]);
  });

  test("a Claude turn persists the same parts as a Codex turn making the same stella calls", async () => {
    const claude = await run("stella_tools");
    const codex = await codexEvents("stella_tools");
    const local = await storedMessages(claude.events, "claude-code");
    expect(
      local
        .flatMap(({ parts }) => parts)
        .flatMap((part) => (part.type === "text" ? [part.content] : [])),
    ).toEqual([FAKE_STELLA_ANSWER]);
    expect(local).toEqual(await storedMessages(codex, "codex"));
  });

  test("built-in tools become generic activity; unknown kinds are reported, never dropped or forwarded", async () => {
    const { events } = await run("harness_items");
    expect(
      toolCompletions(events).map(({ toolCall, result }) => ({
        name: toolCall.name,
        input: toolCall.input,
        status: result.status,
      })),
    ).toEqual([
      {
        name: "command_execution",
        input: { command: "rg lease" },
        status: "succeeded",
      },
      {
        name: "file_change",
        input: { changes: [{ path: "/workspace/notes.md", kind: "update" }] },
        status: "succeeded",
      },
      {
        name: "harness_web_search",
        input: { query: "civil code lease" },
        status: "succeeded",
      },
      {
        name: "harness_native_tool",
        input: { tool: "Read" },
        status: "succeeded",
      },
      {
        name: "harness_unsupported_item",
        input: { itemType: "holographic_event" },
        status: "failed",
      },
      {
        name: "harness_unsupported_item",
        input: { itemType: "system:quantum_banner" },
        status: "failed",
      },
      {
        name: "harness_unsupported_item",
        input: { itemType: "server_tool_use" },
        status: "failed",
      },
      // `read_document` is a different tool in chat, so it keeps its server.
      {
        name: `mcp__${FAKE_STELLA_SERVER}__read_document`,
        input: { id: "doc-1" },
        status: "succeeded",
      },
      {
        name: "search_case_law",
        input: { query: "" },
        status: "failed",
      },
    ]);
    const stored = JSON.stringify(await storedMessages(events, "claude-code"));
    for (const native of ["never forwarded", "+x", "subagent text"]) {
      expect(stored).not.toContain(native);
    }
    expect(terminal(events)).toEqual({ type: "turn.completed", usage: null });
  });

  test("approvals offer the native decisions and reply with the chosen one", async () => {
    const { events, answers } = await run("approvals", {
      onEvent: async (event, turn) => {
        if (event.type !== "approval.requested") {
          return;
        }
        expect(event.request.options.map(({ decision }) => decision)).toEqual([
          "approve",
          "approve_for_session",
          "deny",
        ]);
        const { requestId } = event.request;
        if (event.request.toolCall.id === "call-rm") {
          expect(event.request).toMatchObject({
            kind: "command",
            reason: "Deletes a file",
            toolCall: {
              name: "command_execution",
              input: { command: "rm draft.md" },
            },
          });
          expect(event.request.reason).not.toBe(FAKE_APPROVAL_REASON);
          const denied = await turn.respond({
            type: "approval",
            requestId,
            decision: "deny",
          });
          expect(Result.isOk(denied)).toBe(true);
          const again = await turn.respond({
            type: "approval",
            requestId,
            decision: "approve",
          });
          expect(Result.isError(again) && again.error.reason).toBe(
            "already_resolved",
          );
          return;
        }
        expect(event.request.kind).toBe("file_change");
        expect(
          Result.isOk(
            await turn.respond({
              type: "approval",
              requestId,
              decision: "approve_for_session",
            }),
          ),
        ).toBe(true);
      },
    });
    expect(answers()).toEqual([
      {
        subtype: "success",
        request_id: "cli-1",
        response: { behavior: "deny", message: "The user denied this action." },
      },
      {
        subtype: "success",
        request_id: "cli-2",
        response: {
          behavior: "allow",
          updatedInput: { file_path: "/elsewhere/out.md", content: "x" },
          // Remembered for the session only, never in a settings file.
          updatedPermissions: [
            { ...FAKE_PERMISSION_SUGGESTION, destination: "session" },
          ],
        },
      },
    ]);
    expect(
      events.filter(({ type }) => type === "interaction.resolved"),
    ).toHaveLength(2);
    expect(
      toolCompletions(events).map(({ toolCall, result }) => [
        toolCall.id,
        result.status,
      ]),
    ).toEqual([
      ["call-rm", "failed"],
      ["call-out", "succeeded"],
    ]);
    expect(terminal(events)?.type).toBe("turn.completed");
  });

  test("an approval without suggested rules offers no session-wide decision", async () => {
    const { events, answers } = await run("one_off_approval", {
      onEvent: async (event, turn) => {
        if (event.type !== "approval.requested") {
          return;
        }
        expect(event.request).toMatchObject({
          kind: "mcp_tool",
          reason: null,
          toolCall: { id: "call-docs", name: FAKE_MCP_CALL.name },
        });
        expect(event.request.options.map(({ decision }) => decision)).toEqual([
          "approve",
          "deny",
        ]);
        const { requestId } = event.request;
        const session = await turn.respond({
          type: "approval",
          requestId,
          decision: "approve_for_session",
        });
        expect(Result.isError(session) && session.error.reason).toBe(
          "invalid_response",
        );
        await turn.respond({
          type: "approval",
          requestId,
          decision: "approve",
        });
      },
    });
    expect(answers()).toEqual([
      {
        subtype: "success",
        request_id: "cli-1",
        response: { behavior: "allow", updatedInput: FAKE_MCP_CALL.input },
      },
    ]);
    expect(toolCompletions(events).map(({ toolCall }) => toolCall.id)).toEqual([
      "call-docs",
    ]);
  });

  test("a question is answered by allowing the call with the answers keyed by question", async () => {
    const { events, answers } = await run("question", {
      onEvent: async (event, turn) => {
        if (event.type !== "question.requested") {
          return;
        }
        expect(event.request).toMatchObject({
          answerWith: "response",
          toolCall: { id: "ask-1", name: "request_user_input" },
        });
        expect(
          event.request.questions[0]?.options.map(({ label }) => label),
        ).toEqual(["Czech", "Slovak"]);
        const { requestId } = event.request;
        const wrongKind = await turn.respond({
          type: "approval",
          requestId,
          decision: "approve",
        });
        expect(Result.isError(wrongKind) && wrongKind.error.reason).toBe(
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
        expect(
          Result.isOk(
            await turn.respond({
              type: "answers",
              requestId,
              answers: { "0": ["Czech"] },
            }),
          ),
        ).toBe(true);
      },
    });
    expect(answers()).toEqual([
      {
        subtype: "success",
        request_id: "cli-1",
        response: {
          behavior: "allow",
          updatedInput: {
            questions: [
              {
                question: "Which law governs the lease?",
                header: "Governing law",
                options: [
                  { label: "Czech", description: "Czech Civil Code" },
                  { label: "Slovak", description: "Slovak Civil Code" },
                ],
                multiSelect: false,
              },
            ],
            answers: { "Which law governs the lease?": "Czech" },
          },
        },
      },
    ]);
    expect(toolCompletions(events).map(({ toolCall }) => toolCall)).toEqual([
      expect.objectContaining({ id: "ask-1", name: "request_user_input" }),
    ]);
    expect(terminal(events)?.type).toBe("turn.completed");
  });

  test("a prompt the harness withdraws resolves and takes no answer", async () => {
    const pending: { requestId: string | null } = { requestId: null };
    const { events } = await run("withdrawn_prompt", {
      onEvent: async (event, turn) => {
        if (event.type === "approval.requested") {
          pending.requestId = event.request.requestId;
        }
        if (event.type === "interaction.resolved") {
          expect(event.requestId).toBe(pending.requestId ?? "");
          const late = await turn.respond({
            type: "approval",
            requestId: event.requestId,
            decision: "approve",
          });
          expect(Result.isError(late) && late.error.reason).toBe(
            "already_resolved",
          );
        }
      },
    });
    expect(events.map(({ type }) => type)).toContain("interaction.resolved");
    expect(terminal(events)?.type).toBe("turn.completed");
  });

  test("an interrupt goes over the control channel and ends the turn as interrupted", async () => {
    const { events, controlRequests } = await run("interrupt", {
      onEvent: async (event, turn) => {
        if (event.type === "tool.started") {
          await turn.interrupt();
        }
      },
    });
    expect(controlRequests("interrupt")).toHaveLength(1);
    expect(terminal(events)).toEqual({ type: "turn.interrupted" });
  });

  test("resuming a missing session falls back to the transcript and says so", async () => {
    const { events, startups, received } = await run("resume_missing", {
      overrides: {
        continuation: {
          type: "resume",
          sessionId: harnessSessionId(FAKE_RESUMED_SESSION_ID),
        },
      },
    });
    const [refused, fresh] = startups();
    expect(refused?.args).toContain("--resume");
    const args = fresh?.args ?? [];
    expect(args).not.toContain("--resume");
    const sessionId = args[args.indexOf("--session-id") + 1] ?? "";
    expect(events[0]).toEqual({
      type: "session.started",
      sessionId: harnessSessionId(sessionId),
      continuation: {
        type: "resume_unavailable",
        reason: "session_not_found",
        message: `No conversation found with session ID: ${FAKE_RESUMED_SESSION_ID}`,
      },
    });
    const prompt = promptOf(received());
    expect(prompt).toContain("Find the leases.");
    expect(prompt).toContain("Search both.");
    expect(terminal(events)?.type).toBe("turn.completed");
  });

  test("a resumed session gets only the new message", async () => {
    const { events, startups, received } = await run("resume_ok", {
      overrides: {
        continuation: {
          type: "resume",
          sessionId: harnessSessionId(FAKE_RESUMED_SESSION_ID),
        },
      },
    });
    const args = startups()[0]?.args ?? [];
    expect(args[args.indexOf("--resume") + 1]).toBe(FAKE_RESUMED_SESSION_ID);
    expect(args).not.toContain("--session-id");
    expect(events[0]).toEqual({
      type: "session.started",
      sessionId: harnessSessionId(FAKE_RESUMED_SESSION_ID),
      continuation: { type: "resumed" },
    });
    expect(received().find(({ type }) => type === "user")?.message).toEqual({
      role: "user",
      content: [{ type: "text", text: "Search both." }],
    });
  });

  test("a signed-out harness, or one that would bill an API key, refuses the turn before any server or prompt", async () => {
    for (const scenario of ["signed_out", "api_key"] as const) {
      const harness = harnessFor(scenario);
      const started = await harness.adapter.startTurn(
        turnInput(harness.workspaceDir),
      );
      expect(Result.isError(started) && started.error.reason).toBe(
        "auth_required",
      );
      expect(harness.controlRequests("mcp_set_servers")).toEqual([]);
      expect(harness.received().map(({ type }) => type)).not.toContain("user");
    }
  });

  test("an unreachable stella MCP server refuses the turn", async () => {
    const harness = harnessFor("mcp_unreachable");
    const started = await harness.adapter.startTurn(
      turnInput(harness.workspaceDir),
    );
    expect(Result.isError(started) && started.error.reason).toBe(
      "start_rejected",
    );
    expect(harness.received().map(({ type }) => type)).not.toContain("user");
  });

  test("auth and usage-limit failures map to their typed states", async () => {
    const auth = await run("auth_expired");
    expect(terminal(auth.events)).toEqual({
      type: "turn.failed",
      failure: {
        type: "auth_required",
        message: "Not logged in · Please run /login",
      },
    });
    // The CLI's own error text is not the agent's answer.
    expect(auth.events.map(({ type }) => type)).not.toContain("text.completed");
    const limited = await run("usage_limit");
    expect(limited.events).toContainEqual({
      type: "retrying",
      message: "Retrying after overloaded (attempt 1 of 10).",
    });
    // A model-specific window that resets later does not hold the harness.
    expect(terminal(limited.events)).toEqual({
      type: "turn.failed",
      failure: {
        type: "usage_limit",
        message: "You've hit your limit · resets 2pm",
        resetsAt: "2026-10-28T14:00:00Z",
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

  test("control requests stella never enables are answered at once", async () => {
    const { events, answers } = await run("unanswerable_requests");
    expect(answers()).toEqual([
      {
        subtype: "error",
        request_id: "cli-1",
        error: "Stella does not answer future_request.",
      },
      {
        subtype: "error",
        request_id: "cli-2",
        error: "Stella does not answer hook_callback.",
      },
      {
        subtype: "error",
        request_id: "cli-3",
        error: "Stella does not answer mcp_message.",
      },
      {
        subtype: "success",
        request_id: "cli-4",
        response: { action: "decline" },
      },
    ]);
    expect(terminal(events)?.type).toBe("turn.completed");
  });

  test("a probe reports version, subscription, models and an exhausted plan limit without a prompt", async () => {
    const harness = harnessFor("probe");
    const probed = await harness.adapter.probe();
    if (Result.isError(probed)) {
      throw probed.error;
    }
    expect(probed.value).toEqual({
      version: FAKE_CLAUDE_VERSION,
      auth: { type: "signed_in", method: "claude.ai", plan: "max" },
      // The CLI's default row is not a model; it marks Sonnet as the default.
      models: [
        {
          id: "opus",
          displayName: "Opus",
          isDefault: false,
          reasoningEfforts: ["low", "medium", "high"],
          inputModalities: ["text"],
        },
        {
          id: "sonnet",
          displayName: "Sonnet",
          isDefault: true,
          reasoningEfforts: [],
          inputModalities: ["text"],
        },
      ],
      capabilities: ["approvals", "interrupt", "resume"],
      // The exhausted model-specific window does not count.
      usageLimit: { resetsAt: "2026-10-28T14:00:00Z" },
    });
    expect(harness.startups()[0]?.cwd).toBe(
      realpathSync(harness.claudeConfigDir),
    );
    expect(harness.startups()[0]?.args).toContain("--no-session-persistence");
    expect(harness.controlRequests("get_usage")[0]?.request).toEqual({
      subtype: "get_usage",
      skip_behaviors: true,
    });
    const types = harness.received().map(({ type }) => type);
    expect(types).not.toContain("user");
    expect(harness.controlRequests("mcp_set_servers")).toEqual([]);
  });

  test("a probe with plan headroom reports no limit; a signed-out one reads no usage", async () => {
    const available = harnessFor("probe_available");
    const ready = await available.adapter.probe();
    expect(Result.isOk(ready) && ready.value.usageLimit).toBeNull();
    for (const scenario of ["probe_signed_out", "api_key"] as const) {
      const harness = harnessFor(scenario);
      const probed = await harness.adapter.probe();
      expect(Result.isOk(probed) && probed.value).toMatchObject({
        auth: { type: "signed_out" },
        models: [],
        usageLimit: null,
      });
      expect(harness.controlRequests("get_usage")).toEqual([]);
    }
  });

  test("a default the CLI does not list is reported once, under its own id", async () => {
    const harness = harnessFor("probe_default_unlisted");
    const probed = await harness.adapter.probe();
    expect(
      Result.isOk(probed) &&
        probed.value.models.map(({ id, isDefault }) => ({ id, isDefault })),
    ).toEqual([
      { id: "sonnet", isDefault: false },
      { id: FAKE_UNLISTED_DEFAULT, isDefault: true },
    ]);
  });

  test("a probe of a missing executable reports the harness unavailable", async () => {
    const claudeConfigDir = mkdtempSync(
      path.join(tmpdir(), "stella-claude-none-"),
    );
    cleanups.push(() =>
      rmSync(claudeConfigDir, { recursive: true, force: true }),
    );
    const harness = createClaudeCodeHarnessAdapter({
      launch: { executable: "/nonexistent/claude", args: [] },
      claudeConfigDir,
      environment: {},
      gracePeriodMs: 100,
      onBackgroundError: (error) => {
        backgroundErrors.push(error);
      },
    });
    const probed = await harness.probe();
    expect(Result.isError(probed) && probed.error.reason).toBe(
      "harness_unavailable",
    );
  });

  test("the bundled policy launches the pinned release and refuses older ones", () => {
    const status = (harnessVersion: string) =>
      resolveHarnessCompatibility({
        manifest: bundledHarnessCompatibility(),
        harness: "claude-code",
        harnessVersion,
        desktopVersion: "1.0.0",
      }).status;
    expect(status(FAKE_CLAUDE_VERSION)).toBe("supported");
    expect(status("2.0.1")).toBe("unsupported");
  });

  test("refuses a CLAUDE_CONFIG_DIR that is the user's own", () => {
    expect(() =>
      createClaudeCodeHarnessAdapter({
        launch: { executable: process.execPath, args: [] },
        claudeConfigDir: path.join(process.env["HOME"] ?? "/", ".claude"),
        environment: {},
        gracePeriodMs: 10,
        onBackgroundError: () => undefined,
      }),
    ).toThrow("CLAUDE_CONFIG_DIR must be stella's");
  });
});
