import { appendFileSync } from "node:fs";
import * as v from "valibot";

import {
  FAKE_STELLA_ANSWER,
  FAKE_STELLA_SERVER,
  FAKE_STELLA_STEPS,
} from "./fake-stella-turn";

/**
 * A stand-in for the Claude Code CLI in stream-json mode that replays a
 * handwritten transcript over real stdio, so the adapter's process, framing
 * and protocol handling run unmodified in tests without a model provider.
 * Its startup (arguments, working directory, the environment variables the
 * adapter controls) and every message it receives are appended to
 * `$FAKE_CLAUDE_LOG` for the test to inspect.
 *
 * Usage: `bun scripts/fake-claude-code-cli.ts <scenario> [CLI arguments]`.
 */

type FakeStep =
  /** Wait for the client's next control request of this subtype; answer it. */
  | { expect: string; response?: unknown; error?: string }
  /** Wait for the client's next user message. */
  | { expectUser: true }
  | { emit: object }
  /** Send a control request and wait for the client's response. */
  | { control: object }
  /** Withdraw the last control request sent. */
  | { cancelLast: true }
  | { raw: string }
  | { sleep: number }
  | { exit: number };

/** A scenario that starts differently when the client resumes a session. */
type FakeScenario =
  | readonly FakeStep[]
  | { resume: readonly FakeStep[]; fresh: readonly FakeStep[] };

export const FAKE_CLAUDE_VERSION = "2.1.309";
export const FAKE_RESUMED_SESSION_ID = "4f1d2c3b-5a6e-4b7c-8d9e-0f1a2b3c4d5e";

const SUBSCRIPTION = {
  email: "user@example.test",
  subscriptionType: "max",
  tokenSource: "claude.ai",
  apiKeySource: "none",
  apiProvider: "firstParty",
};

const MODELS = [
  {
    value: "default",
    resolvedModel: "claude-test-1",
    displayName: "Default (recommended)",
    description: "",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high"],
  },
  {
    value: "sonnet",
    resolvedModel: "claude-test-2",
    displayName: "Sonnet",
    description: "",
  },
];

const initialize = (account: object = SUBSCRIPTION): FakeStep => ({
  expect: "initialize",
  response: {
    commands: [],
    agents: [],
    output_style: "default",
    available_output_styles: [],
    models: MODELS,
    account,
    claude_code_version: FAKE_CLAUDE_VERSION,
  },
});

const registerStella: FakeStep = {
  expect: "mcp_set_servers",
  response: { added: [FAKE_STELLA_SERVER], removed: [], errors: {} },
};

const freshTurn = (): FakeStep[] => [
  initialize(),
  registerStella,
  { expectUser: true },
  { emit: { type: "system", subtype: "init", session_id: "from-cli" } },
];

const assistant = (
  id: string,
  content: readonly object[],
  extra: object = {},
): FakeStep => ({
  emit: {
    type: "assistant",
    message: { id, role: "assistant", content, stop_reason: null },
    parent_tool_use_id: null,
    session_id: "s",
    uuid: `${id}-uuid`,
    ...extra,
  },
});

const toolUse = (id: string, name: string, input: object) => ({
  type: "tool_use",
  id,
  name,
  input,
});

const toolResult = (
  toolUseId: string,
  content: string | readonly object[],
  isError = false,
  extra: object = {},
): FakeStep => ({
  emit: {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content,
          is_error: isError,
        },
      ],
    },
    parent_tool_use_id: null,
    session_id: "s",
    ...extra,
  },
});

const result = (extra: object = {}): FakeStep => ({
  emit: {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "done",
    num_turns: 1,
    session_id: "s",
    usage: {
      input_tokens: 100,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 20,
      output_tokens: 30,
    },
    ...extra,
  },
});

const stream = (event: object): FakeStep => ({
  emit: {
    type: "stream_event",
    event,
    parent_tool_use_id: null,
    session_id: "s",
  },
});

const canUseTool = (
  toolUseId: string,
  toolName: string,
  input: object,
  extra: object = {},
): FakeStep => ({
  control: {
    subtype: "can_use_tool",
    tool_name: toolName,
    input,
    tool_use_id: toolUseId,
    ...extra,
  },
});

/** A connector tool: any MCP server other than the stella binding. */
export const FAKE_MCP_CALL = {
  id: "call-mcp",
  name: "mcp__docs__search",
  input: { query: "lease" },
};

/** The reason the CLI wrote for its terminal, with color escapes. */
export const FAKE_APPROVAL_REASON = "\u001B[33mDeletes a file\u001B[0m";

export const FAKE_PERMISSION_SUGGESTION = {
  type: "addRules",
  rules: [{ toolName: "Bash", ruleContent: "rm draft.md" }],
  behavior: "allow",
  destination: "localSettings",
};

const FAKE_SCENARIOS = {
  /**
   * The shared stella tool calls through the stella MCP binding, step by
   * step: one assistant message per call of a step (the CLI writes one per
   * completed block), then their results. Then an answer.
   */
  stella_tools: [
    ...freshTurn(),
    ...FAKE_STELLA_STEPS.flatMap((step, index) => [
      ...step.map((call) =>
        assistant(`msg-step-${String(index)}`, [
          toolUse(
            call.id,
            `mcp__${FAKE_STELLA_SERVER}__${call.tool}`,
            call.arguments,
          ),
        ]),
      ),
      ...step.map((call) =>
        toolResult(call.id, [
          { type: "text", text: JSON.stringify(call.output) },
        ]),
      ),
    ]),
    assistant("msg-answer", [{ type: "text", text: FAKE_STELLA_ANSWER }]),
    result(),
  ],
  /**
   * Built-in tools, kinds Stella drops, kinds newer than the pinned
   * protocol, a subagent's own messages, a registry name that names a
   * different chat tool, and a failed stella call.
   */
  harness_items: [
    ...freshTurn(),
    { emit: { type: "keep_alive" } },
    {
      emit: {
        type: "tool_progress",
        tool_use_id: "call-grep",
        elapsed_time_seconds: 1,
      },
    },
    { emit: { type: "system", subtype: "status", status: "requesting" } },
    assistant("msg-1", [
      toolUse("call-grep", "Bash", {
        command: "rg lease",
        description: "Search",
      }),
    ]),
    toolResult("call-grep", "notes.md: lease\n"),
    assistant("msg-2", [
      toolUse("call-edit", "Edit", {
        file_path: "/workspace/notes.md",
        old_string: "a",
        new_string: "+x",
      }),
    ]),
    toolResult("call-edit", "The file was updated."),
    assistant("msg-3", [
      toolUse("call-web", "WebSearch", { query: "civil code lease" }),
    ]),
    toolResult("call-web", "Web search results: never forwarded"),
    assistant("msg-4", [
      toolUse("call-read", "Read", { file_path: "/workspace/notes.md" }),
    ]),
    toolResult("call-read", "1→lease"),
    { emit: { type: "holographic_event", payload: "never forwarded" } },
    {
      emit: {
        type: "system",
        subtype: "quantum_banner",
        payload: "never forwarded",
      },
    },
    assistant("msg-5", [
      { type: "server_tool_use", id: "srv-1", name: "web_search", input: {} },
    ]),
    // A subagent's own work stays inside the harness.
    assistant(
      "msg-sub",
      [{ type: "text", text: "subagent text never forwarded" }],
      { parent_tool_use_id: "call-task" },
    ),
    assistant("msg-6", [
      toolUse(
        "call-read-document",
        `mcp__${FAKE_STELLA_SERVER}__read_document`,
        { id: "doc-1" },
      ),
    ]),
    toolResult("call-read-document", [
      { type: "text", text: JSON.stringify({ text: "Lease" }) },
    ]),
    assistant("msg-7", [
      toolUse("call-failed", `mcp__${FAKE_STELLA_SERVER}__search_case_law`, {
        query: "",
      }),
    ]),
    toolResult(
      "call-failed",
      [
        {
          type: "text",
          text: JSON.stringify({
            error: { code: "invalid_input", message: "Query is empty." },
          }),
        },
      ],
      true,
    ),
    result({ usage: undefined }),
  ],
  /** Streamed text, reasoning, a connector call, a command, an answer. */
  tool_calls: [
    ...freshTurn(),
    stream({ type: "message_start", message: { id: "msg-1" } }),
    stream({
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "" },
    }),
    stream({
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "Searching" },
    }),
    assistant("msg-1", [
      { type: "thinking", thinking: "Searching the matter.", signature: "sig" },
    ]),
    assistant("msg-1", [
      toolUse(FAKE_MCP_CALL.id, FAKE_MCP_CALL.name, FAKE_MCP_CALL.input),
    ]),
    toolResult(FAKE_MCP_CALL.id, [{ type: "text", text: "2 results" }]),
    assistant("msg-2", [toolUse("call-cmd", "Bash", { command: "ls" })]),
    toolResult("call-cmd", "notes.md\n"),
    stream({ type: "message_start", message: { id: "msg-3" } }),
    stream({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    stream({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Found" },
    }),
    stream({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: " two" },
    }),
    assistant("msg-3", [{ type: "text", text: "Found two leases." }]),
    stream({ type: "content_block_stop", index: 0 }),
    stream({ type: "message_stop" }),
    result(),
  ],
  approvals: [
    ...freshTurn(),
    assistant("msg-1", [
      toolUse("call-rm", "Bash", { command: "rm draft.md" }),
    ]),
    canUseTool(
      "call-rm",
      "Bash",
      { command: "rm draft.md" },
      {
        decision_reason: FAKE_APPROVAL_REASON,
        permission_suggestions: [FAKE_PERMISSION_SUGGESTION],
      },
    ),
    toolResult("call-rm", "The user denied this action.", true),
    assistant("msg-2", [
      toolUse("call-out", "Write", {
        file_path: "/elsewhere/out.md",
        content: "x",
      }),
    ]),
    canUseTool(
      "call-out",
      "Write",
      { file_path: "/elsewhere/out.md", content: "x" },
      {
        permission_suggestions: [FAKE_PERMISSION_SUGGESTION],
      },
    ),
    toolResult("call-out", "File created."),
    assistant("msg-3", [{ type: "text", text: "Left the draft in place." }]),
    result(),
  ],
  /** An approval without suggested rules offers no session-wide decision. */
  one_off_approval: [
    ...freshTurn(),
    // The prompt arrives before the call's own message.
    canUseTool("call-docs", FAKE_MCP_CALL.name, FAKE_MCP_CALL.input),
    toolResult("call-docs", "2 results"),
    result(),
  ],
  question: [
    ...freshTurn(),
    assistant("msg-1", [
      toolUse("ask-1", "AskUserQuestion", {
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
      }),
    ]),
    canUseTool("ask-1", "AskUserQuestion", {
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
    }),
    toolResult("ask-1", "User answered: Czech"),
    assistant("msg-2", [{ type: "text", text: "Using Czech law." }]),
    result(),
  ],
  /** The CLI withdraws a prompt it no longer needs answered. */
  withdrawn_prompt: [
    ...freshTurn(),
    assistant("msg-1", [
      toolUse("call-rm", "Bash", { command: "rm draft.md" }),
    ]),
    {
      emit: {
        type: "control_request",
        request_id: "cli-withdrawn",
        request: {
          subtype: "can_use_tool",
          tool_name: "Bash",
          input: { command: "rm draft.md" },
          tool_use_id: "call-rm",
        },
      },
    },
    { sleep: 50 },
    { cancelLast: true },
    { sleep: 50 },
    result(),
  ],
  interrupt: [
    ...freshTurn(),
    assistant("msg-1", [
      toolUse("call-long", "Bash", { command: "sleep 100" }),
    ]),
    { expect: "interrupt", response: {} },
    result({
      subtype: "error_during_execution",
      is_error: true,
      errors: ["Request was aborted."],
    }),
  ],
  resume_missing: {
    resume: [
      {
        emit: {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          num_turns: 0,
          session_id: FAKE_RESUMED_SESSION_ID,
          errors: [
            `No conversation found with session ID: ${FAKE_RESUMED_SESSION_ID}`,
          ],
        },
      },
      { exit: 1 },
    ],
    fresh: [...freshTurn(), result()],
  },
  resume_ok: [...freshTurn(), result()],
  signed_out: [initialize({ tokenSource: "none", apiProvider: "firstParty" })],
  /** A key from a Console sign-in would bill the API, not the plan. */
  api_key: [
    initialize({ tokenSource: "none", apiKeySource: "/login managed key" }),
  ],
  auth_expired: [
    ...freshTurn(),
    assistant(
      "msg-err",
      [{ type: "text", text: "Not logged in · Please run /login" }],
      { error: "authentication_failed" },
    ),
    result({ is_error: true, result: "Not logged in · Please run /login" }),
  ],
  usage_limit: [
    ...freshTurn(),
    {
      emit: {
        type: "system",
        subtype: "api_retry",
        attempt: 1,
        max_retries: 10,
        retry_delay_ms: 500,
        error_status: 529,
        error: "overloaded",
      },
    },
    {
      emit: {
        type: "rate_limit_event",
        rate_limit_info: {
          status: "rejected",
          resetsAt: 1_793_196_000,
          rateLimitType: "five_hour",
        },
      },
    },
    {
      emit: {
        type: "rate_limit_event",
        rate_limit_info: {
          status: "rejected",
          resetsAt: 1_793_900_000,
          rateLimitType: "seven_day_opus",
        },
      },
    },
    assistant("msg-err", [{ type: "text", text: "You've hit your limit" }], {
      error: "rate_limit",
    }),
    result({ is_error: true, result: "You've hit your limit · resets 2pm" }),
  ],
  mcp_unreachable: [
    initialize(),
    {
      expect: "mcp_set_servers",
      response: {
        added: [FAKE_STELLA_SERVER],
        removed: [],
        errors: { [FAKE_STELLA_SERVER]: "ECONNREFUSED" },
      },
    },
  ],
  malformed: [...freshTurn(), { raw: "{this is not json" }, { sleep: 5000 }],
  crash: [
    ...freshTurn(),
    assistant("msg-1", [toolUse("call-x", "Bash", { command: "ls" })]),
    { exit: 3 },
  ],
  /** Requests stella never enables are answered at once, not left pending. */
  unanswerable_requests: [
    ...freshTurn(),
    { control: { subtype: "future_request" } },
    { control: { subtype: "hook_callback", callback_id: "h-1", input: {} } },
    { control: { subtype: "mcp_message", server_name: "x", message: {} } },
    {
      control: {
        subtype: "elicitation",
        mcp_server_name: FAKE_STELLA_SERVER,
        message: "Open this",
        mode: "url",
        url: "https://example.test",
      },
    },
    result(),
  ],
  probe: [
    initialize(),
    {
      expect: "get_usage",
      response: {
        session: {},
        subscription_type: "max",
        rate_limits_available: true,
        rate_limits: {
          five_hour: {
            utilization: 100,
            resets_at: "2026-10-28T14:00:00+00:00",
          },
          seven_day: {
            utilization: 40,
            resets_at: "2026-11-02T10:00:00+00:00",
          },
          seven_day_opus: {
            utilization: 100,
            resets_at: "2026-11-04T10:00:00+00:00",
          },
        },
      },
    },
  ],
  probe_available: [
    initialize(),
    {
      expect: "get_usage",
      response: {
        session: {},
        subscription_type: "max",
        rate_limits_available: true,
        rate_limits: {
          five_hour: {
            utilization: 12,
            resets_at: "2026-10-28T14:00:00+00:00",
          },
          seven_day: null,
        },
      },
    },
  ],
  probe_signed_out: [
    initialize({ tokenSource: "none", apiProvider: "firstParty" }),
  ],
} as const satisfies Record<string, FakeScenario>;

export type FakeScenarioName = keyof typeof FAKE_SCENARIOS;

const isScenario = (name: string): name is FakeScenarioName =>
  Object.hasOwn(FAKE_SCENARIOS, name);

const stepsFor = (
  scenario: FakeScenario,
  args: readonly string[],
): readonly FakeStep[] => {
  if (!("resume" in scenario)) {
    return scenario;
  }
  return args.includes("--resume") ? scenario.resume : scenario.fresh;
};

const IncomingSchema = v.looseObject({
  type: v.string(),
  request_id: v.optional(v.string()),
  request: v.optional(v.looseObject({ subtype: v.string() })),
  response: v.optional(v.looseObject({ request_id: v.optional(v.string()) })),
});
type Incoming = v.InferOutput<typeof IncomingSchema>;

/** Environment variables the adapter sets or must drop, as the CLI saw them. */
const OBSERVED_ENV =
  /^(?:ANTHROPIC_|CLAUDE|AWS_BEARER_TOKEN_BEDROCK$|DISABLE_AUTOUPDATER$|ENABLE_CLAUDEAI_MCP_SERVERS$|FAKE_KEEP$)/u;

const run = async (
  steps: readonly FakeStep[],
  log: (entry: object) => void,
) => {
  const requests: Incoming[] = [];
  const responses: Incoming[] = [];
  const users: Incoming[] = [];
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
        if (message.type === "control_request") {
          requests.push(message);
        } else if (message.type === "control_response") {
          responses.push(message);
        } else if (message.type === "user") {
          users.push(message);
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

  let cliRequestId = 0;
  for (const step of steps) {
    if ("expect" in step) {
      const message = await take(requests);
      if (message === null) {
        return;
      }
      if (message.request?.subtype !== step.expect) {
        log({ unexpected: message.request?.subtype, wanted: step.expect });
        process.exit(97);
      }
      write({
        type: "control_response",
        response:
          step.error === undefined
            ? {
                subtype: "success",
                request_id: message.request_id,
                response: step.response ?? {},
              }
            : {
                subtype: "error",
                request_id: message.request_id,
                error: step.error,
              },
      });
    } else if ("expectUser" in step) {
      if ((await take(users)) === null) {
        return;
      }
    } else if ("emit" in step) {
      write(step.emit);
    } else if ("control" in step) {
      cliRequestId += 1;
      write({
        type: "control_request",
        request_id: `cli-${String(cliRequestId)}`,
        request: step.control,
      });
      if ((await take(responses)) === null) {
        return;
      }
    } else if ("cancelLast" in step) {
      write({ type: "control_cancel_request", request_id: "cli-withdrawn" });
    } else if ("raw" in step) {
      process.stdout.write(`${step.raw}\n`);
    } else if ("sleep" in step) {
      await Bun.sleep(step.sleep);
    } else {
      process.exit(step.exit);
    }
  }
  // The CLI exits once its client closes stdin.
  await reading;
};

if (import.meta.main) {
  const scenario = process.argv[2] ?? "";
  const args = process.argv.slice(3);
  const logPath = process.env["FAKE_CLAUDE_LOG"] ?? "";
  const log = (entry: object) => {
    appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
  };
  log({
    startup: {
      args,
      cwd: process.cwd(),
      env: Object.fromEntries(
        Object.entries(process.env).filter(([name]) => OBSERVED_ENV.test(name)),
      ),
    },
  });
  if (!isScenario(scenario)) {
    log({ unknownScenario: scenario });
    process.exit(98);
  }
  await run(stepsFor(FAKE_SCENARIOS[scenario], args), log);
  process.exit(0);
}
