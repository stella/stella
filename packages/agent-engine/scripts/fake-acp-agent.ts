import { panic } from "better-result";
import * as v from "valibot";

import { fakeHarnessLog, openFakeHarnessPeer } from "./fake-harness-peer";

/**
 * A stand-in for an Agent Client Protocol agent that replays a handwritten
 * script over real stdio, so the ACP adapter's process, framing and protocol
 * handling run unmodified in tests without a model provider or an installed
 * agent. Every message it receives is appended to `$FAKE_HARNESS_LOG` for the
 * test to inspect.
 *
 * Usage: `bun scripts/fake-acp-agent.ts <scenario>`.
 */

export const FAKE_ACP_SESSION = "fake-acp-session-1";
export const FAKE_ACP_RESUMED_SESSION = "fake-acp-session-0";
export const FAKE_ACP_MODEL = "fake-model-pro";
export const FAKE_ACP_OTHER_MODEL = "fake-model-flash";
export const FAKE_ACP_VERSION = "1.5.0";
export const FAKE_ACP_REPLAYED_TEXT = "replayed history text";
export const FAKE_ACP_STDERR = "fake agent stderr line";

type Step =
  /** Wait for the client's next request with this method and answer it. */
  | {
      expect: string;
      result?: unknown;
      error?: { code: number; message: string };
      /** Leave it unanswered until `answer` names it. */
      hold?: string;
    }
  | {
      answer: string;
      result?: unknown;
      error?: { code: number; message: string };
    }
  | { update: Record<string, unknown>; sessionId?: string }
  /** Ask the client for permission; `wait: false` leaves it outstanding. */
  | { permission: Record<string, unknown>; wait?: false }
  | { awaitResponse: true }
  | { expectNotification: string }
  | { raw: string }
  | { stderr: string }
  | { sleep: number }
  | { exit: number };

const MessageSchema = v.object({
  jsonrpc: v.optional(v.string()),
  id: v.optional(v.union([v.string(), v.number()])),
  method: v.optional(v.string()),
  params: v.optional(v.unknown()),
  result: v.optional(v.unknown()),
  error: v.optional(v.unknown()),
});

const AGENT = {
  protocolVersion: 1,
  agentCapabilities: {
    loadSession: false,
    promptCapabilities: { image: true, audio: false, embeddedContext: true },
    mcpCapabilities: { http: true, sse: false },
    sessionCapabilities: { resume: {} },
  },
  authMethods: [{ id: "fake-login", name: "Log in" }],
  agentInfo: { name: "fake-acp", title: "Fake ACP", version: FAKE_ACP_VERSION },
};

const SESSION_STATE = {
  modes: {
    currentModeId: "default",
    availableModes: [
      { id: "default", name: "Default" },
      { id: "accept_edits", name: "Accept edits" },
    ],
  },
  models: {
    currentModelId: FAKE_ACP_MODEL,
    availableModels: [
      { modelId: FAKE_ACP_MODEL, name: "Fake Pro" },
      { modelId: FAKE_ACP_OTHER_MODEL, name: "Fake Flash" },
    ],
  },
  configOptions: [
    {
      id: "thinking",
      name: "Thinking",
      category: "thought_level",
      type: "select",
      currentValue: "medium",
      options: [
        { value: "low", name: "Low" },
        { value: "medium", name: "Medium" },
        { value: "high", name: "High" },
        { value: "turbo", name: "Not an effort stella knows" },
      ],
    },
  ],
};

const START: Step[] = [
  { expect: "initialize", result: AGENT },
  {
    expect: "session/new",
    result: { sessionId: FAKE_ACP_SESSION, ...SESSION_STATE },
  },
];

/** The mode, model and effort a turn at Auto on the other model sets. */
const CONFIGURE: Step[] = [
  { expect: "session/set_mode", result: {} },
  { expect: "session/set_model", result: {} },
  { expect: "session/set_config_option", result: {} },
];

const PERMISSION_OPTIONS = [
  { optionId: "allow", name: "Allow", kind: "allow_once" },
  { optionId: "always", name: "Always allow", kind: "allow_always" },
  { optionId: "reject", name: "Reject", kind: "reject_once" },
  { optionId: "never", name: "Never", kind: "reject_always" },
];

const endTurn = (stopReason = "end_turn"): Step => ({
  answer: "prompt",
  result: {
    stopReason,
    usage: {
      inputTokens: 120,
      outputTokens: 30,
      cachedReadTokens: 7,
      thoughtTokens: 5,
    },
  },
});

const text = (sessionUpdate: string, value: string): Step => ({
  update: { sessionUpdate, content: { type: "text", text: value } },
});

export const FAKE_ACP_SCENARIOS = {
  probe: [...START],
  probe_signed_out: [
    { expect: "initialize", result: AGENT },
    {
      expect: "session/new",
      error: { code: -32_000, message: "Authentication required" },
    },
  ],
  probe_no_http: [
    {
      expect: "initialize",
      result: {
        ...AGENT,
        agentCapabilities: { ...AGENT.agentCapabilities, mcpCapabilities: {} },
      },
    },
  ],
  turn: [
    ...START,
    { expect: "session/set_mode", result: {} },
    { expect: "session/set_model", result: {} },
    { expect: "session/set_config_option", result: {} },
    { expect: "session/prompt", hold: "prompt" },
    { stderr: FAKE_ACP_STDERR },
    text("agent_thought_chunk", "Thinking about "),
    text("agent_thought_chunk", "the leases."),
    text("agent_message_chunk", "Looking "),
    text("agent_message_chunk", "now."),
    {
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call-1",
        title: "`ls -la`",
        kind: "execute",
        status: "pending",
        rawInput: {},
      },
    },
    {
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-1",
        status: "in_progress",
        rawInput: { command: ["ls", "-la"] },
      },
    },
    // A titleless update keeps the title; an empty input keeps the input.
    {
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-1",
        rawInput: {},
        content: [
          { type: "content", content: { type: "text", text: "a.txt\nb.txt" } },
        ],
      },
    },
    {
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-1",
        status: "completed",
        rawOutput: { exitCode: 0 },
      },
    },
    // Output after the end does not reopen it.
    {
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-1",
        status: "in_progress",
      },
    },
    {
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call-2",
        title: "Read lease.md",
        kind: "read",
        status: "pending",
      },
    },
    // Only the location moves, and it still names the file.
    {
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-2",
        locations: [{ path: "lease.md" }],
      },
    },
    {
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-2",
        status: "completed",
      },
    },
    {
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call-3",
        title: "Running mcp_stella_search_across_matters",
        kind: "other",
        status: "in_progress",
        rawInput: { query: "lease" },
      },
    },
    {
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-3",
        status: "completed",
        content: [
          {
            type: "content",
            content: { type: "text", text: '{"results":[]}' },
          },
        ],
      },
    },
    {
      update: {
        sessionUpdate: "plan",
        entries: [
          { content: "Read the lease", status: "completed", priority: "high" },
          { content: "Summarize", status: "pending", priority: "medium" },
        ],
      },
    },
    {
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [],
      },
    },
    { update: { sessionUpdate: "unknown_future_update", anything: true } },
    { update: { sessionUpdate: "usage_update", used: 5000, size: 200_000 } },
    // Another session's output is not this turn's.
    {
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "elsewhere" },
      },
      sessionId: "other-session",
    },
    text("agent_message_chunk", "Done."),
    endTurn(),
    { expectNotification: "never" },
  ],
  edit: [
    ...START,
    { expect: "session/set_mode", result: {} },
    { expect: "session/set_model", result: {} },
    { expect: "session/set_config_option", result: {} },
    { expect: "session/prompt", hold: "prompt" },
    {
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "edit-1",
        title: "Edit notes.md",
        kind: "edit",
        status: "completed",
        locations: [{ path: "WORKSPACE/notes.md" }],
        content: [
          {
            type: "diff",
            path: "WORKSPACE/notes.md",
            oldText: "old\n",
            newText: "new\n",
          },
          { type: "diff", path: "WORKSPACE/new.md", newText: "fresh\n" },
          { type: "future_content", whatever: 1 },
        ],
      },
    },
    endTurn(),
    { expectNotification: "never" },
  ],
  permission: [
    ...START,
    { expect: "session/prompt", hold: "prompt" },
    {
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call-rm",
        title: "rm -rf build",
        kind: "execute",
        status: "pending",
        rawInput: { command: "rm -rf build" },
      },
    },
    {
      permission: {
        toolCall: {
          toolCallId: "call-rm",
          title: "rm -rf build",
          kind: "execute",
        },
        options: PERMISSION_OPTIONS,
      },
    },
    // Reading inside the folder never asks.
    {
      permission: {
        toolCall: {
          toolCallId: "call-read",
          title: "Read a.txt",
          kind: "read",
          locations: [{ path: "a.txt" }],
        },
        options: PERMISSION_OPTIONS,
      },
    },
    // Reading another chat's folder is refused.
    {
      permission: {
        toolCall: {
          toolCallId: "call-secret",
          title: "Read secret",
          kind: "read",
          locations: [{ path: "UNREADABLE/secret.txt" }],
        },
        options: PERMISSION_OPTIONS,
      },
    },
    {
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-rm",
        status: "failed",
      },
    },
    endTurn(),
    { expectNotification: "never" },
  ],
  cancel: [
    ...START,
    { expect: "session/prompt", hold: "prompt" },
    text("agent_message_chunk", "Starting."),
    {
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call-long",
        title: "sleep 100",
        kind: "execute",
        status: "in_progress",
      },
    },
    {
      permission: {
        toolCall: {
          toolCallId: "call-push",
          title: "git push",
          kind: "execute",
        },
        options: PERMISSION_OPTIONS,
      },
      wait: false,
    },
    { expectNotification: "session/cancel" },
    { awaitResponse: true },
    { answer: "prompt", result: { stopReason: "cancelled" } },
    { expectNotification: "never" },
  ],
  refusal: [
    ...START,
    { expect: "session/prompt", hold: "prompt" },
    text("agent_message_chunk", "I can't."),
    endTurn("refusal"),
    { expectNotification: "never" },
  ],
  prompt_auth: [
    ...START,
    {
      expect: "session/prompt",
      error: {
        code: -32_000,
        message: "Open the following link: https://example.test",
      },
    },
    { expectNotification: "never" },
  ],
  start_auth: [
    { expect: "initialize", result: AGENT },
    {
      expect: "session/new",
      error: { code: -32_000, message: "Authentication required" },
    },
  ],
  crash: [
    ...START,
    { expect: "session/prompt", hold: "prompt" },
    {
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call-crash",
        title: "make",
        kind: "execute",
        status: "in_progress",
      },
    },
    { exit: 3 },
  ],
  resume: [
    { expect: "initialize", result: AGENT },
    { expect: "session/resume", result: SESSION_STATE },
    { expect: "session/prompt", hold: "prompt" },
    text("agent_message_chunk", "Resumed."),
    endTurn(),
    { expectNotification: "never" },
  ],
  resume_missing: [
    { expect: "initialize", result: AGENT },
    {
      expect: "session/resume",
      error: { code: -32_002, message: "Session not found" },
    },
    {
      expect: "session/new",
      result: { sessionId: FAKE_ACP_SESSION, ...SESSION_STATE },
    },
    { expect: "session/prompt", hold: "prompt" },
    endTurn(),
    { expectNotification: "never" },
  ],
  load: [
    {
      expect: "initialize",
      result: {
        ...AGENT,
        agentCapabilities: {
          ...AGENT.agentCapabilities,
          loadSession: true,
          sessionCapabilities: {},
        },
      },
    },
    { expect: "session/load", hold: "load" },
    // The history replays before the load is answered.
    {
      update: {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "old question" },
      },
      sessionId: FAKE_ACP_RESUMED_SESSION,
    },
    {
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: FAKE_ACP_REPLAYED_TEXT },
      },
      sessionId: FAKE_ACP_RESUMED_SESSION,
    },
    { sleep: 50 },
    { answer: "load", result: null },
    { expect: "session/prompt", hold: "prompt" },
    {
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Loaded." },
      },
      sessionId: FAKE_ACP_RESUMED_SESSION,
    },
    endTurn(),
    { expectNotification: "never" },
  ],
  stored_sign_in: [
    { expect: "initialize", result: AGENT },
    { expect: "authenticate", result: {} },
    {
      expect: "session/new",
      result: { sessionId: FAKE_ACP_SESSION, ...SESSION_STATE },
    },
    { expect: "session/prompt", hold: "prompt" },
    text("agent_message_chunk", "Signed in."),
    endTurn(),
    { expectNotification: "never" },
  ],
  probe_stored_sign_in: [
    { expect: "initialize", result: AGENT },
    { expect: "authenticate", result: {} },
    {
      expect: "session/new",
      result: { sessionId: FAKE_ACP_SESSION, ...SESSION_STATE },
    },
  ],
  probe_sign_in_refused: [
    { expect: "initialize", result: AGENT },
    {
      expect: "authenticate",
      error: { code: -32_603, message: "No browser is available here" },
    },
  ],
  steer: [
    ...START,
    ...CONFIGURE,
    { expect: "session/prompt", hold: "prompt" },
    text("agent_message_chunk", "Working."),
    { expect: "session/prompt", hold: "steer" },
    endTurn(),
    text("agent_message_chunk", "Steered."),
    {
      answer: "steer",
      result: {
        stopReason: "end_turn",
        usage: { inputTokens: 80, outputTokens: 10 },
      },
    },
    { expectNotification: "never" },
  ],
  broken: [
    ...START,
    ...CONFIGURE,
    {
      expect: "session/prompt",
      error: {
        code: -32_603,
        message: "messages.3.content.0.thinking.signature: Field required",
      },
    },
    { expectNotification: "never" },
  ],
  fresh: [
    { expect: "initialize", result: AGENT },
    {
      expect: "session/new",
      result: { sessionId: FAKE_ACP_SESSION, ...SESSION_STATE },
    },
    ...CONFIGURE,
    { expect: "session/prompt", hold: "prompt" },
    endTurn(),
    { expectNotification: "never" },
  ],
  blank_lines: [
    { raw: "" },
    { raw: "   " },
    ...START,
    { expect: "session/prompt", hold: "prompt" },
    { raw: "" },
    text("agent_message_chunk", "Fine."),
    endTurn(),
    { expectNotification: "never" },
  ],
} as const satisfies Record<string, readonly Step[]>;

export type FakeAcpScenario = keyof typeof FAKE_ACP_SCENARIOS;

const isScenario = (name: string): name is FakeAcpScenario =>
  Object.hasOwn(FAKE_ACP_SCENARIOS, name);

const run = async (scenario: FakeAcpScenario) => {
  const log = fakeHarnessLog();
  log({ startup: { cwd: process.cwd(), env: { ...process.env } } });
  const peer = openFakeHarnessPeer({
    schema: MessageSchema,
    queueOf: (message) => {
      if (message.method !== undefined && message.id !== undefined) {
        return `request:${message.method}`;
      }
      if (message.method !== undefined) {
        return `notification:${message.method}`;
      }
      return "response";
    },
    log,
  });
  const held = new Map<string, string | number>();
  const workspace = process.env["FAKE_ACP_WORKSPACE"] ?? "";
  const unreadable = process.env["FAKE_ACP_UNREADABLE"] ?? "";
  const placed = (value: unknown): unknown =>
    JSON.parse(
      JSON.stringify(value)
        .replaceAll("WORKSPACE", () => workspace)
        .replaceAll("UNREADABLE", () => unreadable),
    );
  let permissions = 0;
  const steps: readonly Step[] = FAKE_ACP_SCENARIOS[scenario];
  for (const step of steps) {
    if ("expect" in step) {
      const message = await peer.take(`request:${step.expect}`);
      if (message === null) {
        return;
      }
      const id = message.id ?? panic("A request without an id");
      if (step.hold !== undefined) {
        held.set(step.hold, id);
        continue;
      }
      peer.write(
        step.error === undefined
          ? { jsonrpc: "2.0", id, result: step.result ?? null }
          : { jsonrpc: "2.0", id, error: step.error },
      );
    } else if ("answer" in step) {
      const id = held.get(step.answer) ?? panic("Nothing held");
      peer.write(
        step.error === undefined
          ? { jsonrpc: "2.0", id, result: step.result ?? null }
          : { jsonrpc: "2.0", id, error: step.error },
      );
    } else if ("update" in step) {
      peer.write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: step.sessionId ?? FAKE_ACP_SESSION,
          update: placed(step.update),
        },
      });
    } else if ("permission" in step) {
      permissions += 1;
      peer.write({
        jsonrpc: "2.0",
        id: `permission-${String(permissions)}`,
        method: "session/request_permission",
        params: {
          sessionId: FAKE_ACP_SESSION,
          ...v.parse(
            v.record(v.string(), v.unknown()),
            placed(step.permission),
          ),
        },
      });
      if (step.wait !== false && (await peer.take("response")) === null) {
        return;
      }
    } else if ("awaitResponse" in step) {
      if ((await peer.take("response")) === null) {
        return;
      }
    } else if ("expectNotification" in step) {
      if (
        (await peer.take(`notification:${step.expectNotification}`)) === null
      ) {
        return;
      }
    } else if ("raw" in step) {
      process.stdout.write(`${step.raw}\n`);
    } else if ("stderr" in step) {
      process.stderr.write(`${step.stderr}\n`);
    } else if ("sleep" in step) {
      await Bun.sleep(step.sleep);
    } else {
      process.exit(step.exit);
    }
  }
  await peer.reading;
};

if (import.meta.main) {
  const scenario = process.argv[2] ?? "";
  if (!isScenario(scenario)) {
    panic(`Unknown fake ACP scenario: ${scenario}`);
  }
  await run(scenario);
}
