import { panic } from "better-result";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import { PACKAGE_CACHE_FOLDERS } from "../src/harness/package-cache";
import { fakeHarnessLog, openFakeHarnessPeer } from "./fake-harness-peer";
import {
  FAKE_STELLA_ANSWER,
  FAKE_STELLA_SERVER,
  FAKE_STELLA_STEPS,
  type FakeStellaCall,
} from "./fake-stella-turn";

/**
 * A stand-in for `codex app-server` that replays a handwritten transcript
 * over real stdio, so the adapter's process, framing and protocol handling
 * run unmodified in tests without a model provider. Every message it
 * receives is appended to `$FAKE_HARNESS_LOG` for the test to inspect, and a
 * `turn/start` whose input the real server or its model would refuse ends it
 * with code 96.
 *
 * Usage: `bun scripts/fake-codex-app-server.ts <scenario>`.
 */

type FakeStep =
  /** Wait for the client's next request with this method and answer it. */
  | {
      expect: string;
      result?: unknown;
      error?: { code: number; message: string };
    }
  | { notify: string; params: unknown }
  /**
   * Send a server request and wait for the client's response; `wait: false`
   * leaves it outstanding for a later `awaitResponse`.
   */
  | { request: string; params: unknown; id?: string | number; wait?: false }
  | { awaitResponse: true }
  /** Survive SIGTERM, as a server that ignores it would. */
  | { ignoreTerm: true }
  /**
   * Start a long-lived process, as an agent's command does, and log its pid.
   * `in: "own_group"` starts it in a process group of its own, as Codex runs
   * commands; `in: "orphan"` starts it in the background of a shell that
   * exits at once, as `command &` does.
   */
  | { spawn: readonly string[]; in?: "own_group" | "orphan" }
  | { raw: string }
  | { sleep: number }
  | { exit: number };

const userAgent = (version: string) =>
  `stella/${version} (Mac OS 27.0; arm64) test`;
/** A version older than the bundled compatibility policy supports. */
export const FAKE_OUTDATED_VERSION = "0.150.0";
export const FAKE_THREAD_ID = "thread-a";
export const FAKE_RESUMED_THREAD_ID = "thread-old";
const FAKE_TURN_ID = "turn-1";

const signedIn = {
  account: { type: "chatgpt", email: null, planType: "plus" },
  requiresOpenaiAuth: false,
};

const handshake = (
  account: unknown = signedIn,
  version = "0.166.0",
): FakeStep[] => [
  {
    expect: "initialize",
    result: {
      userAgent: userAgent(version),
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

/** Text a native step carries that chat must never show. */
export const FAKE_PRIVATE_TEXT = {
  heredoc: "Tenant owes 4,200 in arrears.",
  diff: "-Rent is due monthly.\n+Rent is due quarterly.",
  explanation: "Working through the private plan",
} as const;

/** A command longer than chat shows. */
export const FAKE_LONG_COMMAND = `echo ${"y".repeat(400)}`;

/** A connector tool: any MCP server other than the stella binding. */
export const FAKE_MCP_CALL = {
  type: "mcpToolCall",
  id: "call-mcp",
  server: "docs",
  tool: "search",
  arguments: { query: "lease" },
};

/**
 * A stella tool call as Codex reports it: the tool's validated output as
 * `structuredContent`, and its JSON as the one text block
 * (`serializeToolResult`).
 */
const stellaCall = (call: FakeStellaCall, phase: "started" | "completed") => ({
  type: "mcpToolCall",
  id: call.id,
  server: FAKE_STELLA_SERVER,
  tool: call.tool,
  arguments: call.arguments,
  status: phase === "started" ? "inProgress" : "completed",
  result:
    phase === "started"
      ? null
      : {
          content: [{ type: "text", text: JSON.stringify(call.output) }],
          structuredContent: call.output,
        },
  error: null,
});

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

/** The selected model was at capacity: the turn ends and may continue. */
const OVERLOADED = {
  message: "Selected model is at capacity. Please try a different model.",
  codexErrorInfo: "serverOverloaded",
  additionalDetails: null,
};
const CONTINUED_TURN_ID = "turn-2";

const continuedTurn = (status: string, error: unknown = null) => ({
  id: CONTINUED_TURN_ID,
  items: [],
  status,
  error,
  startedAt: 2,
});

/** A continuation: `turn/start` on the same thread, then its outcome. */
const continuation = (outcome: FakeStep[]): FakeStep[] => [
  { expect: "turn/start", result: { turn: continuedTurn("inProgress") } },
  ...outcome,
];

/** A command the harness asks to run, declined, then the turn's answer. */
const commandApproval = (reason: string | null): FakeStep[] => [
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
      reason,
      command: "rm draft.md",
    },
  },
  item("completed", {
    ...command("call-rm", "declined"),
    command: "rm draft.md",
  }),
  item("completed", agentMessage("m-2", "Left it in place.")),
  completed(),
];

/** The context window the fake reports, as Codex does with its token usage. */
export const FAKE_CONTEXT_WINDOW = 258_400;

/** One request's counts as Codex reports them, totals included. */
const usageBreakdown = (counts: {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}) => ({
  ...counts,
  totalTokens: counts.inputTokens + counts.outputTokens,
  cacheWriteInputTokens: 0,
});

const tokenUsage = (usage: {
  last: object;
  total: object;
  modelContextWindow: number | null;
}): FakeStep => ({
  notify: "thread/tokenUsage/updated",
  params: { threadId: FAKE_THREAD_ID, turnId: FAKE_TURN_ID, tokenUsage: usage },
});

const FAKE_SKILL_PATH = process.env["FAKE_SKILL_PATH"] ?? "/skills/none";

const FAKE_SCENARIOS = {
  /**
   * The shared stella tool calls through the stella MCP binding, step by
   * step: a step's calls all start, then complete. Then an answer.
   */
  stella_tools: [
    ...freshTurn(),
    ...FAKE_STELLA_STEPS.flatMap((step) => [
      ...step.map((call) => item("started", stellaCall(call, "started"))),
      ...step.map((call) => item("completed", stellaCall(call, "completed"))),
    ]),
    item("completed", agentMessage("m-stella", FAKE_STELLA_ANSWER)),
    completed(),
  ],
  /**
   * Harness-native items, kinds Stella drops, a kind newer than the pinned
   * protocol, a registry name that names a different chat tool, and a failed
   * stella call.
   */
  harness_items: [
    ...freshTurn(),
    item("completed", { type: "plan", id: "plan-1", text: "1. Search" }),
    item(
      "completed",
      command("call-grep", "completed", {
        command: "rg lease",
        aggregatedOutput: "notes.md: lease\n",
        exitCode: 0,
      }),
    ),
    item("completed", {
      type: "fileChange",
      id: "call-edit",
      changes: [{ path: "notes.md", kind: { type: "update" }, diff: "+x" }],
      status: "completed",
    }),
    item("completed", {
      type: "webSearch",
      id: "call-web",
      query: "civil code lease",
      action: null,
    }),
    item("completed", { type: "contextCompaction", id: "compact-1" }),
    item("completed", {
      type: "holographicCall",
      id: "future-1",
      payload: "never forwarded",
    }),
    item("completed", {
      type: "mcpToolCall",
      id: "call-read-document",
      server: FAKE_STELLA_SERVER,
      tool: "read_document",
      arguments: { id: "doc-1" },
      status: "completed",
      result: {
        content: [{ type: "text", text: JSON.stringify({ text: "Lease" }) }],
        structuredContent: { text: "Lease" },
      },
      error: null,
    }),
    item("completed", {
      type: "mcpToolCall",
      id: "call-failed",
      server: FAKE_STELLA_SERVER,
      tool: "search_case_law",
      arguments: { query: "" },
      status: "failed",
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: { code: "invalid_input", message: "Query is empty." },
            }),
          },
        ],
      },
      error: null,
    }),
    completed(),
  ],
  /**
   * Native steps chat names beyond their kind, as the app server reports
   * them: the fields stella shows sit next to text it must never forward.
   */
  native_tools: [
    ...freshTurn(),
    {
      notify: "turn/plan/updated",
      params: {
        threadId: FAKE_THREAD_ID,
        turnId: FAKE_TURN_ID,
        explanation: FAKE_PRIVATE_TEXT.explanation,
        plan: [
          { step: "Read the lease", status: "completed" },
          { step: "Draft the notice", status: "inProgress" },
        ],
      },
    },
    item(
      "completed",
      command("call-heredoc", "failed", {
        command: `/bin/zsh -lc "cat > notes.md <<'EOF'\n${FAKE_PRIVATE_TEXT.heredoc}\nEOF"`,
        aggregatedOutput: "zsh: permission denied",
        exitCode: 1,
      }),
    ),
    item(
      "completed",
      command("call-long", "completed", {
        command: FAKE_LONG_COMMAND,
        aggregatedOutput: "ok",
        exitCode: 0,
      }),
    ),
    item("completed", {
      type: "fileChange",
      id: "call-edit",
      changes: [
        {
          path: "/workspace/drafts/lease.md",
          kind: { type: "update", move_path: null },
          diff: FAKE_PRIVATE_TEXT.diff,
        },
        {
          path: "/workspace/drafts/notice.md",
          kind: { type: "add" },
          diff: FAKE_PRIVATE_TEXT.diff,
        },
      ],
      status: "completed",
    }),
    {
      notify: "turn/plan/updated",
      params: {
        threadId: FAKE_THREAD_ID,
        turnId: FAKE_TURN_ID,
        explanation: null,
        plan: [
          { step: "Read the lease", status: "completed" },
          { step: "Draft the notice", status: "completed" },
        ],
      },
    },
    // Another turn's plan is not this turn's step.
    {
      notify: "turn/plan/updated",
      params: {
        threadId: FAKE_THREAD_ID,
        turnId: "turn-other",
        plan: [{ step: "Elsewhere", status: "pending" }],
      },
    },
    completed(),
  ],
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
    // The turn's first model request; the answer below is its second.
    tokenUsage({
      last: usageBreakdown({
        inputTokens: 50,
        cachedInputTokens: 0,
        outputTokens: 10,
        reasoningOutputTokens: 0,
      }),
      total: usageBreakdown({
        inputTokens: 50,
        cachedInputTokens: 0,
        outputTokens: 10,
        reasoningOutputTokens: 0,
      }),
      modelContextWindow: FAKE_CONTEXT_WINDOW,
    }),
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
    tokenUsage({
      last: usageBreakdown({
        inputTokens: 120,
        cachedInputTokens: 20,
        outputTokens: 30,
        reasoningOutputTokens: 5,
      }),
      total: usageBreakdown({
        inputTokens: 170,
        cachedInputTokens: 20,
        outputTokens: 40,
        reasoningOutputTokens: 5,
      }),
      modelContextWindow: FAKE_CONTEXT_WINDOW,
    }),
    completed(),
  ],
  approval: commandApproval("Deletes a file"),
  /** A harness that gives no reason, here as an empty one. */
  approval_without_reason: commandApproval(""),
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
  /**
   * Two questions outstanding at once under the ids `7` and `"7"`; the first
   * asks for a secret.
   */
  twin_id_questions: [
    ...freshTurn(),
    {
      request: "item/tool/requestUserInput",
      id: 7,
      wait: false,
      params: {
        threadId: FAKE_THREAD_ID,
        turnId: FAKE_TURN_ID,
        itemId: "ask-token",
        isBlocking: true,
        autoResolutionMs: null,
        questions: [
          {
            id: "token",
            header: "Access token",
            question: "Paste the registry access token.",
            isOther: false,
            isSecret: true,
            options: null,
          },
        ],
      },
    },
    {
      request: "item/tool/requestUserInput",
      id: "7",
      params: {
        threadId: FAKE_THREAD_ID,
        turnId: FAKE_TURN_ID,
        itemId: "ask-law",
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
    { awaitResponse: true },
    item("completed", agentMessage("m-3", "Both answers received.")),
    completed(),
  ],
  /** Never answers and outlives SIGTERM; says when it is ready to. */
  unresponsive: [
    { ignoreTerm: true },
    { notify: "fake/ready", params: {} },
    { sleep: 60_000 },
  ],
  /**
   * Leaves processes running the ways an agent's commands do, says when they
   * are up, and waits for its client.
   */
  leaves_processes: [
    { spawn: ["/bin/sleep", "600"] },
    { spawn: ["/bin/sleep", "600"], in: "own_group" },
    { spawn: ["/bin/sleep", "600"], in: "orphan" },
    // Signals a process ignores stay ignored across exec.
    { spawn: ["/bin/sh", "-c", "trap '' TERM; exec /bin/sleep 600"] },
    { notify: "fake/ready", params: {} },
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
  /** A read and a command on the skill folder `FAKE_SKILL_PATH` names. */
  reads_skill: [
    ...freshTurn(),
    item("started", {
      ...command("call-read", "inProgress"),
      command: `cat ${FAKE_SKILL_PATH}/SKILL.md`,
    }),
    item("completed", {
      ...command("call-read", "completed", {
        aggregatedOutput: "Licensed commentary.\n",
        exitCode: 0,
      }),
      command: `cat ${FAKE_SKILL_PATH}/SKILL.md`,
    }),
    item("started", command("call-cmd", "inProgress")),
    item(
      "completed",
      command("call-cmd", "completed", {
        aggregatedOutput: "notes.md\n",
        exitCode: 0,
      }),
    ),
    completed(),
  ],
  skills_refused: [
    ...handshake(),
    {
      expect: "skills/list",
      error: { code: -32_600, message: "skills are unavailable" },
    },
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
  /** Signed in, at a version the bundled policy refuses. */
  outdated: [
    ...handshake(signedIn, FAKE_OUTDATED_VERSION),
    { expect: "model/list", result: { data: [], nextCursor: null } },
  ],
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
  /** A message completes, then the model is at capacity before the next. */
  capacity_retry: [
    ...freshTurn(),
    {
      notify: "item/agentMessage/delta",
      params: {
        threadId: FAKE_THREAD_ID,
        turnId: FAKE_TURN_ID,
        itemId: "m-1",
        delta: "Reading.",
      },
    },
    {
      notify: "item/completed",
      params: {
        threadId: FAKE_THREAD_ID,
        turnId: FAKE_TURN_ID,
        item: agentMessage("m-1", "Reading."),
      },
    },
    completed("failed", OVERLOADED),
    ...continuation([
      {
        notify: "item/completed",
        params: {
          threadId: FAKE_THREAD_ID,
          turnId: CONTINUED_TURN_ID,
          item: agentMessage("m-r", "Recovered."),
        },
      },
      {
        notify: "turn/completed",
        params: { threadId: FAKE_THREAD_ID, turn: continuedTurn("completed") },
      },
    ]),
  ],
  capacity_exhausted: [
    ...freshTurn(),
    completed("failed", OVERLOADED),
    ...Array.from({ length: 5 }, () =>
      continuation([
        {
          notify: "turn/completed",
          params: {
            threadId: FAKE_THREAD_ID,
            turn: continuedTurn("failed", OVERLOADED),
          },
        },
      ]),
    ).flat(),
  ],
  /** The model is at capacity while a message is still streaming. */
  capacity_mid_message: [
    ...freshTurn(),
    {
      notify: "item/agentMessage/delta",
      params: {
        threadId: FAKE_THREAD_ID,
        turnId: FAKE_TURN_ID,
        itemId: "m-1",
        delta: "Readi",
      },
    },
    completed("failed", OVERLOADED),
  ],
  malformed: [...freshTurn(), { raw: "{this is not json" }, { sleep: 5000 }],
  /** One blocking question asking two questions under one id. */
  question_twice_named: [
    ...freshTurn(),
    {
      request: "item/tool/requestUserInput",
      params: {
        threadId: FAKE_THREAD_ID,
        turnId: FAKE_TURN_ID,
        itemId: "ask-twice",
        isBlocking: true,
        autoResolutionMs: null,
        questions: ["Czech", "Slovak"].map((law) => ({
          id: "law",
          header: "Governing law",
          question: `Does ${law} law govern the lease?`,
          isOther: true,
          isSecret: false,
          options: null,
        })),
      },
    },
    { sleep: 5000 },
  ],
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
              { reasoningEffort: "high", description: "" },
              { reasoningEffort: "medium", description: "" },
              { reasoningEffort: "turbo", description: "" },
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

/** A text-only model, beside `gpt-test`, which reads images too. */
export const FAKE_TEXT_ONLY_MODEL = "gpt-text";

/** What `model/list` answers when a scenario does not script it. */
const TURN_MODELS = {
  data: [
    ["gpt-test", ["text", "image"]],
    [FAKE_TEXT_ONLY_MODEL, ["text"]],
  ].map(([id, inputModalities]) => ({
    id,
    model: id,
    displayName: id,
    description: "",
    hidden: false,
    isDefault: id === "gpt-test",
    supportedReasoningEfforts: [],
    defaultReasoningEffort: "medium",
    inputModalities,
  })),
  nextCursor: null,
};

export type FakeScenario = keyof typeof FAKE_SCENARIOS;

const isScenario = (name: string): name is FakeScenario =>
  Object.hasOwn(FAKE_SCENARIOS, name);

const IncomingSchema = v.looseObject({
  id: v.optional(v.union([v.string(), v.number()])),
  method: v.optional(v.string()),
});

/**
 * `turn/start` as the app-server's `TurnStartParams` and `UserInput` define
 * them. An image is a data URL in a format the models read.
 */
const TurnStartParamsSchema = v.looseObject({
  threadId: v.string(),
  input: v.array(
    v.variant("type", [
      v.strictObject({
        type: v.literal("text"),
        text: v.string(),
        text_elements: v.optional(v.array(v.unknown())),
      }),
      v.strictObject({
        type: v.literal("image"),
        url: v.pipe(
          v.string(),
          v.regex(
            /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/u,
          ),
        ),
      }),
      v.strictObject({ type: v.literal("localImage"), path: v.string() }),
    ]),
  ),
});

/** Start `argv` the way `placement` says; its pid. */
const spawnLongLived = async (
  argv: readonly string[],
  placement: "own_group" | "orphan" | undefined,
) => {
  const quiet = {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  } as const;
  switch (placement) {
    case undefined:
      return Bun.spawn([...argv], quiet).pid;
    case "own_group":
      return Bun.spawn(
        ["perl", "-e", "setpgrp(0, 0); exec @ARGV", ...argv],
        quiet,
      ).pid;
    case "orphan": {
      const shell = Bun.spawn(
        [
          "/bin/sh",
          "-c",
          '"$@" </dev/null >/dev/null 2>&1 & echo "$!"',
          "orphan",
          ...argv,
        ],
        { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
      );
      const pid = Number((await new Response(shell.stdout).text()).trim());
      await shell.exited;
      return pid;
    }
    default:
      placement satisfies never;
      return panic("Unknown spawn placement");
  }
};

const SkillsParamsSchema = v.looseObject({
  extraRoots: v.optional(v.array(v.string())),
  cwds: v.optional(v.array(v.string())),
});

/** Every `SKILL.md` under a root, however deep and through any link. */
const skillFilesUnder = (root: string, depth = 0): string[] =>
  // A link to a file is followed like Codex follows it, but holds no folder.
  depth > 8 || !existsSync(root) || !statSync(root).isDirectory()
    ? []
    : readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
        const entryPath = path.join(root, entry.name);
        if (entry.name === "SKILL.md") {
          return [entryPath];
        }
        return entry.isDirectory() || entry.isSymbolicLink()
          ? skillFilesUnder(entryPath, depth + 1)
          : [];
      });

const FAKE_SYSTEM_SKILL = "/fake-home/skills/.system/imagegen/SKILL.md";

/**
 * Skill discovery as Codex does it, on the real filesystem: its own skills, the
 * roots this process was given, the member's own `~/.agents/skills`, and
 * whatever the working directory holds in its `.agents/skills`.
 */
const skillDiscovery = () => {
  const roots: string[] = [];
  const home = process.env["HOME"];
  return {
    answer: (method: string | undefined, params: unknown): object | null => {
      const parsed = v.parse(SkillsParamsSchema, params ?? {});
      if (method === "skills/extraRoots/set") {
        roots.splice(0, roots.length, ...(parsed.extraRoots ?? []));
        return {};
      }
      if (method !== "skills/list") {
        return null;
      }
      const user = [
        ...roots,
        ...(home === undefined ? [] : [path.join(home, ".agents", "skills")]),
      ].flatMap((root) => skillFilesUnder(root));
      return {
        data: (parsed.cwds ?? []).map((cwd) => ({
          cwd,
          errors: [],
          skills: [
            { path: FAKE_SYSTEM_SKILL, scope: "system" },
            ...user.map((file) => ({ path: file, scope: "user" })),
            ...skillFilesUnder(path.join(cwd, ".agents", "skills")).map(
              (file) => ({ path: file, scope: "repo" }),
            ),
          ],
        })),
      };
    },
  };
};

const run = async (
  steps: readonly FakeStep[],
  log: (entry: object) => void,
) => {
  const { reading, take, write } = openFakeHarnessPeer({
    schema: IncomingSchema,
    queueOf: (message) => {
      if (message.method === undefined) {
        return "responses";
      }
      // A notification from the client needs no answer.
      return message.id === undefined ? null : "requests";
    },
    log,
  });

  const skills = skillDiscovery();
  /** Model listing and skill discovery answer whenever they are asked. */
  const unscriptedAnswer = (method: string | undefined, params: unknown) =>
    method === "model/list" ? TURN_MODELS : skills.answer(method, params);
  /** The next request a step scripts; skill discovery answers the rest. */
  const nextRequest = async (expected: string) => {
    for (;;) {
      // await-in-loop: one request at a time, in the order they arrived.
      const message = await take("requests");
      const answer =
        message === null || message.method === expected
          ? null
          : unscriptedAnswer(message.method, message["params"]);
      if (answer === null) {
        return message;
      }
      write({ id: message?.id, result: answer });
    }
  };
  let serverRequestId = 1000;
  for (const step of steps) {
    if ("expect" in step) {
      const message = await nextRequest(step.expect);
      if (message === null) {
        return;
      }
      if (message.method !== step.expect) {
        log({ unexpected: message.method, wanted: step.expect });
        process.exit(97);
      }
      if (
        message.method === "turn/start" &&
        !v.is(TurnStartParamsSchema, message["params"])
      ) {
        log({ refusedInput: "turn/start" });
        process.exit(96);
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
      write({
        id: step.id ?? serverRequestId,
        method: step.request,
        params: step.params,
      });
      if (step.wait !== false && (await take("responses")) === null) {
        return;
      }
    } else if ("awaitResponse" in step) {
      if ((await take("responses")) === null) {
        return;
      }
    } else if ("ignoreTerm" in step) {
      process.on("SIGTERM", () => {
        log({ ignored: "SIGTERM" });
      });
    } else if ("spawn" in step) {
      log({ spawned: await spawnLongLived(step.spawn, step.in) });
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
  const log = fakeHarnessLog();
  log({
    startup: {
      codexHome: process.env["CODEX_HOME"],
      cwd: process.cwd(),
      pid: process.pid,
      /** What follows the scenario: the launch's own arguments. */
      args: process.argv.slice(3),
      path: process.env["PATH"],
      /** Where the turn points package managers' caches. */
      packageCache: Object.fromEntries(
        Object.entries(process.env).filter(([name]) =>
          Object.hasOwn(PACKAGE_CACHE_FOLDERS, name),
        ),
      ),
      /** The variables a launch may set or remove. */
      launchEnvironment: Object.fromEntries(
        Object.entries(process.env).filter(
          ([name]) => name.startsWith("STELLA_") || name === "OPENAI_API_KEY",
        ),
      ),
    },
  });
  if (!isScenario(scenario)) {
    log({ unknownScenario: scenario });
    process.exit(98);
  }
  await run(FAKE_SCENARIOS[scenario], log);
  process.exit(0);
}
