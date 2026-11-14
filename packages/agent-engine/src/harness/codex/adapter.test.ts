import {
  type AnyTextAdapter,
  chat,
  EventType,
  type ModelMessage,
  normalizeStreamChunk,
  type StreamChunk,
  StreamProcessor,
  toolDefinition,
} from "@tanstack/ai";
import {
  type CodexThreadEvent,
  translateThreadEvents,
} from "@tanstack/ai-codex";
import { panic, Result } from "better-result";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import { createDetached } from "@stll/errors";

import {
  FAKE_CONTEXT_WINDOW,
  FAKE_FUTURE_RESET,
  FAKE_LONG_COMMAND,
  FAKE_MCP_CALL,
  FAKE_PRIVATE_TEXT,
  FAKE_RESUMED_THREAD_ID,
  FAKE_TEXT_ONLY_MODEL,
  FAKE_THREAD_ID,
  type FakeScenario,
} from "../../../scripts/fake-codex-app-server";
import {
  FAKE_STELLA_ANSWER,
  FAKE_STELLA_CALLS,
  FAKE_STELLA_SERVER,
  FAKE_STELLA_STEPS,
} from "../../../scripts/fake-stella-turn";
import { PROTOCOL_LOG_OFF } from "../../protocol-log";
import type { HarnessTurn, HarnessTurnInput } from "../adapter";
import { type HarnessEvent, harnessSessionId } from "../events";
import { packageCacheEnvironment } from "../package-cache";
import { harnessEventsToChunks } from "../stream-chunks";
import { createCodexHarnessAdapter } from "./adapter";
import { startAppServer } from "./app-server-client";
import {
  CODEX_ITEM_TYPES,
  CODEX_NOTIFICATIONS,
  CODEX_SERVER_REQUESTS,
  InitializeResponseSchema,
} from "./protocol";
import { CODEX_APPROVAL_OPTIONS, type CodexCapacityRetry } from "./turn";

const FAKE_SERVER = path.join(
  import.meta.dir,
  "../../../scripts/fake-codex-app-server.ts",
);
const MCP_TOKEN = "run-token-123";
/** The computer's package cache; the turn never creates it. */
const CACHE_DIR = path.join(tmpdir(), "stella-agent-package-cache");

const cleanups: (() => void)[] = [];
const backgroundErrors: unknown[] = [];
afterEach(() => {
  expect(backgroundErrors.splice(0)).toEqual([]);
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

/** Continues a turn at capacity at once, recording each delay it skipped. */
const capacityRetryRecording = () => {
  const delays: number[] = [];
  const capacityRetry: CodexCapacityRetry = {
    maxAttempts: 5,
    baseDelayMs: 10,
    maxDelayMs: 50,
    sleep: async (delayMs) => {
      delays.push(delayMs);
    },
  };
  return { delays, capacityRetry };
};

const FAST_CAPACITY_RETRY = capacityRetryRecording().capacityRetry;

const harnessFor = (
  scenario: FakeScenario,
  capacityRetry = FAST_CAPACITY_RETRY,
  environment: Readonly<Record<string, string>> = {},
) => {
  const root = mkdtempSync(path.join(tmpdir(), "stella-codex-adapter-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const codexHome = path.join(root, "codex-home");
  const workspaceDir = path.join(root, "workspace");
  const logPath = path.join(root, "fake.log");
  mkdirSync(codexHome);
  mkdirSync(workspaceDir);
  const adapter = createCodexHarnessAdapter({
    launch: { executable: process.execPath, args: [FAKE_SERVER, scenario] },
    protocolLog: PROTOCOL_LOG_OFF,
    codexHome,
    environment: {
      ...environment,
      FAKE_HARNESS_LOG: logPath,
      PATH: process.env["PATH"] ?? "",
    },
    clientVersion: "0.0.1",
    gracePeriodMs: 1000,
    requestTimeoutMs: 10_000,
    capacityRetry,
    onBackgroundError: (error) => {
      backgroundErrors.push(error);
    },
  });
  type ReceivedMessage = {
    method?: string;
    id?: unknown;
    params?: unknown;
    result?: unknown;
    error?: unknown;
  };
  /** Messages the fake server received, in order. */
  const received = (): ReceivedMessage[] =>
    readFileSync(logPath, "utf-8")
      .split("\n")
      .filter((line) => line !== "")
      .flatMap((line) => {
        const entry: { received?: ReceivedMessage } = JSON.parse(line);
        return entry.received === undefined ? [] : [entry.received];
      });
  const startup = () => {
    const first: {
      startup: {
        codexHome?: unknown;
        cwd?: unknown;
        packageCache?: unknown;
        path?: unknown;
      };
    } = JSON.parse(readFileSync(logPath, "utf-8").split("\n")[0] ?? "{}");
    return first.startup;
  };
  return { adapter, codexHome, workspaceDir, logPath, received, startup };
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
  reasoningEffort: null,
  instructions: "Use the stella MCP server.",
  policy: { network: "open", fs: "workspace", approvals: "ask" },
  mcp: {
    serverName: "stella",
    url: "https://mcp.example.test/mcp",
    token: MCP_TOKEN,
  },
  browser: null,
  transcript,
  inputFiles: [],
  continuation: { type: "fresh" },
  cacheDir: CACHE_DIR,
  skillFolders: [],
  networkHosts: [],
  toolPath: [],
  unreadablePaths: [],
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
  const collected = collect(started.turn, async (event) => {
    await options.onEvent?.(event, started.turn);
  });
  await collected.done;
  await started.turn.dispose();
  return { ...started, events: collected.events };
};

const terminal = (events: readonly HarnessEvent[]) => events.at(-1);

const FUTURE_RESET_ISO = new Date(FAKE_FUTURE_RESET * 1000).toISOString();

describe("Codex adapter over a stdio app-server", () => {
  test("runs with the stella-owned CODEX_HOME in the workspace and sends the MCP bearer only over stdio", async () => {
    const { events, received, startup, codexHome, workspaceDir } =
      await run("tool_calls");
    expect(startup()).toMatchObject({
      codexHome,
      cwd: realpathSync(workspaceDir),
    });
    const threadStart = received().find(
      ({ method }) => method === "thread/start",
    );
    expect(threadStart?.params).toMatchObject({
      model: "gpt-test",
      cwd: workspaceDir,
      approvalPolicy: "untrusted",
      sandbox: "workspace-write",
      config: {
        // At Ask Codex cannot pause a search for approval, so its web
        // search is off.
        web_search: "disabled",
        "sandbox_workspace_write.network_access": false,
        "sandbox_workspace_write.writable_roots": [CACHE_DIR],
        "sandbox_workspace_write.exclude_tmpdir_env_var": false,
        "sandbox_workspace_write.exclude_slash_tmp": false,
        "mcp_servers.stella": {
          url: "https://mcp.example.test/mcp",
          http_headers: { Authorization: `Bearer ${MCP_TOKEN}` },
        },
      },
    });
    // Usage sums the turn's two requests; the context is the last one's,
    // against the window Codex reported.
    expect(terminal(events)).toEqual({
      type: "turn.completed",
      usage: {
        inputTokens: 170,
        cachedInputTokens: 20,
        outputTokens: 40,
        reasoningOutputTokens: 5,
        context: { usedTokens: 150, windowTokens: FAKE_CONTEXT_WINDOW },
      },
    });
  });

  test.each([
    ["ask", "untrusted", false, "disabled"],
    ["auto", "untrusted", true, "live"],
    ["full_auto", "on-request", true, "live"],
  ] as const)(
    "at %s it runs in the workspace sandbox with Codex's %s policy (network %s, web search %s), asks before leaving it, and writes caches to the package cache",
    async (approvals, approvalPolicy, networkAccess, webSearch) => {
      const { received, startup } = await run("tool_calls", {
        overrides: {
          policy: { network: "open", fs: "workspace", approvals },
        },
      });
      const threadStart = received().find(
        ({ method }) => method === "thread/start",
      );
      expect(threadStart?.params).toMatchObject({
        approvalPolicy,
        sandbox: "workspace-write",
        config: {
          web_search: webSearch,
          "sandbox_workspace_write.network_access": networkAccess,
          "sandbox_workspace_write.writable_roots": [CACHE_DIR],
          "sandbox_workspace_write.exclude_tmpdir_env_var": false,
          "sandbox_workspace_write.exclude_slash_tmp": false,
        },
      });
      expect(startup().packageCache).toEqual(
        packageCacheEnvironment(CACHE_DIR),
      );
    },
  );

  test("the levels are strictly ordered: each starts Codex differently, and Auto keeps the command gate", async () => {
    const settingsAt = async (
      approvals: HarnessTurnInput["policy"]["approvals"],
    ) => {
      const { received } = await run("tool_calls", {
        overrides: {
          policy: { network: "open", fs: "workspace", approvals },
        },
      });
      const fields = (value: unknown): Record<string, unknown> =>
        typeof value === "object" && value !== null
          ? Object.fromEntries(Object.entries(value))
          : {};
      const params = fields(
        received().find(({ method }) => method === "thread/start")?.params,
      );
      return JSON.stringify([
        params["approvalPolicy"],
        fields(params["config"])["sandbox_workspace_write.network_access"],
      ]);
    };
    const ask = await settingsAt("ask");
    const auto = await settingsAt("auto");
    const fullAuto = await settingsAt("full_auto");
    expect(new Set([ask, auto, fullAuto]).size).toBe(3);
    // A ceiling at Auto never starts Codex with Full auto's policy.
    expect(auto).toBe(JSON.stringify(["untrusted", true]));
  });

  test("asks the model for the run's reasoning effort on turn/start, and for none when the run leaves it to the harness", async () => {
    const turnStart = (
      received: readonly { method?: string; params?: unknown }[],
    ) => received.find(({ method }) => method === "turn/start")?.params;
    const chosen = await run("tool_calls", {
      overrides: { reasoningEffort: "high" },
    });
    expect(turnStart(chosen.received())).toMatchObject({ effort: "high" });
    const left = await run("tool_calls");
    expect(turnStart(left.received())).not.toHaveProperty("effort");
  });

  test("a managed tool comes first on the server's PATH and the inherited PATH stays", async () => {
    const toolDir = path.join(tmpdir(), "stella-managed-bun", "bin");
    const withTool = await run("tool_calls", {
      overrides: { toolPath: [toolDir] },
    });
    expect(withTool.startup().path).toBe(
      `${toolDir}${path.delimiter}${process.env["PATH"] ?? ""}`,
    );
    const without = await run("tool_calls");
    expect(without.startup().path).toBe(process.env["PATH"]);
  });

  describe("skill folders", () => {
    /** A real skill folder, outside the harness's own directories. */
    const skillFolder = (name: string) => {
      const root = mkdtempSync(path.join(tmpdir(), "stella-skill-folder-"));
      cleanups.push(() => rmSync(root, { recursive: true, force: true }));
      const folder = path.join(root, name);
      mkdirSync(folder);
      writeFileSync(
        path.join(folder, "SKILL.md"),
        `---\nname: ${name}\ndescription: An invented skill.\n---\nBody.\n`,
      );
      return { name, path: folder };
    };

    /** Runs a turn in a workspace `prepare` may fill first. */
    const runIn = async (
      scenario: FakeScenario,
      overrides: Partial<HarnessTurnInput>,
      prepare: (workspaceDir: string) => void = () => undefined,
      environment: Readonly<Record<string, string>> = {},
    ) => {
      const harness = harnessFor(scenario, FAST_CAPACITY_RETRY, environment);
      prepare(harness.workspaceDir);
      const started = await harness.adapter.startTurn(
        turnInput(harness.workspaceDir, overrides),
      );
      const events: HarnessEvent[] = [];
      if (Result.isOk(started)) {
        for await (const event of started.value.events) {
          events.push(event);
        }
        await started.value.dispose();
      }
      return { ...harness, started, events };
    };

    const paramsOf = (
      received: readonly { method?: string; params?: unknown }[],
      method: string,
    ) => received.find((message) => message.method === method)?.params;

    const plantSkill = (workspaceDir: string) => {
      const planted = path.join(workspaceDir, ".agents", "skills", "planted");
      mkdirSync(planted, { recursive: true });
      writeFileSync(
        path.join(planted, "SKILL.md"),
        "---\nname: planted\ndescription: x\n---\nx\n",
      );
      return path.join(planted, "SKILL.md");
    };

    test("a listed folder is a root for this process, read-only, and writes nothing to the home", async () => {
      const skill = skillFolder("fixture-skill");
      const { received, codexHome } = await runIn("tool_calls", {
        skillFolders: [skill],
      });
      expect(paramsOf(received(), "skills/extraRoots/set")).toEqual({
        extraRoots: [skill.path],
      });
      expect(
        received().findIndex(
          ({ method }) => method === "skills/extraRoots/set",
        ),
      ).toBeLessThan(
        received().findIndex(({ method }) => method === "thread/start"),
      );
      expect(paramsOf(received(), "thread/start")).toMatchObject({
        config: { "sandbox_workspace_write.writable_roots": [CACHE_DIR] },
      });
      expect(
        JSON.stringify(paramsOf(received(), "thread/start")),
      ).not.toContain(skill.path);
      expect(readdirSync(codexHome)).toEqual([]);
    });

    test("without skill folders no root is set", async () => {
      const { received } = await runIn("tool_calls", {});
      expect(paramsOf(received(), "skills/extraRoots/set")).toBeUndefined();
      expect(paramsOf(received(), "thread/start")).not.toMatchObject({
        config: { "skills.config": expect.anything() },
      });
    });

    test("a folder that vanished, holds no SKILL.md or is a link is left out", async () => {
      const good = skillFolder("good-skill");
      const vanished = skillFolder("vanished-skill");
      rmSync(vanished.path, { recursive: true });
      const empty = skillFolder("empty-skill");
      rmSync(path.join(empty.path, "SKILL.md"));
      const target = skillFolder("linked-skill");
      const linked = { name: "linked", path: `${target.path}-link` };
      symlinkSync(target.path, linked.path);
      cleanups.push(() => rmSync(linked.path, { force: true }));

      const { received } = await runIn("tool_calls", {
        skillFolders: [vanished, empty, linked, good],
      });
      expect(paramsOf(received(), "skills/extraRoots/set")).toEqual({
        extraRoots: [good.path],
      });
    });

    test("a skill the workspace brings in is switched off, a listed one is not", async () => {
      const skill = skillFolder("fixture-skill");
      let planted = "";
      const { received } = await runIn(
        "tool_calls",
        { skillFolders: [skill] },
        (workspaceDir) => {
          planted = plantSkill(workspaceDir);
        },
      );
      expect(paramsOf(received(), "thread/start")).toMatchObject({
        config: { "skills.config": [{ path: planted, enabled: false }] },
      });
    });

    test("a resumed thread switches a workspace's skill off too", async () => {
      let planted = "";
      const { received } = await runIn(
        "resume_ok",
        {
          continuation: {
            type: "resume",
            sessionId: harnessSessionId(FAKE_RESUMED_THREAD_ID),
          },
        },
        (workspaceDir) => {
          planted = plantSkill(workspaceDir);
        },
      );
      expect(paramsOf(received(), "thread/resume")).toMatchObject({
        config: { "skills.config": [{ path: planted, enabled: false }] },
      });
    });

    test("only a listed folder's own SKILL.md stays on: not the member's, nothing nested, nothing through a link", async () => {
      const skill = skillFolder("fixture-skill");
      const home = skillFolder("home-holder");
      const member = path.join(home.path, ".agents", "skills", "member-skill");
      mkdirSync(member, { recursive: true });
      writeFileSync(path.join(member, "SKILL.md"), "x");
      const nested = path.join(skill.path, "vendor", "nested-skill");
      mkdirSync(nested, { recursive: true });
      writeFileSync(path.join(nested, "SKILL.md"), "x");
      const elsewhere = skillFolder("elsewhere-skill");
      const linked = path.join(skill.path, "linked");
      symlinkSync(elsewhere.path, linked);

      const { received } = await runIn(
        "tool_calls",
        { skillFolders: [skill] },
        () => undefined,
        { HOME: home.path },
      );

      const config = paramsOf(received(), "thread/start");
      const disabled = v
        .parse(
          v.object({
            config: v.object({
              "skills.config": v.array(
                v.object({ path: v.string(), enabled: v.boolean() }),
              ),
            }),
          }),
          config,
        )
        .config["skills.config"].map(({ path: file, enabled }) => {
          expect(enabled).toBe(false);
          return file;
        });
      expect(disabled.toSorted()).toEqual(
        [
          path.join(member, "SKILL.md"),
          path.join(nested, "SKILL.md"),
          path.join(linked, "SKILL.md"),
        ].toSorted(),
      );
    });

    test("a read of a skill reaches stella by name and status, an unrelated call unchanged", async () => {
      const skill = skillFolder("fixture-skill");
      const { events } = await runIn(
        "reads_skill",
        { skillFolders: [skill] },
        () => undefined,
        { FAKE_SKILL_PATH: skill.path },
      );
      expect(JSON.stringify(events)).not.toContain(skill.path);
      expect(JSON.stringify(events)).not.toContain("Licensed");
      const completed = events.flatMap((event) =>
        event.type === "tool.completed" ? [event] : [],
      );
      expect(completed[0]?.toolCall.input).toEqual({
        command: `cat <skill:${skill.name}>/SKILL.md`,
      });
      expect(completed[0]?.result).toEqual({
        content: JSON.stringify({ status: "completed" }),
        status: "succeeded",
      });
      // An unrelated command keeps its own result, which never carries its
      // output.
      expect(completed[1]?.result.content).not.toContain("notes.md");
      expect(JSON.parse(completed[1]?.result.content ?? "")).toMatchObject({
        status: "completed",
      });
    });

    test("a turn whose skills cannot be established does not run", async () => {
      const { received, started } = await runIn("skills_refused", {});
      expect(Result.isError(started) && started.error.reason).toBe(
        "start_rejected",
      );
      expect(paramsOf(received(), "thread/start")).toBeUndefined();
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
      workspaceDir: "/workspace",
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
          server: FAKE_MCP_CALL.server,
          tool: FAKE_MCP_CALL.tool,
          arguments: FAKE_MCP_CALL.arguments,
          status: "in_progress",
        },
      },
      {
        type: "item.completed",
        item: {
          id: FAKE_MCP_CALL.id,
          type: "mcp_tool_call",
          server: FAKE_MCP_CALL.server,
          tool: FAKE_MCP_CALL.tool,
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
    expect(withoutCommandOutput(stored)).toEqual(fold(local));
    expect(JSON.stringify(local)).not.toContain("aggregated_output");
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

  test('questions under ids 7 and "7" stay apart, and a secret answer reaches only the harness', async () => {
    const secret = "registry-token-value";
    const requestIds: string[] = [];
    const { events, received } = await run("twin_id_questions", {
      onEvent: async (event, turn) => {
        if (event.type !== "question.requested") {
          return;
        }
        const { requestId, questions } = event.request;
        requestIds.push(requestId);
        const answered = await turn.respond({
          type: "answers",
          requestId,
          answers:
            questions[0]?.id === "token"
              ? { token: [secret] }
              : { law: ["Czech"] },
        });
        expect(Result.isOk(answered)).toBe(true);
      },
    });
    expect(new Set(requestIds).size).toBe(2);
    const replies = received().filter(({ method }) => method === undefined);
    expect(replies).toContainEqual({
      id: 7,
      result: { answers: { token: { answers: [secret] } } },
    });
    expect(replies).toContainEqual({
      id: "7",
      result: { answers: { law: { answers: ["Czech"] } } },
    });
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(terminal(events)?.type).toBe("turn.completed");
  });

  test("a harness that never answers is ended by the request deadline, and SIGKILL follows an ignored SIGTERM", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "stella-codex-silent-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const log = path.join(root, "fake.log");
    const exits: { exitCode: number | null; signal: string | null }[] = [];
    const ready = Promise.withResolvers<undefined>();
    const started = startAppServer({
      launch: {
        executable: process.execPath,
        args: [FAKE_SERVER, "unresponsive"],
      },
      protocolLog: PROTOCOL_LOG_OFF,
      detached: createDetached((error) => {
        backgroundErrors.push(error);
      }),
      deadlines: { requestMs: 300, terminateMs: 300 },
      cwd: root,
      env: { FAKE_HARNESS_LOG: log, PATH: process.env["PATH"] ?? "" },
      handlers: {
        notification: (method) => {
          if (method === "fake/ready") {
            ready.resolve(undefined);
          }
        },
        request: () => undefined,
        violation: () => undefined,
        exit: (exit) => {
          exits.push(exit);
        },
      },
    });
    const client = Result.isOk(started)
      ? started.value
      : panic("the app-server did not start");
    // The deadline runs from the request: wait until the server is up, so a
    // slow start is never mistaken for silence.
    await ready.promise;
    const answered = await client.request("initialize", {});
    expect(Result.isError(answered) && answered.error.reason).toBe("timed_out");
    expect(await client.exited).toEqual({ exitCode: null, signal: "SIGKILL" });
    expect(exits).toHaveLength(1);
    expect(readFileSync(log, "utf-8")).toContain('"ignored":"SIGTERM"');
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

  test("the turn's images open turn/start as data URLs; a PDF stays the path the text names", async () => {
    const { events, received } = await run("tool_calls", {
      overrides: {
        inputFiles: [
          { type: "image", mediaType: "image/webp", base64: "UklGRg==" },
          { type: "pdf", base64: "JVBERi0x" },
        ],
      },
    });
    // The fake ends with code 96 on input the app-server would refuse.
    expect(terminal(events)?.type).toBe("turn.completed");
    expect(
      received().find(({ method }) => method === "turn/start")?.params,
    ).toEqual({
      threadId: FAKE_THREAD_ID,
      input: [
        { type: "image", url: "data:image/webp;base64,UklGRg==" },
        {
          type: "text",
          text: expect.stringContaining("Search both."),
          text_elements: [],
        },
      ],
    });
  });

  test("a model that reads no images gets the turn's images as the paths its text names", async () => {
    const { events, received } = await run("tool_calls", {
      overrides: {
        model: FAKE_TEXT_ONLY_MODEL,
        inputFiles: [
          { type: "image", mediaType: "image/png", base64: "iVBORw0K" },
        ],
      },
    });
    expect(terminal(events)?.type).toBe("turn.completed");
    expect(
      received().find(({ method }) => method === "turn/start")?.params,
    ).toMatchObject({
      input: [{ type: "text", text: expect.stringContaining("Search both.") }],
    });
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
        .filter(
          (m) =>
            m?.startsWith("thread/") === true &&
            !m.startsWith("thread/backgroundTerminals/"),
        ),
    ).toEqual(["thread/resume", "thread/unarchive", "thread/resume"]);
    expect(events[0]).toMatchObject({ continuation: { type: "resumed" } });
  });

  test("Codex never offers plan, and a plan turn is refused before Codex starts", async () => {
    const harness = harnessFor("tool_calls");
    const started = await harness.adapter.startTurn(
      turnInput(harness.workspaceDir, {
        policy: { network: "open", fs: "workspace", approvals: "plan" },
      }),
    );
    expect(Result.isError(started) && started.error.reason).toBe(
      "start_rejected",
    );
    // The fake app-server writes its log as it starts: it never started.
    expect(existsSync(harness.logPath)).toBe(false);
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
    // A usage limit is the member's allowance, not the model's capacity: the
    // turn is not continued.
    expect(
      limited.received().filter(({ method }) => method === "turn/start"),
    ).toHaveLength(1);
    expect(terminal(limited.events)).toEqual({
      type: "turn.failed",
      failure: {
        type: "usage_limit",
        message: "You've hit your usage limit.",
        resetsAt: FUTURE_RESET_ISO,
      },
    });
    // The update before the failure timed the reset; nothing more is read.
    expect(
      limited
        .received()
        .filter(({ method }) => method === "account/rateLimits/read"),
    ).toEqual([]);
  });

  test("a limit hit before Codex sent its limits reads them for the reset time", async () => {
    const limited = await run("usage_limit_unannounced");
    expect(terminal(limited.events)).toEqual({
      type: "turn.failed",
      failure: {
        type: "usage_limit",
        message: "You've hit your usage limit.",
        resetsAt: FUTURE_RESET_ISO,
      },
    });
    const reads = limited
      .received()
      .filter(({ method }) => method === "account/rateLimits/read");
    expect(reads).toHaveLength(1);
    expect(reads.at(0)?.params).toBeUndefined();
  });

  test("a limit whose limits cannot be read still fails as a usage limit, its reset unknown", async () => {
    const limited = await run("usage_limit_read_fails");
    expect(terminal(limited.events)).toEqual({
      type: "turn.failed",
      failure: {
        type: "usage_limit",
        message: "You've hit your usage limit.",
        resetsAt: null,
      },
    });
  });

  test("stella's MCP server failing to start fails the turn; a member's own does not", async () => {
    const failed = await run("stella_mcp_failed");
    expect(terminal(failed.events)).toEqual({
      type: "turn.failed",
      failure: {
        type: "tools_unavailable",
        message: "The harness could not connect to the stella MCP server.",
      },
    });
    const theirs = await run("other_mcp_failed");
    expect(terminal(theirs.events)?.type).toBe("turn.completed");
  });

  /** Runs a scenario whose continuations record their delays. */
  const runRecordingDelays = async (scenario: FakeScenario) => {
    const { delays, capacityRetry } = capacityRetryRecording();
    const harness = harnessFor(scenario, capacityRetry);
    const started = await harness.adapter.startTurn(
      turnInput(harness.workspaceDir),
    );
    if (Result.isError(started)) {
      throw started.error;
    }
    const collected = collect(started.value);
    await collected.done;
    await started.value.dispose();
    const starts = harness
      .received()
      .filter(({ method }) => method === "turn/start");
    return { events: collected.events, delays, starts };
  };

  test("a turn the model's capacity ended continues on the same thread with empty input, repeating nothing", async () => {
    const { events, delays, starts } =
      await runRecordingDelays("capacity_retry");
    expect(events).toContainEqual({
      type: "retrying",
      message: "Selected model is at capacity. Please try a different model.",
    });
    // The message completed before the failure stays in the thread; the
    // continuation writes only what follows it.
    expect(
      events.flatMap((event) =>
        event.type === "text.completed" ? [event.text] : [],
      ),
    ).toEqual(["Reading.", "Recovered."]);
    expect(terminal(events)).toMatchObject({ type: "turn.completed" });
    expect(delays).toEqual([10]);
    expect(starts).toHaveLength(2);
    expect(starts[1]?.params).toEqual({ threadId: FAKE_THREAD_ID, input: [] });
  });

  test("a turn still at capacity after five continuations, each waiting twice as long up to the cap, fails as the model at capacity", async () => {
    const { events, delays, starts } =
      await runRecordingDelays("capacity_exhausted");
    expect(events.filter(({ type }) => type === "retrying")).toHaveLength(5);
    expect(delays).toEqual([10, 20, 40, 50, 50]);
    expect(terminal(events)).toEqual({
      type: "turn.failed",
      failure: {
        type: "model_at_capacity",
        message: "Selected model is at capacity. Please try a different model.",
      },
    });
    expect(starts).toHaveLength(6);
  });

  test("a turn at capacity while a message streams in part fails instead of writing it again", async () => {
    const { events, delays, starts } = await runRecordingDelays(
      "capacity_mid_message",
    );
    expect(events.map(({ type }) => type)).not.toContain("retrying");
    expect(delays).toEqual([]);
    expect(terminal(events)).toEqual({
      type: "turn.failed",
      failure: {
        type: "model_at_capacity",
        message: "Selected model is at capacity. Please try a different model.",
      },
    });
    expect(starts).toHaveLength(1);
  });

  test("stopping a turn while it waits to continue ends it as interrupted", async () => {
    const wait = Promise.withResolvers<undefined>();
    const harness = harnessFor("capacity_retry", {
      ...FAST_CAPACITY_RETRY,
      sleep: async () => wait.promise,
    });
    const started = await harness.adapter.startTurn(
      turnInput(harness.workspaceDir),
    );
    if (Result.isError(started)) {
      throw started.error;
    }
    const turn = started.value;
    const collected = collect(turn, async (event) => {
      if (event.type === "retrying") {
        await turn.interrupt();
      }
    });
    await collected.done;
    // The wait ends after the stop; the stopped turn does not continue.
    wait.resolve(undefined);
    await turn.dispose();
    expect(terminal(collected.events)).toEqual({ type: "turn.interrupted" });
    const methods = harness.received().map(({ method }) => method);
    expect(methods.filter((method) => method === "turn/start")).toHaveLength(1);
    expect(methods).not.toContain("turn/interrupt");
  });

  test("a malformed line fails the turn as a protocol violation", async () => {
    const { events } = await run("malformed");
    expect(terminal(events)).toMatchObject({
      type: "turn.failed",
      failure: { type: "protocol_violation" },
    });
  });

  test("a question the chat could not answer back fails the turn instead of pausing it", async () => {
    const { events } = await run("question_twice_named");
    expect(events.map(({ type }) => type)).not.toContain("question.requested");
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

  test("a probe reports version, account, visible models with the efforts stella knows, and capabilities without a session", async () => {
    const harness = harnessFor("probe");
    const probed = await harness.adapter.probe();
    if (Result.isError(probed)) {
      throw probed.error;
    }
    expect(probed.value).toEqual({
      version: "0.166.0",
      auth: { type: "signed_in", method: "chatgpt", plan: "plus" },
      models: [
        {
          id: "gpt-test",
          displayName: "GPT Test",
          isDefault: true,
          reasoningEfforts: ["medium", "high"],
          inputModalities: ["text", "image"],
        },
      ],
      capabilities: ["approvals", "interrupt", "resume", "image_input"],
      approvalModes: ["ask", "auto", "full_auto"],
      // The plan's main window is at 40 %.
      usageLimit: null,
    });
    const methods = harness.received().map(({ method }) => method);
    expect(methods).toContain("account/rateLimits/read");
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

  test("a probe of a Codex out of usage reports when its plan's limit resets", async () => {
    const probed = await harnessFor("probe_out_of_usage").adapter.probe();
    if (Result.isError(probed)) {
      throw probed.error;
    }
    expect(probed.value.usageLimit).toEqual({ resetsAt: FUTURE_RESET_ISO });
  });

  test("a probe of a spent plan with credits left stays ready", async () => {
    const probed = await harnessFor(
      "probe_out_of_usage_with_credits",
    ).adapter.probe();
    if (Result.isError(probed)) {
      throw probed.error;
    }
    expect(probed.value.usageLimit).toBeNull();
  });

  test("a probe whose limits cannot be read stays ready, its limit unknown", async () => {
    const harness = harnessFor("probe_limits_unreadable");
    const probed = await harness.adapter.probe();
    if (Result.isError(probed)) {
      throw probed.error;
    }
    expect(probed.value.auth.type).toBe("signed_in");
    expect(probed.value.usageLimit).toBeNull();
    expect(harness.received().map(({ method }) => method)).toContain(
      "account/rateLimits/read",
    );
  });

  test("refuses a CODEX_HOME that is the user's own", () => {
    expect(() =>
      createCodexHarnessAdapter({
        launch: { executable: process.execPath, args: [] },
        protocolLog: PROTOCOL_LOG_OFF,
        codexHome: path.join(process.env["HOME"] ?? "/", ".codex"),
        environment: {},
        clientVersion: "0.0.1",
        gracePeriodMs: 10,
        requestTimeoutMs: 10,
        onBackgroundError: () => undefined,
      }),
    ).toThrow("CODEX_HOME must be stella's");
  });
});

/** Fold chunks the way persistence does and return what would be stored. */
/**
 * A cloud turn's parts as a local turn keeps them: a command's output stays
 * on the member's computer, so its result keeps only its exit code and
 * status, in the same order.
 */
const withoutCommandOutput = (value: unknown): unknown => {
  if (typeof value === "string") {
    if (!value.includes('"aggregated_output"')) {
      return value;
    }
    const { aggregated_output: _output, ...kept } = v.parse(
      v.record(v.string(), v.unknown()),
      JSON.parse(value),
    );
    return JSON.stringify(kept);
  }
  if (Array.isArray(value)) {
    return value.map(withoutCommandOutput);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "aggregated_output")
        .map(([key, entry]) => [key, withoutCommandOutput(entry)]),
    );
  }
  return value;
};

const storedMessages = (chunks: readonly StreamChunk[]) => {
  const processor = new StreamProcessor({ initialMessages: [] });
  for (const chunk of chunks) {
    processor.processChunk(chunk);
  }
  return processor.getMessages().map(({ role, parts }) => ({ role, parts }));
};

const localChunks = async (events: readonly HarnessEvent[]) => {
  let next = 0;
  const chunks: StreamChunk[] = [];
  async function* from() {
    yield* events;
  }
  for await (const chunk of harnessEventsToChunks(from(), {
    harness: "codex",
    model: "gpt-test",
    runId: "run-1",
    threadId: "stella-thread-1",
    workspaceDir: "/workspace",
    generateId: () => `result-${(next += 1)}`,
    now: () => 0,
  })) {
    chunks.push(chunk);
  }
  return chunks;
};

/**
 * The cloud engine running the same stella tool calls: TanStack's `chat()`
 * loop with a model that calls the tools and then answers, and server tools
 * that return what the stella MCP server returned for each call.
 */
const cloudChatChunks = async () => {
  const model = "gpt-test";
  const timestamp = 0;
  let iteration = 0;
  const adapter: AnyTextAdapter = {
    kind: "text",
    name: "scripted",
    model,
    "~types": {
      providerOptions: {},
      inputModalities: ["text"],
      messageMetadataByModality: {},
      toolCapabilities: [],
      toolCallMetadata: {},
      systemPromptMetadata: undefined,
    },
    async *chatStream({ runId, threadId }) {
      // One model step per iteration, exactly as the fake harness replays
      // them; the answer follows the last step's results.
      const step = FAKE_STELLA_STEPS.at(iteration);
      iteration += 1;
      const ids = { runId: runId ?? "run-1", threadId: threadId ?? "t-1" };
      yield { type: EventType.RUN_STARTED, ...ids, model, timestamp };
      if (step !== undefined) {
        for (const call of step) {
          const args = JSON.stringify(call.arguments);
          yield {
            type: EventType.TOOL_CALL_START,
            toolCallId: call.id,
            toolCallName: call.tool,
            toolName: call.tool,
            model,
            timestamp,
          };
          yield {
            type: EventType.TOOL_CALL_ARGS,
            toolCallId: call.id,
            delta: args,
            model,
            timestamp,
          };
          yield {
            type: EventType.TOOL_CALL_END,
            toolCallId: call.id,
            toolCallName: call.tool,
            toolName: call.tool,
            input: call.arguments,
            model,
            timestamp,
          };
        }
        yield {
          type: EventType.RUN_FINISHED,
          ...ids,
          finishReason: "tool_calls",
          model,
          timestamp,
        };
        return;
      }
      const messageId = "answer";
      yield {
        type: EventType.TEXT_MESSAGE_START,
        messageId,
        role: "assistant",
        model,
        timestamp,
      };
      yield {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId,
        delta: FAKE_STELLA_ANSWER,
        model,
        timestamp,
      };
      yield { type: EventType.TEXT_MESSAGE_END, messageId, model, timestamp };
      yield {
        type: EventType.RUN_FINISHED,
        ...ids,
        finishReason: "stop",
        model,
        timestamp,
      };
    },
    structuredOutput: () => panic("not used"),
  };
  const tools = FAKE_STELLA_CALLS.map((call) =>
    toolDefinition({
      name: call.tool,
      description: call.tool,
      inputSchema: { type: "object" },
    }).server(async () => call.output),
  );
  const chunks: StreamChunk[] = [];
  for await (const chunk of chat({
    adapter,
    messages: [{ role: "user", content: "Search both." }],
    tools,
    runId: "run-1",
    threadId: "stella-thread-1",
  })) {
    chunks.push(chunk);
  }
  return chunks;
};

describe("Codex items as chat parts", () => {
  test("stella tool calls persist the same parts as a cloud chat turn making the same calls", async () => {
    const { events } = await run("stella_tools");
    const local = storedMessages(await localChunks(events));
    const cloud = storedMessages(await cloudChatChunks());
    // The cloud turn reached the tools: one call and one result per call.
    const cloudParts = cloud.flatMap(({ parts }) => parts);
    expect(
      cloudParts.flatMap((part) =>
        part.type === "tool-call" ? [part.name] : [],
      ),
    ).toEqual(FAKE_STELLA_CALLS.map(({ tool }) => tool));
    expect(
      cloudParts.filter(({ type }) => type === "tool-result"),
    ).toHaveLength(FAKE_STELLA_CALLS.length);
    expect(local).toEqual(cloud);
  });

  test("the answer's markdown reaches the stored text unchanged", async () => {
    const { events } = await run("stella_tools");
    const parts = storedMessages(await localChunks(events)).flatMap(
      ({ parts: stored }) => stored,
    );
    expect(
      parts.flatMap((part) => (part.type === "text" ? [part.content] : [])),
    ).toEqual([FAKE_STELLA_ANSWER]);
  });

  test("a native step shows its command, file names and plan titles, and never the text it carries", async () => {
    const { events } = await run("native_tools");
    const parts = storedMessages(await localChunks(events)).flatMap(
      ({ parts: stored }) => stored,
    );
    const calls = parts.flatMap((part) =>
      part.type === "tool-call"
        ? [{ id: part.id, name: part.name, input: part.input }]
        : [],
    );
    const plan = (items: string[]) => ({
      tool: "update_plan",
      detail: { kind: "plan", items },
    });
    expect(calls).toEqual([
      {
        id: "turn-1:plan:1",
        name: "harness_native_tool",
        input: plan(["Read the lease", "Draft the notice"]),
      },
      // A heredoc shows the line that runs it, never the lines it writes.
      {
        id: "call-heredoc",
        name: "command_execution",
        input: { command: `/bin/zsh -lc "cat > notes.md <<'EOF'…` },
      },
      {
        id: "call-long",
        name: "command_execution",
        input: { command: `${FAKE_LONG_COMMAND.slice(0, 299)}…` },
      },
      {
        id: "call-edit",
        name: "file_change",
        input: {
          changes: [
            { path: "drafts/lease.md", kind: "update" },
            { path: "drafts/notice.md", kind: "add" },
          ],
        },
      },
      {
        id: "turn-1:plan:2",
        name: "harness_native_tool",
        input: plan(["Read the lease", "Draft the notice"]),
      },
    ]);
    // A command's exit status stays on its result.
    expect(
      parts.find(
        (part) => part.type === "tool-call" && part.id === "call-heredoc",
      ),
    ).toMatchObject({ output: { exit_code: 1, status: "failed" } });
    // A command's output never leaves, in its call, its result or the part.
    expect(JSON.stringify(parts)).not.toContain("permission denied");
    expect(JSON.stringify(parts)).not.toContain("aggregated_output");
    const callText = JSON.stringify(
      parts
        .filter((part) => part.type === "tool-call")
        .map(({ input }) => input),
    );
    for (const text of Object.values(FAKE_PRIVATE_TEXT)) {
      expect(callText).not.toContain(text);
    }
    expect(callText).not.toContain("y".repeat(300));
  });

  test("harness-native items become generic activity and never carry the native payload", async () => {
    const { events } = await run("harness_items");
    const tools = events.flatMap((event) =>
      event.type === "tool.completed" ? [event] : [],
    );
    expect(
      tools.map(({ toolCall, result }) => ({
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
        input: { changes: [{ path: "notes.md", kind: "update" }] },
        status: "succeeded",
      },
      {
        name: "harness_web_search",
        input: { query: "civil code lease" },
        status: "succeeded",
      },
      {
        name: "harness_unsupported_item",
        input: { itemType: "holographicCall" },
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
    const stored = JSON.stringify(storedMessages(await localChunks(events)));
    // Dropped kinds and native-only fields stay out of what is stored.
    for (const native of ["never forwarded", "+x", "1. Search", "compact-1"]) {
      expect(stored).not.toContain(native);
    }
    expect(terminal(events)).toEqual({ type: "turn.completed", usage: null });
  });

  test("a subagent is a step that ends with the subagent, the steps it takes are its steps, and what it was told, wrote and reported stays on the computer", async () => {
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
    const subagent = {
      tool: "spawnAgent",
      detail: { kind: "subagent", description: "" },
    };
    const inSubagent = { parentCallId: "call-spawn" };
    const followupStep = "call-followup:thread-subagent";
    // The spawn call ends at once; the step stays open until the subagent
    // is reported ended, once.
    expect(
      events.flatMap((event) =>
        event.type === "tool.started" || event.type === "tool.completed"
          ? [
              {
                type: event.type,
                id: event.toolCall.id,
                name: event.toolCall.name,
                input: event.toolCall.input,
                ...(event.toolCall.parentCallId === undefined
                  ? {}
                  : { parentCallId: event.toolCall.parentCallId }),
                ...(event.type === "tool.completed"
                  ? { status: event.result.status }
                  : {}),
              },
            ]
          : [],
      ),
    ).toEqual([
      {
        type: "tool.started",
        id: "call-spawn",
        name: "harness_native_tool",
        input: subagent,
      },
      {
        type: "tool.started",
        id: "sub-rm",
        name: "command_execution",
        input: { command: "rm draft.md" },
        ...inSubagent,
      },
      {
        type: "tool.completed",
        id: "sub-rm",
        name: "command_execution",
        input: { command: "rm draft.md" },
        ...inSubagent,
        status: "succeeded",
      },
      {
        type: "tool.completed",
        id: "sub-image",
        name: "harness_native_tool",
        input: {
          tool: "view_image",
          detail: { kind: "image", path: "/workspace/scans/Lease Page 1.png" },
        },
        ...inSubagent,
        status: "succeeded",
      },
      {
        type: "tool.completed",
        id: "call-image",
        name: "harness_native_tool",
        input: {
          tool: "view_image",
          detail: { kind: "image", path: "/workspace/scans/cover.png" },
        },
        status: "succeeded",
      },
      {
        type: "tool.completed",
        id: "call-spawn",
        name: "harness_native_tool",
        input: subagent,
        status: "succeeded",
      },
      // Given more work after it ended, the subagent is a new step, opened
      // by the call that reports it at work; what it does next and how that
      // ends belong to that step.
      {
        type: "tool.started",
        id: followupStep,
        name: "harness_native_tool",
        input: { ...subagent, tool: "followupTask" },
      },
      {
        type: "tool.completed",
        id: "sub-ls",
        name: "command_execution",
        input: { command: "ls" },
        parentCallId: followupStep,
        status: "succeeded",
      },
      {
        type: "tool.completed",
        id: followupStep,
        name: "harness_native_tool",
        input: { ...subagent, tool: "followupTask" },
        status: "failed",
      },
      {
        type: "tool.started",
        id: "call-spawn-failed",
        name: "harness_native_tool",
        input: subagent,
      },
      {
        type: "tool.completed",
        id: "call-spawn-failed",
        name: "harness_native_tool",
        input: subagent,
        status: "failed",
      },
      {
        type: "tool.started",
        id: "call-spawn-open",
        name: "harness_native_tool",
        input: subagent,
      },
    ]);
    // An approval a subagent's step asks for reaches the member on that step.
    expect(approvals).toMatchObject([
      {
        request: {
          kind: "command",
          toolCall: {
            id: "sub-rm",
            input: { command: "rm draft.md" },
            ...inSubagent,
          },
        },
      },
    ]);
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
    // What a subagent was told, wrote and reported, and the image a step
    // viewed, are held for this computer alone: on the step's result, which
    // the sidecar keeps, never in what the turn reports.
    const heldOf = (id: string) =>
      events.flatMap((event) =>
        event.type === "tool.completed" && event.toolCall.id === id
          ? [event.result.localOutput]
          : [],
      );
    expect(heldOf("call-spawn")).toEqual([
      {
        type: "conversation",
        entries: [
          { role: "prompt", text: FAKE_PRIVATE_TEXT.subagentPrompt },
          { role: "report", text: FAKE_PRIVATE_TEXT.subagentReport },
          { role: "message", text: FAKE_PRIVATE_TEXT.subagentText },
        ],
        droppedBytes: 0,
      },
    ]);
    expect(heldOf("sub-image")).toEqual([
      { type: "image", path: "/workspace/scans/Lease Page 1.png" },
    ]);
    // A spawn that failed started no subagent: it holds no conversation.
    expect(heldOf("call-spawn-failed")).toEqual([undefined]);
    const stored = storedMessages(await localChunks(events));
    const storedText = JSON.stringify(stored);
    for (const text of [
      FAKE_PRIVATE_TEXT.subagentPrompt,
      FAKE_PRIVATE_TEXT.subagentText,
      FAKE_PRIVATE_TEXT.subagentThinking,
      FAKE_PRIVATE_TEXT.subagentReport,
    ]) {
      expect(storedText).not.toContain(text);
    }
    // A subagent still at work when the turn ends is closed with the turn.
    const parts = stored.flatMap(({ parts: kept }) => kept);
    expect(
      parts.flatMap((part) =>
        part.type === "tool-call" && part.id.startsWith("call-spawn")
          ? [{ id: part.id, output: part.output }]
          : [],
      ),
    ).toEqual([
      { id: "call-spawn", output: { status: "completed" } },
      { id: "call-spawn-failed", output: { status: "failed" } },
      { id: "call-spawn-open", output: { status: "interrupted" } },
    ]);
  });

  test("a failed stella call stores its error envelope as a failed result", async () => {
    const { events } = await run("harness_items");
    const parts = storedMessages(await localChunks(events)).flatMap(
      ({ parts: stored }) => stored,
    );
    const failed = parts.find(
      (part) => part.type === "tool-call" && part.id === "call-failed",
    );
    expect(failed).toMatchObject({
      name: "search_case_law",
      output: { error: { code: "invalid_input", message: "Query is empty." } },
    });
    expect(
      parts.find(
        (part) =>
          part.type === "tool-result" && part.toolCallId === "call-failed",
      ),
    ).toMatchObject({ state: "error" });
  });
});

describe("Codex background terminals after a turn", () => {
  const completedTurn = async (scenario: FakeScenario) => {
    const started = await start(scenario);
    const collected = collect(started.turn);
    await collected.done;
    expect(terminal(collected.events)).toMatchObject({
      type: "turn.completed",
    });
    return started;
  };

  test("keep the process, and the chat's next turn runs on the same thread in it", async () => {
    const { adapter, workspaceDir, received, logPath, turn } =
      await completedTurn("background_terminal");
    const live = await turn.release();
    if (live === null) {
      throw new Error("The turn did not keep its process.");
    }
    expect(live.harness).toBe("codex");
    expect(live.sessionId).toBe(harnessSessionId(FAKE_THREAD_ID));
    expect(live.backgroundTasks).toBe(1);

    const next = await adapter.startTurn(
      turnInput(workspaceDir, {
        continuation: { type: "live", session: live },
      }),
    );
    if (Result.isError(next)) {
      throw next.error;
    }
    const collected = collect(next.value);
    await collected.done;
    expect(collected.events[0]).toEqual({
      type: "session.started",
      sessionId: harnessSessionId(FAKE_THREAD_ID),
      continuation: { type: "resumed" },
    });
    expect(terminal(collected.events)).toMatchObject({
      type: "turn.completed",
    });
    // Its server exited during the turn: nothing is kept any more.
    expect(await next.value.release()).toBeNull();

    const startups = readFileSync(logPath, "utf-8")
      .split("\n")
      .filter((line) => line.includes('"startup"'));
    expect(startups).toHaveLength(1);
    const methods = received().map(({ method }) => method);
    expect(methods.filter((method) => method === "initialize")).toHaveLength(1);
    expect(methods).not.toContain("thread/resume");
    const turnStarts = received().filter(
      ({ method }) => method === "turn/start",
    );
    expect(turnStarts).toHaveLength(2);
    expect(turnStarts[1]?.params).toMatchObject({ threadId: FAKE_THREAD_ID });
    expect(methods).toContain("thread/backgroundTerminals/clean");
  });

  test("a kept process ends by itself once its last background command exits", async () => {
    const { turn, received } = await completedTurn("background_terminal_exits");
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
    expect(live.backgroundTasks).toBe(0);
    expect(received().map(({ method }) => method)).toContain(
      "thread/backgroundTerminals/clean",
    );
  });

  test("ending a kept process cleans its terminals before it closes", async () => {
    const { turn, logPath } = await completedTurn("background_terminal");
    const live = await turn.release();
    if (live === null) {
      throw new Error("The turn did not keep its process.");
    }
    await live.end();
    expect(readFileSync(logPath, "utf-8")).toContain(
      JSON.stringify({ cleaned: ["call-serve"] }),
    );
  });

  test("a failed terminal list is reported and keeps the commands the turn left running", async () => {
    const { turn } = await completedTurn("background_terminal_list_fails");
    const live = await turn.release();
    if (live === null) {
      throw new Error("The turn did not keep its process.");
    }
    // Not read as an empty inventory: the started command still counts.
    expect(live.backgroundTasks).toBe(1);
    expect(backgroundErrors.splice(0)).toEqual([
      expect.objectContaining({
        _tag: "CodexTerminalListError",
        reason: "failed",
      }),
    ]);
    await live.end();
  });

  test("a release without the terminal list keeps nothing past the turn", async () => {
    const { turn } = await completedTurn(
      "background_terminal_list_unsupported",
    );
    expect(await turn.release()).toBeNull();
  });

  test("a turn without background work closes its process as before", async () => {
    const { turn } = await completedTurn("tool_calls");
    expect(await turn.release()).toBeNull();
  });
});

/**
 * Checks against a real `codex` CLI when one is installed. Nothing here
 * signs in or sends a prompt: the handshake is `initialize` only, and the
 * protocol schema comes from `codex app-server generate-json-schema`, which
 * runs offline. Without a CLI the suite is skipped; the fake-server suites
 * above always run.
 */

const codex = Bun.which("codex");

/** Client methods the adapter calls. */
const CLIENT_METHODS = [
  "initialize",
  "account/read",
  "account/rateLimits/read",
  "model/list",
  "thread/start",
  "thread/resume",
  "thread/unarchive",
  "turn/start",
  "turn/interrupt",
] as const;

/** Experimental client methods the adapter calls; `initialize` opts in. */
const EXPERIMENTAL_CLIENT_METHODS = [
  "thread/backgroundTerminals/list",
  "thread/backgroundTerminals/clean",
] as const;

const OneOfMethods = v.object({
  oneOf: v.array(
    v.object({
      properties: v.object({
        method: v.object({ enum: v.tuple([v.string()]) }),
      }),
    }),
  ),
});

const DecisionSchema = v.object({
  definitions: v.record(
    v.string(),
    v.object({
      oneOf: v.optional(
        v.array(v.object({ enum: v.optional(v.array(v.string())) })),
      ),
    }),
  ),
});

const ThreadItemTypes = v.object({
  definitions: v.object({
    ThreadItem: v.object({
      oneOf: v.array(
        v.object({
          properties: v.object({
            type: v.object({ enum: v.tuple([v.string()]) }),
          }),
        }),
      ),
    }),
  }),
});

const UserInputVariants = v.object({
  definitions: v.object({
    UserInput: v.object({ oneOf: v.array(v.looseObject({})) }),
  }),
});

const readJson = async (directory: string, file: string): Promise<unknown> =>
  Bun.file(path.join(directory, file)).json();

const methodsIn = async (directory: string, file: string) =>
  v
    .parse(OneOfMethods, await readJson(directory, file))
    .oneOf.map(({ properties }) => properties.method.enum[0]);

const decisionsIn = async (directory: string, file: string, name: string) =>
  (
    v.parse(DecisionSchema, await readJson(directory, file)).definitions[name]
      ?.oneOf ?? []
  ).flatMap(({ enum: values }) => values ?? []);

describe.skipIf(codex === null)("the installed codex CLI", () => {
  // Made only when the suite runs: a skipped describe still collects.
  let root = "";
  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), "stella-real-codex-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("completes the initialize handshake with a stella-owned home", async () => {
    const codexHome = path.join(root, "home");
    const cliErrors: unknown[] = [];
    mkdirSync(codexHome);
    const started = startAppServer({
      launch: { executable: codex ?? "", args: ["app-server"] },
      protocolLog: PROTOCOL_LOG_OFF,
      detached: createDetached((error) => {
        cliErrors.push(error);
      }),
      deadlines: { requestMs: 30_000, terminateMs: 5000 },
      cwd: root,
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: process.env["HOME"] ?? "",
        CODEX_HOME: codexHome,
      },
      handlers: {
        notification: () => undefined,
        request: () => undefined,
        violation: () => undefined,
        exit: () => undefined,
      },
    });
    const client = Result.isOk(started)
      ? started.value
      : panic("the app-server did not start");
    const initialized = await client.request("initialize", {
      clientInfo: { name: "stella", title: "stella", version: "0.0.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    await client.kill();
    expect(cliErrors).toEqual([]);
    if (Result.isError(initialized)) {
      throw initialized.error;
    }
    const parsed = v.parse(InitializeResponseSchema, initialized.value);
    expect(parsed.codexHome).toContain("home");
    expect(parsed.userAgent).toMatch(/^stella\/\d+\.\d+\.\d+/u);
  });

  test("the protocol still has every method, item kind and decision the adapter relies on", async () => {
    const out = path.join(root, "schema");
    const generated = Bun.spawnSync([
      codex ?? "",
      "app-server",
      "generate-json-schema",
      "--out",
      out,
    ]);
    expect(generated.exitCode).toBe(0);

    const serverRequests = await methodsIn(out, "ServerRequest.json");
    expect(new Set(serverRequests)).toEqual(
      new Set(Object.keys(CODEX_SERVER_REQUESTS)),
    );

    const notifications = new Set(
      await methodsIn(out, "ServerNotification.json"),
    );
    for (const method of Object.keys(CODEX_NOTIFICATIONS)) {
      expect(notifications.has(method)).toBe(true);
    }

    const clientMethods = new Set(await methodsIn(out, "ClientRequest.json"));
    for (const method of CLIENT_METHODS) {
      expect(clientMethods.has(method)).toBe(true);
    }
    const experimentalOut = path.join(root, "experimental-schema");
    const experimental = Bun.spawnSync([
      codex ?? "",
      "app-server",
      "generate-json-schema",
      "--experimental",
      "--out",
      experimentalOut,
    ]);
    expect(experimental.exitCode).toBe(0);
    const experimentalMethods = new Set(
      await methodsIn(experimentalOut, "ClientRequest.json"),
    );
    for (const method of EXPERIMENTAL_CLIENT_METHODS) {
      expect(experimentalMethods.has(method)).toBe(true);
    }

    const itemTypes = v
      .parse(
        ThreadItemTypes,
        await readJson(out, "codex_app_server_protocol.v2.schemas.json"),
      )
      .definitions.ThreadItem.oneOf.map(
        ({ properties }) => properties.type.enum[0],
      );
    expect(new Set(itemTypes)).toEqual(new Set(CODEX_ITEM_TYPES));

    // `turn/start` takes an image as a URL, which a data URL is.
    const userInputs = v.parse(
      UserInputVariants,
      await readJson(out, "codex_app_server_protocol.v2.schemas.json"),
    ).definitions.UserInput.oneOf;
    expect(userInputs).toContainEqual(
      expect.objectContaining({
        title: "ImageUserInput",
        anyOf: expect.arrayContaining([
          expect.objectContaining({ title: "UrlUserInput", required: ["url"] }),
        ]),
      }),
    );

    const commandDecisions = await decisionsIn(
      out,
      "CommandExecutionRequestApprovalResponse.json",
      "CommandExecutionApprovalDecision",
    );
    const fileDecisions = await decisionsIn(
      out,
      "FileChangeRequestApprovalResponse.json",
      "FileChangeApprovalDecision",
    );
    for (const { id } of CODEX_APPROVAL_OPTIONS) {
      expect(commandDecisions).toContain(id);
      expect(fileDecisions).toContain(id);
    }
  });
});
