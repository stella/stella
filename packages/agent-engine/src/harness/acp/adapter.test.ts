import { Result } from "better-result";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  FAKE_ACP_MODEL,
  FAKE_ACP_OTHER_MODEL,
  FAKE_ACP_REPLAYED_TEXT,
  FAKE_ACP_RESUMED_SESSION,
  FAKE_ACP_SESSION,
  FAKE_ACP_VERSION,
  type FakeAcpScenario,
} from "../../../scripts/fake-acp-agent";
import { PROTOCOL_LOG_OFF } from "../../protocol-log";
import type { HarnessTurn, HarnessTurnInput } from "../adapter";
import { type HarnessEvent, harnessSessionId } from "../events";
import { HARNESS_TOOL_NAMES } from "../tool-parts";
import { createAcpHarnessAdapter } from "./adapter";
import type { AcpAgentDefinition } from "./definition";
import { isSessionBroken, markSessionBroken } from "./state-dir";

// timeout: each test starts a Bun process for the stand-in agent and waits
// on its exit, which a loaded CI runner can take seconds to schedule.
setDefaultTimeout(30_000);

const FAKE_AGENT = path.join(
  import.meta.dir,
  "../../../scripts/fake-acp-agent.ts",
);
const MCP_TOKEN = "run-token-acp";
const CACHE_DIR = path.join(tmpdir(), "stella-agent-package-cache");

/** Any harness id: the fake stands in for whichever agent a definition names. */
const DEFINITION: AcpAgentDefinition = {
  harness: "opencode",
  displayName: "Fake agent",
  args: () => [],
  environment: ({ configDir }) => ({ FAKE_AGENT_HOME: configDir }),
  removedEnvironment: ["FAKE_AGENT_SECRET"],
  approvalModes: ["ask", "auto"],
  sessionModes: { ask: "default", auto: "accept_edits" },
  storedSignIn: null,
  ownTempDir: false,
  probeCacheMs: 0,
  steers: () => false,
  brokenSession: (message) => message.includes("thinking.signature"),
  discardSession: null,
};

/** Signed in once `signed-in` is in the agent's state directory. */
const STORED_SIGN_IN = {
  methodId: "fake-login",
  signedIn: (configDir: string) =>
    existsSync(path.join(configDir, "signed-in")),
};

const cleanups: (() => void)[] = [];
const backgroundErrors: unknown[] = [];
afterEach(() => {
  expect(backgroundErrors.splice(0)).toEqual([]);
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

type Received = {
  jsonrpc?: string;
  method?: string;
  id?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

const harnessFor = (
  scenario: FakeAcpScenario,
  definition: Partial<AcpAgentDefinition> = {},
) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "stella-acp-")));
  cleanups.push(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const configDir = path.join(root, "agent-home");
  const workspaceDir = path.join(root, "workspace");
  const unreadableDir = path.join(root, "other-chat");
  const logPath = path.join(root, "fake.log");
  mkdirSync(configDir);
  mkdirSync(workspaceDir);
  const adapter = createAcpHarnessAdapter({
    // The fake runs as `bun <script> <scenario>`: the executable is Bun.
    definition: {
      ...DEFINITION,
      ...definition,
      args: () => [FAKE_AGENT, scenario],
    },
    executable: process.execPath,
    configDir,
    environment: {
      PATH: process.env["PATH"] ?? "",
      FAKE_HARNESS_LOG: logPath,
      FAKE_AGENT_SECRET: "must-not-reach-the-agent",
      FAKE_ACP_WORKSPACE: workspaceDir,
      FAKE_ACP_UNREADABLE: unreadableDir,
    },
    clientVersion: "0.9.90",
    gracePeriodMs: 1000,
    requestTimeoutMs: 10_000,
    onBackgroundError: (error) => {
      backgroundErrors.push(error);
    },
    protocolLog: PROTOCOL_LOG_OFF,
    platform: process.platform,
  });
  const lines = () =>
    readFileSync(logPath, "utf-8")
      .split("\n")
      .filter((line) => line !== "");
  const received = (): Received[] =>
    lines().flatMap((line) => {
      const entry: { received?: Received } = JSON.parse(line);
      return entry.received === undefined ? [] : [entry.received];
    });
  const startup = () => {
    const first: {
      startup: { cwd: string; env: Record<string, string | undefined> };
    } = JSON.parse(lines()[0] ?? "{}");
    return first.startup;
  };
  return {
    adapter,
    logPath,
    configDir,
    workspaceDir,
    unreadableDir,
    received,
    startup,
  };
};

const turnInput = (
  workspaceDir: string,
  overrides: Partial<HarnessTurnInput> = {},
): HarnessTurnInput => ({
  runId: "run-1",
  threadId: "stella-thread-1",
  workspaceDir,
  cacheDir: CACHE_DIR,
  unreadablePaths: [],
  skillFolders: [],
  networkHosts: [],
  toolPath: [],
  model: FAKE_ACP_MODEL,
  reasoningEffort: "medium",
  instructions: "Use the stella MCP server.",
  policy: { network: "open", fs: "workspace", approvals: "ask" },
  mcp: {
    serverName: "stella",
    url: "https://mcp.example.test/mcp",
    token: MCP_TOKEN,
  },
  browser: null,
  transcript: [
    { role: "user", content: "Find the leases." },
    { role: "assistant", content: "There are two folders." },
    { role: "user", content: "Search both." },
  ],
  inputFiles: [],
  continuation: { type: "fresh" },
  ...overrides,
});

/** A turn at Auto on the other model and effort: the session is configured. */
const CONFIGURED = {
  model: FAKE_ACP_OTHER_MODEL,
  reasoningEffort: "high",
  policy: { network: "open", fs: "workspace", approvals: "auto" },
} as const satisfies Partial<HarnessTurnInput>;

const run = async (
  scenario: FakeAcpScenario,
  options: {
    definition?: Partial<AcpAgentDefinition>;
    /** Before the turn starts. */
    prepare?: (harness: ReturnType<typeof harnessFor>) => void;
    overrides?: (
      harness: ReturnType<typeof harnessFor>,
    ) => Partial<HarnessTurnInput>;
    onEvent?: (event: HarnessEvent, turn: HarnessTurn) => Promise<void> | void;
  } = {},
) => {
  const harness = harnessFor(scenario, options.definition);
  options.prepare?.(harness);
  const started = await harness.adapter.startTurn(
    turnInput(harness.workspaceDir, options.overrides?.(harness)),
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

const ofType = <TType extends HarnessEvent["type"]>(
  events: readonly HarnessEvent[],
  type: TType,
) =>
  events.filter(
    (event): event is Extract<HarnessEvent, { type: TType }> =>
      event.type === type,
  );

describe("ACP adapter over a stdio agent", () => {
  test("probe reports the agent's version, models, efforts and what it can do", async () => {
    const { adapter, received, configDir } = harnessFor("probe");
    const probed = await adapter.probe();
    expect(Result.isOk(probed) ? probed.value : probed.error).toEqual({
      version: FAKE_ACP_VERSION,
      auth: { type: "signed_in", method: "agent", plan: null },
      models: [
        {
          id: FAKE_ACP_MODEL,
          displayName: "Fake Pro",
          isDefault: true,
          reasoningEfforts: ["low", "medium", "high"],
          inputModalities: ["text", "image"],
        },
        {
          id: FAKE_ACP_OTHER_MODEL,
          displayName: "Fake Flash",
          isDefault: false,
          reasoningEfforts: [],
          inputModalities: ["text", "image"],
        },
      ],
      capabilities: ["approvals", "interrupt", "resume", "image_input"],
      approvalModes: ["ask", "auto"],
      usageLimit: null,
    });
    const [initialize] = received();
    expect(initialize).toMatchObject({
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: "stella", version: "0.9.90" },
      },
    });
    // The probe's session folder is gone with it.
    expect(readdirSync(configDir)).toEqual([]);
  });

  test("probe reports a signed-out agent without models", async () => {
    const probed = await harnessFor("probe_signed_out").adapter.probe();
    expect(Result.isOk(probed) && probed.value.auth).toEqual({
      type: "signed_out",
    });
  });

  test("an agent that takes no MCP servers over HTTP is unavailable", async () => {
    const probed = await harnessFor("probe_no_http").adapter.probe();
    expect(Result.isError(probed) && probed.error.reason).toBe(
      "harness_unavailable",
    );
  });

  test("a turn streams text, reasoning, tool calls and a plan, and completes with usage", async () => {
    const { events, received, startup, workspaceDir, configDir } = await run(
      "turn",
      { overrides: () => CONFIGURED },
    );
    expect(startup().cwd).toBe(workspaceDir);
    expect(startup().env["FAKE_AGENT_HOME"]).toBe(configDir);
    expect(startup().env["FAKE_AGENT_SECRET"]).toBeUndefined();
    const sent = received();
    expect(sent.find(({ method }) => method === "session/new")?.params).toEqual(
      {
        cwd: workspaceDir,
        mcpServers: [
          {
            type: "http",
            name: "stella",
            url: "https://mcp.example.test/mcp",
            headers: [{ name: "Authorization", value: `Bearer ${MCP_TOKEN}` }],
          },
        ],
      },
    );
    expect(
      sent.find(({ method }) => method === "session/set_mode")?.params,
    ).toEqual({
      sessionId: FAKE_ACP_SESSION,
      modeId: "accept_edits",
    });
    expect(
      sent.find(({ method }) => method === "session/set_model")?.params,
    ).toEqual({
      sessionId: FAKE_ACP_SESSION,
      modelId: FAKE_ACP_OTHER_MODEL,
    });
    expect(
      sent.find(({ method }) => method === "session/set_config_option")?.params,
    ).toEqual({
      sessionId: FAKE_ACP_SESSION,
      configId: "thinking",
      value: "high",
    });
    const prompt = sent.find(({ method }) => method === "session/prompt");
    expect(prompt?.params).toEqual({
      sessionId: FAKE_ACP_SESSION,
      prompt: [
        {
          type: "text",
          text: "<stella-instructions>\nUse the stella MCP server.\n</stella-instructions>",
        },
        {
          type: "text",
          text: expect.stringContaining("Current request:\nSearch both."),
        },
      ],
    });

    expect(events[0]).toEqual({
      type: "session.started",
      sessionId: harnessSessionId(FAKE_ACP_SESSION),
      continuation: { type: "fresh" },
    });
    expect(
      ofType(events, "reasoning.completed").map(({ text }) => text),
    ).toEqual(["Thinking about the leases."]);
    expect(ofType(events, "text.completed").map(({ text }) => text)).toEqual([
      "Looking now.",
      "Done.",
    ]);
    expect(
      ofType(events, "tool.started").map(({ toolCall }) => toolCall),
    ).toEqual([
      {
        id: "call-1",
        name: HARNESS_TOOL_NAMES.commandExecution,
        input: { command: "ls -la" },
      },
      {
        id: "call-2",
        name: HARNESS_TOOL_NAMES.nativeTool,
        input: {
          tool: "Read lease.md",
          detail: { kind: "read", path: "lease.md" },
        },
      },
      {
        id: "call-3",
        name: "search_across_matters",
        input: { query: "lease" },
      },
      {
        id: `${FAKE_ACP_SESSION}:plan:1`,
        name: HARNESS_TOOL_NAMES.nativeTool,
        input: {
          tool: "plan",
          detail: { kind: "plan", items: ["Read the lease", "Summarize"] },
        },
      },
    ]);
    const completed = ofType(events, "tool.completed");
    expect(completed.map(({ toolCall }) => toolCall.id)).toEqual([
      "call-1",
      "call-2",
      "call-3",
      `${FAKE_ACP_SESSION}:plan:1`,
    ]);
    expect(completed[0]?.result).toEqual({
      content: JSON.stringify({ exit_code: 0, status: "completed" }),
      status: "succeeded",
      localOutput: { type: "command", output: "a.txt\nb.txt" },
    });
    expect(completed[2]?.result).toEqual({
      content: '{"results":[]}',
      status: "succeeded",
    });
    expect(events.at(-1)).toEqual({
      type: "turn.completed",
      usage: {
        inputTokens: 120,
        cachedInputTokens: 7,
        outputTokens: 30,
        reasoningOutputTokens: 5,
        context: { usedTokens: 5000, windowTokens: 200_000 },
      },
      boundary: null,
    });
  });

  test("a file change keeps each diff as the step's output", async () => {
    const { events, workspaceDir } = await run("edit", {
      overrides: () => CONFIGURED,
    });
    const [edit] = ofType(events, "tool.completed");
    expect(edit?.toolCall).toEqual({
      id: "edit-1",
      name: HARNESS_TOOL_NAMES.fileChange,
      input: {
        changes: [
          { path: path.join(workspaceDir, "notes.md"), kind: "update" },
          { path: path.join(workspaceDir, "new.md"), kind: "add" },
        ],
      },
    });
    expect(edit?.result.localOutput).toEqual({
      type: "diff",
      files: [
        { path: path.join(workspaceDir, "notes.md"), diff: "@@\n-old\n+new" },
        { path: path.join(workspaceDir, "new.md"), diff: "+fresh" },
      ],
    });
  });

  test("a permission request goes to the member unless stella can answer it", async () => {
    const { events, received } = await run("permission", {
      overrides: ({ unreadableDir }) => ({
        policy: { network: "open", fs: "workspace", approvals: "ask" },
        unreadablePaths: [unreadableDir],
      }),
      onEvent: async (event, turn) => {
        if (event.type === "approval.requested") {
          expect(
            Result.isOk(
              await turn.respond({
                type: "approval",
                requestId: event.request.requestId,
                decision: "deny",
              }),
            ),
          ).toBe(true);
        }
      },
    });
    const [asked] = ofType(events, "approval.requested");
    expect(asked?.request).toEqual({
      requestId: "acp-permission-1",
      kind: "command",
      toolCall: {
        id: "call-rm",
        name: HARNESS_TOOL_NAMES.commandExecution,
        input: { command: "rm -rf build" },
      },
      reason: null,
      // `reject_always` is never offered.
      options: [
        { id: "allow", decision: "approve" },
        { id: "always", decision: "approve_for_session" },
        { id: "reject", decision: "deny" },
      ],
    });
    expect(ofType(events, "approval.requested")).toHaveLength(1);
    const answers = received()
      .filter(
        ({ id }) => typeof id === "string" && id.startsWith("permission-"),
      )
      .map(({ id, result }) => ({ id, result }));
    expect(answers).toEqual([
      {
        id: "permission-1",
        result: { outcome: { outcome: "selected", optionId: "reject" } },
      },
      {
        id: "permission-2",
        result: { outcome: { outcome: "selected", optionId: "allow" } },
      },
      {
        id: "permission-3",
        result: { outcome: { outcome: "selected", optionId: "reject" } },
      },
    ]);
    const declined = ofType(events, "tool.completed").find(
      ({ toolCall }) => toolCall.id === "call-rm",
    );
    expect(declined?.result).toEqual({
      content: JSON.stringify({ status: "declined" }),
      status: "failed",
    });
    expect(events.at(-1)?.type).toBe("turn.completed");
  });

  test("an interrupt cancels the session, withdraws pending requests and ends the turn interrupted", async () => {
    const { events, received } = await run("cancel", {
      onEvent: async (event, turn) => {
        if (event.type === "approval.requested") {
          await turn.interrupt();
        }
      },
    });
    const sent = received();
    expect(
      sent.find(({ method }) => method === "session/cancel")?.params,
    ).toEqual({
      sessionId: FAKE_ACP_SESSION,
    });
    expect(sent.find(({ id }) => id === "permission-1")?.result).toEqual({
      outcome: { outcome: "cancelled" },
    });
    expect(ofType(events, "interaction.resolved")).toHaveLength(1);
    const long = ofType(events, "tool.completed").find(
      ({ toolCall }) => toolCall.id === "call-long",
    );
    expect(long?.result.status).toBe("cancelled");
    expect(events.at(-1)).toEqual({ type: "turn.interrupted" });
  });

  test("a refusal is a failure, not a completed turn", async () => {
    const { events } = await run("refusal");
    expect(events.at(-1)).toEqual({
      type: "turn.failed",
      failure: {
        type: "provider_error",
        code: "refusal",
        message: "The agent refused to continue this request.",
      },
    });
  });

  test("a prompt the agent refuses for sign-in fails as auth_required with stella's own words", async () => {
    const { events } = await run("prompt_auth");
    expect(events.at(-1)).toEqual({
      type: "turn.failed",
      failure: {
        type: "auth_required",
        message: "Fake agent is not signed in.",
      },
    });
  });

  test("a session the agent refuses for sign-in does not start", async () => {
    const harness = harnessFor("start_auth");
    const started = await harness.adapter.startTurn(
      turnInput(harness.workspaceDir),
    );
    expect(Result.isError(started) && started.error.reason).toBe(
      "auth_required",
    );
  });

  test("an agent that exits mid-turn fails it and ends its open steps", async () => {
    const { events } = await run("crash");
    const crashed = ofType(events, "tool.completed").find(
      ({ toolCall }) => toolCall.id === "call-crash",
    );
    expect(crashed?.result.status).toBe("cancelled");
    expect(events.at(-1)).toMatchObject({
      type: "turn.failed",
      failure: { type: "harness_exited", exitCode: 3 },
    });
  });

  test("a resumed session gets only the new message", async () => {
    const { events, received } = await run("resume", {
      overrides: () => ({
        continuation: {
          type: "resume",
          sessionId: harnessSessionId(FAKE_ACP_RESUMED_SESSION),
        },
      }),
    });
    const sent = received();
    expect(
      sent.find(({ method }) => method === "session/resume")?.params,
    ).toMatchObject({
      sessionId: FAKE_ACP_RESUMED_SESSION,
    });
    expect(
      sent.find(({ method }) => method === "session/prompt")?.params,
    ).toMatchObject({
      sessionId: FAKE_ACP_RESUMED_SESSION,
      prompt: [{ type: "text" }, { type: "text", text: "Search both." }],
    });
    expect(events[0]).toMatchObject({ continuation: { type: "resumed" } });
  });

  test("a session the agent no longer has starts anew from the transcript", async () => {
    const { events, received } = await run("resume_missing", {
      overrides: () => ({
        continuation: {
          type: "resume",
          sessionId: harnessSessionId(FAKE_ACP_RESUMED_SESSION),
        },
      }),
    });
    expect(events[0]).toEqual({
      type: "session.started",
      sessionId: harnessSessionId(FAKE_ACP_SESSION),
      continuation: {
        type: "resume_unavailable",
        reason: "session_not_found",
        message: "Session not found",
      },
    });
    expect(
      received().find(({ method }) => method === "session/prompt")?.params,
    ).toMatchObject({
      prompt: [
        { type: "text" },
        { text: expect.stringContaining("The conversation so far:") },
      ],
    });
  });

  test("a loaded session's replayed history is not part of the turn", async () => {
    const { events } = await run("load", {
      overrides: () => ({
        continuation: {
          type: "resume",
          sessionId: harnessSessionId(FAKE_ACP_RESUMED_SESSION),
        },
      }),
    });
    const texts = ofType(events, "text.completed").map(({ text }) => text);
    expect(texts).toEqual(["Loaded."]);
    expect(texts).not.toContain(FAKE_ACP_REPLAYED_TEXT);
  });

  test("a stored sign-in is read before the session", async () => {
    const { events, received } = await run("stored_sign_in", {
      definition: { storedSignIn: STORED_SIGN_IN },
      prepare: ({ configDir }) => {
        writeFileSync(path.join(configDir, "signed-in"), "");
      },
    });
    expect(
      received().find(({ method }) => method === "authenticate")?.params,
    ).toEqual({ methodId: "fake-login" });
    expect(events.at(-1)?.type).toBe("turn.completed");
  });

  test("without a stored sign-in the turn does not start the agent", async () => {
    const harness = harnessFor("stored_sign_in", {
      storedSignIn: STORED_SIGN_IN,
    });
    const started = await harness.adapter.startTurn(
      turnInput(harness.workspaceDir),
    );
    expect(Result.isError(started) && started.error.reason).toBe(
      "auth_required",
    );
    expect(existsSync(harness.logPath)).toBe(false);
  });

  test("a stored sign-in the agent refuses probes as signed out", async () => {
    const harness = harnessFor("probe_sign_in_refused", {
      storedSignIn: STORED_SIGN_IN,
    });
    writeFileSync(path.join(harness.configDir, "signed-in"), "");
    const probed = await harness.adapter.probe();
    expect(Result.isOk(probed) && probed.value.auth).toEqual({
      type: "signed_out",
    });
  });

  test("a slow agent's probe stands until its sign-in changes", async () => {
    const harness = harnessFor("probe_stored_sign_in", {
      storedSignIn: STORED_SIGN_IN,
      probeCacheMs: 60_000,
    });
    writeFileSync(path.join(harness.configDir, "signed-in"), "");
    const first = await harness.adapter.probe();
    const second = await harness.adapter.probe();
    expect(Result.isOk(second) && second.value).toEqual(
      Result.isOk(first) && first.value,
    );
    const initializes = () =>
      harness.received().filter(({ method }) => method === "initialize");
    expect(initializes()).toHaveLength(1);
    rmSync(path.join(harness.configDir, "signed-in"));
    const signedOut = await harness.adapter.probe();
    expect(Result.isOk(signedOut) && signedOut.value.auth).toEqual({
      type: "signed_out",
    });
    expect(initializes()).toHaveLength(2);
  });

  test("an agent with a temporary directory of its own gets it removed after it exits", async () => {
    const { startup, configDir } = await run("blank_lines", {
      definition: { ownTempDir: true },
    });
    const tempDir = startup().env["TMPDIR"] ?? "";
    expect(path.dirname(tempDir)).toBe(path.join(configDir, "stella-tmp"));
    expect(existsSync(tempDir)).toBe(false);
  });

  test("a steering agent takes a message into the running turn", async () => {
    const { events, received } = await run("steer", {
      overrides: () => CONFIGURED,
      definition: { steers: (version) => version === FAKE_ACP_VERSION },
      onEvent: async (event, turn) => {
        if (event.type === "text.delta" && event.delta === "Working.") {
          expect(
            Result.isOk(
              await turn.steer({ inputId: "input-1", text: "Also check B." }),
            ),
          ).toBe(true);
        }
      },
    });
    expect(ofType(events, "input.settled")).toEqual([
      { type: "input.settled", inputId: "input-1", status: "accepted" },
    ]);
    const prompts = received().filter(
      ({ method }) => method === "session/prompt",
    );
    expect(prompts[1]?.params).toEqual({
      sessionId: FAKE_ACP_SESSION,
      prompt: [{ type: "text", text: "Also check B." }],
    });
    expect(ofType(events, "text.completed").map(({ text }) => text)).toEqual([
      "Working.",
      "Steered.",
    ]);
    // One terminal event, after the steered prompt; usage adds both.
    expect(events.filter(({ type }) => type.startsWith("turn."))).toEqual([
      {
        type: "turn.completed",
        usage: {
          inputTokens: 200,
          cachedInputTokens: 7,
          outputTokens: 40,
          reasoningOutputTokens: 5,
          context: null,
        },
        boundary: null,
      },
    ]);
  });

  test("an agent that does not steer leaves the message for the next turn", async () => {
    const { events } = await run("cancel", {
      onEvent: async (event, turn) => {
        if (event.type === "text.delta") {
          expect(
            Result.isOk(
              await turn.steer({ inputId: "input-1", text: "More." }),
            ),
          ).toBe(true);
        }
        if (event.type === "approval.requested") {
          await turn.interrupt();
        }
      },
    });
    expect(ofType(events, "input.settled")).toEqual([
      { type: "input.settled", inputId: "input-1", status: "rejected" },
    ]);
  });

  test("a session the agent can no longer continue is not resumed again", async () => {
    const broken = await run("broken", { overrides: () => CONFIGURED });
    expect(broken.events.at(-1)).toMatchObject({
      type: "turn.failed",
      failure: { type: "provider_error" },
    });
    expect(isSessionBroken(broken.configDir, FAKE_ACP_SESSION)).toBe(true);

    const { events, received } = await run("fresh", {
      prepare: ({ configDir }) => {
        markSessionBroken(configDir, FAKE_ACP_RESUMED_SESSION);
      },
      overrides: () => ({
        ...CONFIGURED,
        continuation: {
          type: "resume",
          sessionId: harnessSessionId(FAKE_ACP_RESUMED_SESSION),
        },
      }),
    });
    expect(received().some(({ method }) => method === "session/resume")).toBe(
      false,
    );
    expect(events[0]).toMatchObject({
      continuation: { type: "resume_unavailable", reason: "resume_rejected" },
    });
  });

  test("blank lines between messages are not protocol violations", async () => {
    const { events } = await run("blank_lines");
    expect(events.at(-1)?.type).toBe("turn.completed");
  });

  test("an approval mode the agent does not run in is refused before it starts", async () => {
    const harness = harnessFor("turn");
    const started = await harness.adapter.startTurn(
      turnInput(harness.workspaceDir, {
        policy: { network: "open", fs: "workspace", approvals: "full_auto" },
      }),
    );
    expect(Result.isError(started) && started.error.reason).toBe(
      "start_rejected",
    );
  });
});
