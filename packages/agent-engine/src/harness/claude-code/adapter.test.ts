import {
  type ModelMessage,
  type StreamChunk,
  StreamProcessor,
} from "@tanstack/ai";
import { Result } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import {
  FAKE_APPROVAL_REASON,
  FAKE_CLAUDE_CONTEXT_WINDOW,
  FAKE_CLAUDE_VERSION,
  FAKE_ESCAPE_COMMAND,
  FAKE_LONG_COMMAND,
  FAKE_LONG_PLAN,
  FAKE_MCP_CALL,
  FAKE_PERMISSION_SUGGESTION,
  FAKE_PLAN,
  FAKE_PRIVATE_TEXT,
  FAKE_RESUMED_SESSION_ID,
  FAKE_SANDBOX_HOST,
  FAKE_SANDBOX_REFUSAL,
  FAKE_SUBAGENT_CALL,
  FAKE_UNLISTED_DEFAULT,
  type FakeScenarioName,
} from "../../../scripts/fake-claude-code-cli";
import type { FakeScenario as FakeCodexScenario } from "../../../scripts/fake-codex-app-server";
import {
  FAKE_STELLA_ANSWER,
  FAKE_STELLA_SERVER,
} from "../../../scripts/fake-stella-turn";
import { PROTOCOL_LOG_OFF } from "../../protocol-log";
import type { HarnessTurn, HarnessTurnInput } from "../adapter";
import { createCodexHarnessAdapter } from "../codex/adapter";
import {
  bundledHarnessCompatibility,
  resolveHarnessCompatibility,
} from "../compatibility";
import { type HarnessEvent, harnessSessionId } from "../events";
import { packageCacheEnvironment } from "../package-cache";
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
/** The computer's package cache; the turn never creates it. */
const CACHE_DIR = path.join(tmpdir(), "stella-agent-package-cache");
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
      path: v.optional(v.string()),
      env: v.record(v.string(), v.string()),
    }),
  ),
});

const harnessFor = (
  scenario: FakeScenarioName,
  {
    platform = "darwin",
    requestTimeoutMs = 10_000,
    environment = {},
  }: {
    platform?: NodeJS.Platform;
    requestTimeoutMs?: number;
    environment?: Readonly<Record<string, string>>;
  } = {},
) => {
  const root = mkdtempSync(path.join(tmpdir(), "stella-claude-adapter-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const claudeConfigDir = path.join(root, "claude-config");
  const workspaceDir = path.join(root, "workspace");
  const logPath = path.join(root, "fake.log");
  mkdirSync(claudeConfigDir);
  mkdirSync(workspaceDir);
  const adapter = createClaudeCodeHarnessAdapter({
    launch: { executable: process.execPath, args: [FAKE_CLI, scenario] },
    protocolLog: PROTOCOL_LOG_OFF,
    claudeConfigDir,
    environment: {
      ...STRAY_ENVIRONMENT,
      ...environment,
      FAKE_HARNESS_LOG: logPath,
      PATH: process.env["PATH"] ?? "",
    },
    gracePeriodMs: 1000,
    requestTimeoutMs,
    onBackgroundError: (error) => {
      backgroundErrors.push(error);
    },
    platform,
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
    logPath,
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

/** An image and a PDF, as the sidecar reads them from the run's folder. */
const INPUT_FILES: HarnessTurnInput["inputFiles"] = [
  { type: "image", mediaType: "image/png", base64: "iVBORw0K" },
  { type: "pdf", base64: "JVBERi0x" },
];

const turnInput = (
  workspaceDir: string,
  overrides: Partial<HarnessTurnInput> = {},
): HarnessTurnInput => ({
  runId: "run-1",
  threadId: "stella-thread-1",
  workspaceDir,
  model: "sonnet",
  reasoningEffort: null,
  instructions: INSTRUCTIONS,
  policy: { network: "open", fs: "workspace", approvals: "ask" },
  mcp: {
    serverName: FAKE_STELLA_SERVER,
    url: "https://mcp.example.test/mcp",
    token: MCP_TOKEN,
  },
  transcript,
  inputFiles: [],
  continuation: { type: "fresh" },
  cacheDir: CACHE_DIR,
  skillFolders: [],
  networkHosts: [],
  toolPath: [],
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
    workspaceDir: "/workspace",
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
    protocolLog: PROTOCOL_LOG_OFF,
    codexHome,
    environment: {
      FAKE_HARNESS_LOG: path.join(root, "fake.log"),
      PATH: process.env["PATH"] ?? "",
    },
    clientVersion: "0.0.1",
    gracePeriodMs: 1000,
    requestTimeoutMs: 10_000,
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
  test("asks the model for the run's reasoning effort, after the model it applies to", async () => {
    const { startups } = await run("tool_calls", {
      overrides: { reasoningEffort: "max" },
    });
    const args = startups()[0]?.args ?? [];
    expect(args.slice(-4)).toEqual(["--model", "sonnet", "--effort", "max"]);
  });

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
      ...packageCacheEnvironment(CACHE_DIR),
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
    // The context is the main thread's last request, against the window of
    // the model that made it.
    expect(terminal(events)).toEqual({
      type: "turn.completed",
      usage: {
        inputTokens: 130,
        cachedInputTokens: 20,
        outputTokens: 30,
        reasoningOutputTokens: 0,
        context: {
          usedTokens: 4 + 600 + 10_000 + 40,
          windowTokens: FAKE_CLAUDE_CONTEXT_WINDOW,
        },
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
        // The command's output stays on the computer: kept for the member to
        // open there, never in what the turn reports.
        result: {
          content: JSON.stringify({ status: "completed" }),
          status: "succeeded",
          localOutput: { type: "command", output: "notes.md\n" },
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
        input: {
          tool: "Read",
          detail: { kind: "read", path: "/workspace/notes.md" },
        },
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

  test("a built-in tool's call shows its command, file names, search or plan, and never the text it carries", async () => {
    const { events } = await run("native_tools");
    const stored = await storedMessages(events, "claude-code");
    const calls = stored
      .flatMap(({ parts }) => parts)
      .flatMap((part) =>
        part.type === "tool-call"
          ? [{ name: part.name, input: part.input }]
          : [],
      );
    expect(calls).toEqual([
      // A heredoc shows the line that runs it, never the lines it writes.
      {
        name: "command_execution",
        input: { command: "cat > notes.md <<'EOF'…" },
      },
      {
        name: "command_execution",
        input: { command: `${FAKE_LONG_COMMAND.slice(0, 299)}…` },
      },
      // Inside the run's folder a file is named relative to it.
      {
        name: "file_change",
        input: { changes: [{ path: "drafts/lease.md", kind: "update" }] },
      },
      {
        name: "file_change",
        input: { changes: [{ path: "drafts/lease.md", kind: "update" }] },
      },
      {
        name: "file_change",
        input: { changes: [{ path: "/elsewhere/out.md", kind: "update" }] },
      },
      {
        name: "file_change",
        input: { changes: [{ path: "analysis.ipynb", kind: "update" }] },
      },
      {
        name: "harness_native_tool",
        input: {
          tool: "Read",
          detail: { kind: "read", path: "drafts/lease.md" },
        },
      },
      {
        name: "harness_native_tool",
        input: {
          tool: "Grep",
          detail: { kind: "search", pattern: "termination", path: "drafts" },
        },
      },
      {
        name: "harness_native_tool",
        input: { tool: "Glob", detail: { kind: "search", pattern: "**/*.md" } },
      },
      { name: "harness_web_search", input: { query: "civil code lease" } },
      {
        name: "harness_native_tool",
        input: {
          tool: "WebFetch",
          detail: { kind: "fetch", url: "https://example.test/civil-code" },
        },
      },
      {
        name: "harness_native_tool",
        input: {
          tool: "TodoWrite",
          detail: {
            kind: "plan",
            items: ["Read the lease", "Draft the notice"],
          },
        },
      },
      // Any other tool shows its name only.
      { name: "harness_native_tool", input: { tool: "Skill" } },
    ]);
    // Nothing a call carried beyond those fields is stored, in its input or
    // its raw arguments.
    const callText = JSON.stringify(
      stored
        .flatMap(({ parts }) => parts)
        .filter((part) => part.type === "tool-call"),
    );
    for (const text of Object.values(FAKE_PRIVATE_TEXT)) {
      expect(callText).not.toContain(text);
    }
    expect(callText).not.toContain("y".repeat(300));
    // A result says how the step ended, never what the tool returned.
    const storedText = JSON.stringify(stored);
    for (const returned of [
      "1→lease",
      "lease.md: termination",
      "A page.",
      "Applied 1 edit.",
      "Web search results",
    ]) {
      expect(storedText).not.toContain(returned);
    }
    expect(terminal(events)).toMatchObject({ type: "turn.completed" });
  });

  test("a subagent is a step, the steps it takes are its steps, and what it was told, wrote and reported stays on the computer", async () => {
    const approvals: HarnessEvent[] = [];
    const { events } = await run("subagent", {
      onEvent: async (event, turn) => {
        if (event.type !== "approval.requested") {
          return;
        }
        approvals.push(event);
        const approved = await turn.respond({
          type: "approval",
          requestId: event.request.requestId,
          decision: "approve",
        });
        expect(Result.isOk(approved)).toBe(true);
      },
    });
    const inSubagent = { parentCallId: FAKE_SUBAGENT_CALL };
    expect(
      toolCompletions(events).map(({ toolCall, result }) => ({
        id: toolCall.id,
        name: toolCall.name,
        input: toolCall.input,
        status: result.status,
      })),
    ).toEqual([
      {
        id: "call-sub-read",
        name: "harness_native_tool",
        input: {
          tool: "Read",
          detail: { kind: "read", path: "/workspace/drafts/lease.md" },
          ...inSubagent,
        },
        status: "succeeded",
      },
      {
        id: "call-sub-rm",
        name: "command_execution",
        input: { command: "rm draft.md", ...inSubagent },
        status: "succeeded",
      },
      {
        id: "call-sub-image",
        name: "harness_native_tool",
        input: {
          tool: "Read",
          detail: { kind: "image", path: "/workspace/scans/Lease Page 1.PNG" },
          ...inSubagent,
        },
        status: "succeeded",
      },
      // A connector call's input is its tool's own, so it names no subagent
      // and stays on the turn.
      {
        id: "call-sub-docs",
        name: FAKE_MCP_CALL.name,
        input: FAKE_MCP_CALL.input,
        status: "succeeded",
      },
      {
        id: FAKE_SUBAGENT_CALL,
        name: "harness_native_tool",
        input: {
          tool: "Agent",
          detail: {
            kind: "subagent",
            description: "Check the lease",
            agentType: "Explore",
          },
        },
        status: "succeeded",
      },
    ]);
    // The subagent's step opens before any step it takes.
    expect(
      events.flatMap((event) =>
        event.type === "tool.started" ? [event.toolCall.id] : [],
      ),
    ).toEqual([
      FAKE_SUBAGENT_CALL,
      "call-sub-read",
      "call-sub-rm",
      "call-sub-image",
      "call-sub-docs",
    ]);
    // An approval a subagent's step asks for reaches the member on that step.
    expect(approvals).toMatchObject([
      {
        request: {
          kind: "command",
          toolCall: {
            id: "call-sub-rm",
            input: { command: "rm draft.md", ...inSubagent },
          },
        },
      },
    ]);
    // Only the main thread's answer is the turn's text, and its context is
    // the main thread's own.
    expect(
      events.flatMap((event) =>
        event.type === "text.completed" ||
        event.type === "text.delta" ||
        event.type === "reasoning.completed"
          ? [event]
          : [],
      ),
    ).toMatchObject([
      { type: "text.completed", text: "The lease caps arrears." },
    ]);
    expect(terminal(events)).toMatchObject({
      type: "turn.completed",
      usage: { context: { usedTokens: 4 + 600 + 1000 + 5 } },
    });
    const stored = await storedMessages(events, "claude-code");
    const storedText = JSON.stringify(stored);
    for (const text of [
      FAKE_PRIVATE_TEXT.subagentPrompt,
      FAKE_PRIVATE_TEXT.subagentText,
      FAKE_PRIVATE_TEXT.subagentThinking,
      FAKE_PRIVATE_TEXT.subagentReport,
      FAKE_PRIVATE_TEXT.imageData,
    ]) {
      expect(storedText).not.toContain(text);
    }
    // Stored, a step names its file relative to the run's folder and keeps
    // the subagent it ran in.
    expect(
      stored
        .flatMap(({ parts }) => parts)
        .flatMap((part) =>
          part.type === "tool-call" && part.id === "call-sub-image"
            ? [part.input]
            : [],
        ),
    ).toEqual([
      {
        tool: "Read",
        detail: { kind: "image", path: "scans/Lease Page 1.PNG" },
        ...inSubagent,
      },
    ]);
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

  test("the turn's images and PDFs open its user message as blocks the CLI accepts", async () => {
    const { events, received } = await run("stella_tools", {
      overrides: { inputFiles: INPUT_FILES },
    });
    // The fake ends with code 96 on content the Messages API would refuse.
    expect(terminal(events)?.type).toBe("turn.completed");
    expect(
      received()
        .filter(({ type }) => type === "user")
        .map(({ message }) => message),
    ).toEqual([
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "iVBORw0K",
            },
          },
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: "JVBERi0x",
            },
          },
          { type: "text", text: expect.stringContaining("Search both.") },
        ],
      },
    ]);
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
    expect(
      received()
        .filter(({ type }) => type === "user")
        .map(({ message }) => message),
    ).toEqual([
      { role: "user", content: [{ type: "text", text: "Search both." }] },
    ]);
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
      capabilities: ["approvals", "interrupt", "resume", "image_input"],
      approvalModes: ["plan", "ask", "auto", "full_auto"],
      // The exhausted model-specific window does not count.
      usageLimit: { resetsAt: "2099-10-28T14:00:00Z" },
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
    for (const scenario of ["probe_available", "probe_reset_passed"] as const) {
      const ready = await harnessFor(scenario).adapter.probe();
      expect(Result.isOk(ready) && ready.value.usageLimit).toBeNull();
    }
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

  test("a CLI that never answers initialize is ended by the request deadline", async () => {
    const harness = harnessFor("unresponsive", { requestTimeoutMs: 300 });
    const probed = await harness.adapter.probe();
    expect(Result.isError(probed) && probed.error).toMatchObject({
      reason: "harness_unavailable",
      message: "The harness did not answer initialize in time.",
    });
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
      protocolLog: PROTOCOL_LOG_OFF,
      claudeConfigDir,
      environment: {},
      gracePeriodMs: 100,
      requestTimeoutMs: 10_000,
      onBackgroundError: (error) => {
        backgroundErrors.push(error);
      },
      platform: "darwin",
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
        protocolLog: PROTOCOL_LOG_OFF,
        claudeConfigDir: path.join(process.env["HOME"] ?? "/", ".claude"),
        environment: {},
        gracePeriodMs: 10,
        requestTimeoutMs: 10_000,
        onBackgroundError: () => undefined,
        platform: "darwin",
      }),
    ).toThrow("CLAUDE_CONFIG_DIR must be stella's");
  });
});

describe("Claude Code approval modes", () => {
  /** The CLI's arguments for one turn in `approvals`. */
  const argsFor = async (
    approvals: HarnessTurnInput["policy"]["approvals"],
  ) => {
    const { startups } = await run("tool_calls", {
      overrides: {
        policy: { network: "open", fs: "workspace", approvals },
      },
    });
    return startups()[0]?.args ?? [];
  };
  const valueOf = (args: readonly string[], flag: string) =>
    args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;

  test("plan starts the CLI in plan mode, without the sandbox, and allows no stella call ahead", async () => {
    const args = await argsFor("plan");
    expect(valueOf(args, "--permission-mode")).toBe("plan");
    expect(args).not.toContain("--settings");
    // A stella write before the plan is approved is asked about.
    expect(args).not.toContain("--allowedTools");
    expect(valueOf(await argsFor("ask"), "--allowedTools")).toMatch(/^mcp__/u);
  });

  test("a plan opens with its approval, which shows the plan and offers approve or deny; approving it switches the CLI to Ask's mode once the plan's call has run", async () => {
    const seen: string[] = [];
    const { events, answers, controlRequests } = await run("plan_approved", {
      overrides: {
        policy: { network: "open", fs: "workspace", approvals: "plan" },
      },
      onEvent: async (event, turn) => {
        seen.push(event.type);
        if (event.type !== "approval.requested") {
          return;
        }
        expect(event.request).toMatchObject({
          kind: "tool",
          toolCall: {
            id: "call-plan",
            name: "harness_native_tool",
            input: {
              tool: "ExitPlanMode",
              detail: { kind: "proposed_plan", text: FAKE_PLAN },
            },
          },
        });
        // The CLI's suggestion to switch modes is never offered.
        expect(event.request.options.map(({ decision }) => decision)).toEqual([
          "approve",
          "deny",
        ]);
        await turn.respond({
          type: "approval",
          requestId: event.request.requestId,
          decision: "approve",
        });
      },
    });
    // No call opens before the approval that carries the plan.
    expect(seen.indexOf("approval.requested")).toBeLessThan(
      seen.indexOf("tool.completed"),
    );
    expect(seen).not.toContain("tool.started");
    expect(answers()).toEqual([
      {
        subtype: "success",
        request_id: "cli-1",
        response: {
          behavior: "allow",
          updatedInput: { plan: FAKE_PLAN, planFilePath: "/plans/lease.md" },
        },
      },
    ]);
    expect(
      controlRequests("set_permission_mode").map(({ request }) => request),
    ).toEqual([{ subtype: "set_permission_mode", mode: "acceptEdits" }]);
    expect(terminal(events)?.type).toBe("turn.completed");
  });

  test("a plan a subagent proposes is asked about on its step, and approving it keeps the turn in plan mode", async () => {
    const asked: HarnessEvent[] = [];
    const { events, controlRequests } = await run("subagent_plan", {
      overrides: {
        policy: { network: "open", fs: "workspace", approvals: "plan" },
      },
      onEvent: async (event, turn) => {
        if (event.type !== "approval.requested") {
          return;
        }
        asked.push(event);
        await turn.respond({
          type: "approval",
          requestId: event.request.requestId,
          decision: "approve",
        });
      },
    });
    expect(asked).toMatchObject([
      {
        request: {
          toolCall: {
            id: "call-sub-plan",
            input: {
              tool: "ExitPlanMode",
              detail: { kind: "proposed_plan", text: FAKE_PLAN },
              parentCallId: FAKE_SUBAGENT_CALL,
            },
          },
        },
      },
    ]);
    // The plan's call ran: the fixture reaches the point a main-thread plan
    // switches the mode at.
    expect(
      toolCompletions(events).map(({ toolCall, result }) => [
        toolCall.id,
        result.status,
      ]),
    ).toEqual([
      ["call-sub-plan", "succeeded"],
      [FAKE_SUBAGENT_CALL, "succeeded"],
    ]);
    expect(controlRequests("set_permission_mode")).toEqual([]);
    expect(terminal(events)?.type).toBe("turn.completed");
  });

  test("a declined plan keeps the CLI in plan mode", async () => {
    const { events, answers, controlRequests } = await run("plan_declined", {
      overrides: {
        policy: { network: "open", fs: "workspace", approvals: "plan" },
      },
      onEvent: async (event, turn) => {
        if (event.type === "approval.requested") {
          await turn.respond({
            type: "approval",
            requestId: event.request.requestId,
            decision: "deny",
          });
        }
      },
    });
    expect(answers()).toEqual([
      {
        subtype: "success",
        request_id: "cli-1",
        response: { behavior: "deny", message: "The user denied this action." },
      },
    ]);
    expect(controlRequests("set_permission_mode")).toEqual([]);
    expect(terminal(events)?.type).toBe("turn.completed");
  });

  test("a plan call without a plan is never put to the member", async () => {
    const { events, answers, controlRequests } = await run("plan_missing", {
      overrides: {
        policy: { network: "open", fs: "workspace", approvals: "plan" },
      },
    });
    expect(events.map(({ type }) => type)).not.toContain("approval.requested");
    expect(answers()).toEqual([
      {
        subtype: "success",
        request_id: "cli-1",
        response: {
          behavior: "deny",
          message: expect.stringContaining("No plan was given"),
        },
      },
    ]);
    expect(controlRequests("set_permission_mode")).toEqual([]);
    expect(terminal(events)?.type).toBe("turn.completed");
  });

  test("a plan too long to show in full is never put to the member: the CLI is told to shorten it", async () => {
    expect(FAKE_LONG_PLAN.length).toBeGreaterThan(20_000);
    const { events, answers, controlRequests } = await run("plan_too_long", {
      overrides: {
        policy: { network: "open", fs: "workspace", approvals: "plan" },
      },
    });
    expect(events.map(({ type }) => type)).not.toContain("approval.requested");
    expect(answers()).toEqual([
      {
        subtype: "success",
        request_id: "cli-1",
        response: {
          behavior: "deny",
          message: expect.stringContaining("too long for the user to review"),
        },
      },
    ]);
    expect(controlRequests("set_permission_mode")).toEqual([]);
    expect(terminal(events)?.type).toBe("turn.completed");
  });

  test("web search asks at Ask and runs unasked above it; fetching a page follows the permission mode", async () => {
    const allowedAt = async (
      approvals: HarnessTurnInput["policy"]["approvals"],
    ) => {
      const args = await argsFor(approvals);
      expect(args).not.toContain("--disallowedTools");
      expect(args).not.toContain("--disallowed-tools");
      return (valueOf(args, "--allowedTools") ?? "").split(",");
    };
    const ask = await allowedAt("ask");
    expect(ask).toEqual(["mcp__stella"]);
    for (const approvals of ["auto", "full_auto"] as const) {
      const allowed = await allowedAt(approvals);
      expect(allowed).toEqual(["mcp__stella", "WebSearch"]);
    }
  });

  test("ask accepts edits in the workspace and asks about the rest, without the sandbox", async () => {
    const args = await argsFor("ask");
    expect(valueOf(args, "--permission-mode")).toBe("acceptEdits");
    expect(args).not.toContain("--settings");
  });

  test("auto lets the CLI approve what it judges safe, without the sandbox", async () => {
    const args = await argsFor("auto");
    expect(valueOf(args, "--permission-mode")).toBe("auto");
    expect(args).not.toContain("--settings");
  });

  test("full auto runs commands in the required OS sandbox and never skips permission checks", async () => {
    const args = await argsFor("full_auto");
    expect(valueOf(args, "--permission-mode")).toBe("acceptEdits");
    expect(args).not.toContain("bypassPermissions");
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(JSON.parse(valueOf(args, "--settings") ?? "null")).toEqual({
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: true,
        filesystem: { allowWrite: [CACHE_DIR] },
      },
    });
  });

  test("full auto lets sandboxed commands reach a host the skills declare and still asks before leaving the sandbox", async () => {
    const { events, answers } = await run("sandbox_network", {
      overrides: {
        policy: { network: "open", fs: "workspace", approvals: "full_auto" },
        networkHosts: [FAKE_SANDBOX_HOST],
      },
      onEvent: async (event, turn) => {
        if (event.type === "approval.requested") {
          await turn.respond({
            type: "approval",
            requestId: event.request.requestId,
            decision: "deny",
          });
        }
      },
    });
    const approvals = events.flatMap((event) =>
      event.type === "approval.requested" ? [event.request] : [],
    );
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      kind: "command",
      toolCall: { input: { command: FAKE_ESCAPE_COMMAND } },
    });
    expect(answers()).toEqual([
      {
        subtype: "success",
        request_id: "cli-1",
        response: {
          behavior: "allow",
          updatedInput: { host: FAKE_SANDBOX_HOST },
        },
      },
      {
        subtype: "success",
        request_id: "cli-2",
        response: expect.objectContaining({ behavior: "deny" }),
      },
    ]);
    expect(terminal(events)?.type).toBe("turn.completed");
  });

  test("full auto asks about a host no skill declares", async () => {
    const { events, answers } = await run("sandbox_network", {
      overrides: {
        policy: { network: "open", fs: "workspace", approvals: "full_auto" },
        networkHosts: ["aviationweather.gov"],
      },
      onEvent: async (event, turn) => {
        if (event.type === "approval.requested") {
          await turn.respond({
            type: "approval",
            requestId: event.request.requestId,
            decision: "deny",
          });
        }
      },
    });
    const approvals = events.flatMap((event) =>
      event.type === "approval.requested" ? [event.request] : [],
    );
    expect(approvals).toHaveLength(2);
    expect(approvals[0]).toMatchObject({
      toolCall: { localInput: { host: FAKE_SANDBOX_HOST } },
    });
    expect(answers()[0]).toMatchObject({
      request_id: "cli-1",
      response: expect.objectContaining({ behavior: "deny" }),
    });
  });

  test("outside full auto a request to reach a host is asked about", async () => {
    const { events } = await run("sandbox_network", {
      onEvent: async (event, turn) => {
        if (event.type === "approval.requested") {
          await turn.respond({
            type: "approval",
            requestId: event.request.requestId,
            decision: "deny",
          });
        }
      },
    });
    expect(
      events.filter((event) => event.type === "approval.requested"),
    ).toHaveLength(2);
  });

  test("full auto fails as sandbox unavailable when the CLI cannot start its sandbox", async () => {
    const harness = harnessFor("sandbox_unavailable");
    const started = await harness.adapter.startTurn(
      turnInput(harness.workspaceDir, {
        policy: { network: "open", fs: "workspace", approvals: "full_auto" },
      }),
    );
    expect(Result.isError(started) && started.error).toMatchObject({
      reason: "sandbox_unavailable",
      message: FAKE_SANDBOX_REFUSAL,
    });
    // A refused sandbox is not a missing session: no unsandboxed retry.
    expect(harness.startups()).toHaveLength(1);
  });

  test("where the CLI has no sandbox, full auto is not offered and never starts the CLI", async () => {
    for (const platform of ["win32", "linux"] as const) {
      const harness = harnessFor("probe", { platform });
      const probed = await harness.adapter.probe();
      expect(Result.isOk(probed) && probed.value.approvalModes).toEqual([
        "plan",
        "ask",
        "auto",
      ]);
      const unsandboxed = harnessFor("tool_calls", { platform });
      const started = await unsandboxed.adapter.startTurn(
        turnInput(unsandboxed.workspaceDir, {
          policy: { network: "open", fs: "workspace", approvals: "full_auto" },
        }),
      );
      expect(Result.isError(started) && started.error.reason).toBe(
        "sandbox_unavailable",
      );
      expect(existsSync(unsandboxed.logPath)).toBe(false);
    }
  });
});

describe("Claude Code managed tools", () => {
  const toolDir = path.join(tmpdir(), "stella-managed-bun", "bin");

  test("a managed tool comes first on the CLI's PATH and the inherited PATH stays", async () => {
    const { startups } = await run("tool_calls", {
      overrides: { toolPath: [toolDir] },
    });
    expect(startups()[0]?.path).toBe(
      `${toolDir}${path.delimiter}${process.env["PATH"] ?? ""}`,
    );
  });

  test("without a managed tool the inherited PATH is untouched", async () => {
    const { startups } = await run("tool_calls");
    expect(startups()[0]?.path).toBe(process.env["PATH"]);
  });
});

describe("Claude Code skill folders", () => {
  const valueOf = (args: readonly string[], flag: string) =>
    args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;

  /** A real skill folder, outside the harness's own directories. */
  const skillFolder = (name: string) => {
    const root = mkdtempSync(path.join(tmpdir(), "stella-skill-folder-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const folder = path.join(root, name);
    mkdirSync(path.join(folder, "scripts"), { recursive: true });
    writeFileSync(
      path.join(folder, "SKILL.md"),
      `---\nname: ${name}\ndescription: An invented skill.\n---\nBody.\n`,
    );
    writeFileSync(path.join(folder, "scripts", "run.ts"), "export {};\n");
    return { name, path: folder };
  };

  const contentsOf = (folder: string) =>
    readdirSync(folder, { recursive: true, encoding: "utf-8" }).toSorted();

  /** The CLI's arguments for a turn, and its plugin as the CLI finds it. */
  const startedWith = async (
    skillFolders: HarnessTurnInput["skillFolders"],
    approvals: HarnessTurnInput["policy"]["approvals"] = "ask",
  ) => {
    const harness = harnessFor("tool_calls");
    const started = await harness.adapter.startTurn(
      turnInput(harness.workspaceDir, {
        skillFolders,
        policy: { network: "open", fs: "workspace", approvals },
      }),
    );
    if (Result.isError(started)) {
      throw started.error;
    }
    const turn = started.value;
    const finished = async () => {
      for await (const _event of turn.events) {
        // Drained: the turn ends after its terminal event.
      }
      await turn.dispose();
    };
    return {
      ...harness,
      args: harness.startups()[0]?.args ?? [],
      finished,
    };
  };

  test("a listed folder loads through a plugin stella owns, with the harness's isolation kept", async () => {
    const skill = skillFolder("fixture-skill");
    const before = contentsOf(skill.path);
    const { args, claudeConfigDir, finished } = await startedWith([skill]);

    const plugin = valueOf(args, "--plugin-dir") ?? "";
    expect(path.dirname(path.dirname(plugin))).toBe(claudeConfigDir);
    const link = path.join(plugin, "skills", skill.name);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(skill.path);
    expect(
      JSON.parse(
        readFileSync(
          path.join(plugin, ".claude-plugin", "plugin.json"),
          "utf-8",
        ),
      ),
    ).toEqual({ name: "local-skills" });

    // The harness's isolation is untouched by a skill, and the folder is not
    // made a working directory, which `acceptEdits` would then write to.
    expect(valueOf(args, "--setting-sources")).toBe("");
    expect(args).toContain("--strict-mcp-config");
    expect(args).not.toContain("--add-dir");

    await finished();
    expect(existsSync(plugin)).toBe(false);
    expect(contentsOf(skill.path)).toEqual(before);
  });

  test("a turn without skill folders has no plugin and no extra settings", async () => {
    const { args, claudeConfigDir, finished } = await startedWith([]);
    expect(args).not.toContain("--plugin-dir");
    expect(args).not.toContain("--settings");
    expect(existsSync(path.join(claudeConfigDir, "stella-skill-plugins"))).toBe(
      false,
    );
    await finished();
  });

  test("a folder that vanished, holds no SKILL.md or is a link is left out and the turn still runs", async () => {
    const good = skillFolder("good-skill");
    const vanished = skillFolder("vanished-skill");
    rmSync(vanished.path, { recursive: true });
    const empty = skillFolder("empty-skill");
    rmSync(path.join(empty.path, "SKILL.md"));
    const target = skillFolder("linked-skill");
    const linkedFolder = {
      name: "linked-folder",
      path: `${target.path}-link`,
    };
    symlinkSync(target.path, linkedFolder.path);
    cleanups.push(() => rmSync(linkedFolder.path, { force: true }));
    const linkedFile = skillFolder("linked-file");
    rmSync(path.join(linkedFile.path, "SKILL.md"));
    symlinkSync(
      path.join(target.path, "SKILL.md"),
      path.join(linkedFile.path, "SKILL.md"),
    );

    const { args, finished } = await startedWith([
      vanished,
      empty,
      linkedFolder,
      linkedFile,
      good,
    ]);
    const plugin = valueOf(args, "--plugin-dir") ?? "";
    expect(readdirSync(path.join(plugin, "skills"))).toEqual([good.name]);
    await finished();
  });

  test("a skill renamed since the desktop listed it, or whose header never closes, is left out", async () => {
    const good = skillFolder("good-skill");
    const renamed = skillFolder("listed-skill");
    writeFileSync(
      path.join(renamed.path, "SKILL.md"),
      "---\nname: another-skill\n---\nBody.\n",
    );
    const unclosed = skillFolder("unclosed-skill");
    writeFileSync(
      path.join(unclosed.path, "SKILL.md"),
      "---\nname: unclosed-skill\nBody.\n",
    );
    const { args, finished } = await startedWith([renamed, unclosed, good]);
    const plugin = valueOf(args, "--plugin-dir") ?? "";
    expect(readdirSync(path.join(plugin, "skills"))).toEqual([good.name]);
    await finished();
  });

  test("when no folder is usable the turn runs without a plugin", async () => {
    const vanished = skillFolder("vanished-skill");
    rmSync(vanished.path, { recursive: true });
    const { args, finished } = await startedWith([vanished]);
    expect(args).not.toContain("--plugin-dir");
    expect(args).not.toContain("--settings");
    await finished();
  });

  test("a name that would leave the plugin's folder, or repeats one, is not linked", async () => {
    const skill = skillFolder("fixture-skill");
    const other = skillFolder("other-skill");
    const { args, finished } = await startedWith([
      { name: "../escape", path: other.path },
      skill,
      { name: skill.name, path: other.path },
    ]);
    const plugin = valueOf(args, "--plugin-dir") ?? "";
    expect(readdirSync(path.join(plugin, "skills"))).toEqual([skill.name]);
    expect(readlinkSync(path.join(plugin, "skills", skill.name))).toBe(
      skill.path,
    );
    await finished();
  });

  test.each(["ask", "auto"] as const)(
    "in %s the folder reads without asking and never takes an edit",
    async (approvals) => {
      const skill = skillFolder("fixture-skill");
      const { args, finished } = await startedWith([skill], approvals);
      const plugin = valueOf(args, "--plugin-dir") ?? "";
      expect(JSON.parse(valueOf(args, "--settings") ?? "null")).toEqual({
        permissions: {
          allow: [`Read(/${plugin}/**)`, `Read(/${skill.path}/**)`],
          deny: [`Edit(/${plugin}/**)`, `Edit(/${skill.path}/**)`],
        },
      });
      await finished();
    },
  );

  test("in full auto the sandbox keeps writes to the cache and refuses the folder", async () => {
    const skill = skillFolder("fixture-skill");
    const { args, finished } = await startedWith([skill], "full_auto");
    const plugin = valueOf(args, "--plugin-dir") ?? "";
    expect(JSON.parse(valueOf(args, "--settings") ?? "null")).toEqual({
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: true,
        filesystem: { allowWrite: [CACHE_DIR], denyWrite: [skill.path] },
      },
      permissions: {
        allow: [`Read(/${plugin}/**)`, `Read(/${skill.path}/**)`],
        deny: [`Edit(/${plugin}/**)`, `Edit(/${skill.path}/**)`],
      },
    });
    await finished();
  });

  test("rules name a path's special characters literally", async () => {
    const skill = skillFolder("fixture-skill");
    const odd = `${skill.path} (copy) [1]`;
    renameSync(skill.path, odd);
    cleanups.push(() => rmSync(odd, { recursive: true, force: true }));
    const { args, finished } = await startedWith([
      { name: skill.name, path: odd },
    ]);
    const rules = JSON.parse(valueOf(args, "--settings") ?? "null").permissions;
    expect(rules.allow[1]).toEndWith(String.raw` \(copy\) \[1\]/**)`);
    await finished();
  });

  test("a document folder's own settings and skills are never asked for", async () => {
    const harness = harnessFor("tool_calls");
    const planted = path.join(
      harness.workspaceDir,
      ".claude",
      "skills",
      "planted",
    );
    mkdirSync(planted, { recursive: true });
    writeFileSync(
      path.join(planted, "SKILL.md"),
      "---\nname: planted\ndescription: x\n---\nx\n",
    );
    writeFileSync(
      path.join(harness.workspaceDir, ".claude", "settings.json"),
      '{"permissions":{"allow":["Bash(*)"]}}',
    );
    const started = await harness.adapter.startTurn(
      turnInput(harness.workspaceDir),
    );
    if (Result.isError(started)) {
      throw started.error;
    }
    const args = harness.startups()[0]?.args ?? [];
    expect(valueOf(args, "--setting-sources")).toBe("");
    expect(args).toContain("--strict-mcp-config");
    expect(args).not.toContain("--plugin-dir");
    expect(JSON.stringify(args)).not.toContain(harness.workspaceDir);
    for await (const _event of started.value.events) {
      // Drained.
    }
    await started.value.dispose();
  });

  test("a read and a command on a skill reach stella by name and status, an unrelated call unchanged", async () => {
    const skill = skillFolder("fixture-skill");
    const harness = harnessFor("reads_skill", {
      environment: { FAKE_SKILL_PATH: skill.path },
    });
    const started = await harness.adapter.startTurn(
      turnInput(harness.workspaceDir, { skillFolders: [skill] }),
    );
    if (Result.isError(started)) {
      throw started.error;
    }
    const events: HarnessEvent[] = [];
    for await (const event of started.value.events) {
      events.push(event);
    }
    await started.value.dispose();

    expect(JSON.stringify(events)).not.toContain(skill.path);
    expect(JSON.stringify(events)).not.toContain("Licensed");
    expect(toolCompletions(events)).toEqual([
      expect.objectContaining({
        toolCall: expect.objectContaining({
          input: {
            tool: "Read",
            detail: { kind: "read", path: `<skill:${skill.name}>/SKILL.md` },
          },
        }),
        result: {
          content: JSON.stringify({ status: "completed" }),
          status: "succeeded",
        },
      }),
      expect.objectContaining({
        toolCall: expect.objectContaining({
          input: { command: `bun <skill:${skill.name}>/scripts/run.ts` },
        }),
        result: {
          content: JSON.stringify({ status: "completed" }),
          status: "succeeded",
        },
      }),
      expect.objectContaining({
        toolCall: expect.objectContaining({ input: { command: "ls" } }),
        // The command's output stays on the computer; a step on the skill
        // keeps none, even there.
        result: {
          content: JSON.stringify({ status: "completed" }),
          status: "succeeded",
          localOutput: { type: "command", output: "notes.md\n" },
        },
      }),
    ]);
  });

  test("a turn whose plugin cannot be written does not start the CLI", async () => {
    const skill = skillFolder("fixture-skill");
    const harness = harnessFor("tool_calls");
    writeFileSync(
      path.join(harness.claudeConfigDir, "stella-skill-plugins"),
      "in the way",
    );
    const started = await harness.adapter.startTurn(
      turnInput(harness.workspaceDir, { skillFolders: [skill] }),
    );
    expect(Result.isError(started) && started.error.reason).toBe(
      "start_rejected",
    );
    expect(existsSync(harness.logPath)).toBe(false);
  });

  test("a plugin a dead holder left behind is removed without touching the folder it links to", async () => {
    const skill = skillFolder("fixture-skill");
    const left = skillFolder("left-skill");
    const before = contentsOf(left.path);
    const harness = harnessFor("tool_calls");
    const stale = path.join(
      harness.claudeConfigDir,
      "stella-skill-plugins",
      "left-behind",
    );
    mkdirSync(path.join(stale, "skills"), { recursive: true });
    symlinkSync(left.path, path.join(stale, "skills", left.name));
    const longAgo = new Date(0);
    utimesSync(stale, longAgo, longAgo);

    const started = await harness.adapter.startTurn(
      turnInput(harness.workspaceDir, { skillFolders: [skill] }),
    );
    if (Result.isError(started)) {
      throw started.error;
    }
    expect(existsSync(stale)).toBe(false);
    expect(contentsOf(left.path)).toEqual(before);
    for await (const _event of started.value.events) {
      // Drained.
    }
    await started.value.dispose();
  });
});

describe("Claude Code background commands after a turn", () => {
  const completedTurn = async (scenario: FakeScenarioName) => {
    const harness = harnessFor(scenario);
    const started = await harness.adapter.startTurn(
      turnInput(harness.workspaceDir),
    );
    if (Result.isError(started)) {
      throw started.error;
    }
    const events: HarnessEvent[] = [];
    for await (const event of started.value.events) {
      events.push(event);
    }
    expect(terminal(events)).toMatchObject({ type: "turn.completed" });
    return { ...harness, turn: started.value };
  };

  test("keep the process, and the next user message continues in it, in its own mode", async () => {
    const { adapter, workspaceDir, startups, received, turn, controlRequests } =
      await completedTurn("background_command");
    const live = await turn.release();
    if (live === null) {
      throw new Error("The turn did not keep its process.");
    }
    expect(live.harness).toBe("claude-code");
    expect(live.backgroundTasks).toBe(1);

    const next = await adapter.startTurn(
      turnInput(workspaceDir, {
        continuation: { type: "live", session: live },
      }),
    );
    if (Result.isError(next)) {
      throw next.error;
    }
    const events: HarnessEvent[] = [];
    for await (const event of next.value.events) {
      events.push(event);
    }
    expect(events[0]).toEqual({
      type: "session.started",
      sessionId: live.sessionId,
      continuation: { type: "resumed" },
    });
    expect(terminal(events)).toMatchObject({ type: "turn.completed" });
    // The server exited during the turn: nothing is kept any more.
    expect(await next.value.release()).toBeNull();
    expect(startups()).toHaveLength(1);
    const users = received().filter(({ type }) => type === "user");
    expect(users).toHaveLength(2);
    expect(JSON.stringify(users[1])).toContain(live.sessionId);
    // A kept process may have left its mode (an approved plan): the next
    // turn sets its own before its message.
    expect(
      controlRequests("set_permission_mode").map(({ request }) => request),
    ).toEqual([{ subtype: "set_permission_mode", mode: "acceptEdits" }]);
  });

  test("a sub-agent is stopped at the turn's end and a turn the CLI opens itself is interrupted", async () => {
    const { turn, controlRequests } = await completedTurn(
      "background_own_turn",
    );
    const live = await turn.release();
    if (live === null) {
      throw new Error("The turn did not keep its process.");
    }
    expect(controlRequests("stop_task").map(({ request }) => request)).toEqual([
      { subtype: "stop_task", task_id: "task-agent" },
    ]);
    expect(live.backgroundTasks).toBe(2);
    const { promise: oneLeft, resolve } = Promise.withResolvers<number>();
    live.watch(resolve);
    // The CLI lists one command fewer only once it was interrupted.
    expect(await oneLeft).toBe(1);
    expect(controlRequests("interrupt")).toHaveLength(1);
    await live.end();
    expect(controlRequests("stop_task").map(({ request }) => request)).toEqual([
      { subtype: "stop_task", task_id: "task-agent" },
      { subtype: "stop_task", task_id: "task-serve" },
    ]);
  });

  test("the next turn waits for a turn the CLI opened itself to end, so its result is not the next turn's", async () => {
    const { adapter, workspaceDir, turn } = await completedTurn(
      "background_own_turn_late",
    );
    const live = await turn.release();
    if (live === null) {
      throw new Error("The turn did not keep its process.");
    }
    const { promise: interrupted, resolve } = Promise.withResolvers<number>();
    live.watch(resolve);
    // The own turn was interrupted and has not ended yet.
    expect(await interrupted).toBe(1);
    const next = await adapter.startTurn(
      turnInput(workspaceDir, {
        continuation: { type: "live", session: live },
      }),
    );
    if (Result.isError(next)) {
      throw next.error;
    }
    const events: HarnessEvent[] = [];
    for await (const event of next.value.events) {
      events.push(event);
    }
    expect(events.filter(({ type }) => type === "turn.failed")).toEqual([]);
    expect(terminal(events)).toMatchObject({ type: "turn.completed" });
    expect(events).toContainEqual(
      expect.objectContaining({ type: "text.completed" }),
    );
    await next.value.dispose();
  });

  test("a sub-agent that cannot be stopped keeps nothing: the process and its work end", async () => {
    const { turn, logPath } = await completedTurn(
      "background_agent_unstoppable",
    );
    expect(await turn.release()).toBeNull();
    expect(readFileSync(logPath, "utf-8")).toContain(
      JSON.stringify({ stoppedTask: "task-serve" }),
    );
  });

  test("a turn the CLI opens while its sub-agent stops is interrupted, and the next turn waits for it", async () => {
    const { adapter, workspaceDir, turn } = await completedTurn(
      "background_own_turn_while_stopping",
    );
    const live = await turn.release();
    if (live === null) {
      throw new Error("The turn did not keep its process.");
    }
    const next = await adapter.startTurn(
      turnInput(workspaceDir, {
        continuation: { type: "live", session: live },
      }),
    );
    if (Result.isError(next)) {
      throw next.error;
    }
    const events: HarnessEvent[] = [];
    for await (const event of next.value.events) {
      events.push(event);
    }
    expect(events.filter(({ type }) => type === "turn.failed")).toEqual([]);
    expect(terminal(events)).toMatchObject({ type: "turn.completed" });
    await next.value.dispose();
  });

  test("a kept process ends by itself once its last background command exits", async () => {
    const { turn } = await completedTurn("background_command_exits");
    const live = await turn.release();
    if (live === null) {
      throw new Error("The turn did not keep its process.");
    }
    const counts: number[] = [];
    live.watch((count) => {
      counts.push(count);
    });
    await live.ended;
    expect(counts).toEqual([0]);
  });

  test("disposing a turn that kept its process ends its background work", async () => {
    const { turn, logPath } = await completedTurn("background_command_kept");
    await turn.dispose();
    expect(readFileSync(logPath, "utf-8")).toContain(
      JSON.stringify({ stoppedTask: "task-serve" }),
    );
  });
});
