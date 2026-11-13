import { EventType } from "@tanstack/ai";
import { panic, Result } from "better-result";
import { Temporal } from "temporal-polyfill/full";

import {
  AGENT_HARNESSES,
  harnessSessionIdEvent,
} from "@stll/api-contract/agent-harness";
import { CHAT_LOCAL_RUN_TOOL_NAMES } from "@stll/api-contract/chat-local-run-tool";
import {
  DESKTOP_RUNNER_APPROVAL_DECISIONS,
  DESKTOP_RUNNER_APPROVAL_KINDS,
  DESKTOP_RUNNER_APPROVAL_MODES,
  DESKTOP_RUNNER_CHECKPOINT_EVENT,
  DESKTOP_RUNNER_FS_POLICIES,
  DESKTOP_RUNNER_NETWORK_POLICIES,
  DESKTOP_RUNNER_OUTPUT_EVENT,
  DESKTOP_RUNNER_REASONING_EFFORTS,
  DESKTOP_RUNNER_RUN_OUTCOMES,
} from "@stll/api-contract/desktop-runner";
import { hmacSha256Hex } from "@stll/sha256/node";

import { ASK_USER_QUESTION_TOOL } from "./harness/claude-code/items";
import {
  CLAUDE_CONTENT_BLOCK_TYPES,
  type ClaudeControlRequestSubtype,
  type ClaudeHostControlRequest,
  type ClaudeMessageType,
  type ClaudeSystemSubtype,
} from "./harness/claude-code/protocol";
import {
  CODEX_CLIENT_INFO,
  CODEX_ITEM_TYPES,
  CODEX_TURN_STATUSES,
  type CodexClientNotificationMethod,
  type CodexClientRequestMethod,
  type CodexNotificationMethod,
  type CodexServerRequestMethod,
} from "./harness/codex/protocol";
import { HARNESS_CONTINUATION_EVENT } from "./harness/stream-chunks";
import {
  SIDECAR_HOLDER_MODES,
  SIDECAR_HOST_MESSAGE,
  SIDECAR_PROBE_FAILURES,
  SIDECAR_REJECTIONS,
  SIDECAR_RESTORE_OUTCOMES,
  type SidecarHostMessage,
  type SidecarMessage,
  type SidecarProbeOutcome,
} from "./sidecar/protocol";

/**
 * The protocol log: one line per message exchanged with a harness CLI
 * (Claude Code's stream-json, Codex's app-server JSON-RPC) or between the
 * desktop and its sidecar, for diagnosing a run on the member's computer.
 *
 * A line keeps a message's structure only. Each field is kept by an
 * allowlist per message kind and rendered by its rule. A string is shown as
 * it is only when it belongs to a closed list this code owns (protocol
 * values, Stella's own tool, event and client names); any other string in
 * such a field shows its size and fingerprint. Numbers and booleans are
 * shown; versions are rebuilt from their numbers and instants re-serialized
 * after parsing, so neither copies input text. Ids are short keyed
 * fingerprints, so a request and its answer pair up within one holder's
 * log. Everything else (prompts, model text, tool input and output, file
 * contents, paths, commands, tokens) shows as its kind and size. String
 * lengths and line sizes are power-of-two bands, never exact. A field the
 * allowlist does not name is counted, never shown, so a field a harness adds
 * later stays out of the log until it is listed here.
 */

export const PROTOCOL_CHANNELS = ["claude-code", "codex", "sidecar"] as const;
export type ProtocolChannel = (typeof PROTOCOL_CHANNELS)[number];

/** `in`: written by the peer (the CLI, or the desktop for the sidecar). */
export const PROTOCOL_DIRECTIONS = ["in", "out"] as const;
export type ProtocolDirection = (typeof PROTOCOL_DIRECTIONS)[number];

/** How one field reaches the log line. */
export type FieldRule =
  /**
   * A value from a closed list this code owns (protocol values, Stella's own
   * tool and client names); any other string is shown by size and
   * fingerprint.
   */
  | { type: "vocabulary"; values: ReadonlySet<string> }
  /** An id: a fingerprint for a string, the number for a JSON-RPC id. */
  | { type: "identifier" }
  /** Numeric `major.minor.patch` only; a suffix is fingerprinted. */
  | { type: "version" }
  /** Re-serialized from the parsed instant, never copied. */
  | { type: "instant" }
  | { type: "number" }
  | { type: "boolean" }
  /** The value's kind and size only. */
  | { type: "size" }
  | { type: "object"; shape: MessageShape }
  /** The item count, then the first items by `shape`. */
  | { type: "list"; shape: MessageShape };

/** The fields kept of one object, and the field whose value picks more. */
export type MessageShape = {
  readonly fields: Readonly<Record<string, FieldRule>>;
  readonly variant: ShapeVariant | null;
};

type ShapeVariant = {
  readonly key: string;
  readonly cases: Readonly<Record<string, MessageShape>>;
};

/** Items of a list rendered one by one; the rest are counted. */
const PROTOCOL_LOG_LIST_ITEMS = 8;
const FINGERPRINT_HEX_CHARS = 8;

const VERSION_CORE = /^\d{1,9}\.\d{1,9}\.\d{1,9}/u;

const IDENTIFIER = { type: "identifier" } as const satisfies FieldRule;
const VERSION = { type: "version" } as const satisfies FieldRule;
const INSTANT = { type: "instant" } as const satisfies FieldRule;
const NUMBER = { type: "number" } as const satisfies FieldRule;
const BOOLEAN = { type: "boolean" } as const satisfies FieldRule;
const SIZE = { type: "size" } as const satisfies FieldRule;

type Fields = Readonly<Record<string, FieldRule>>;

const vocabulary = (values: Iterable<string>): FieldRule => ({
  type: "vocabulary",
  values: new Set(values),
});

/**
 * A string with no closed list, such as a model id or an MCP server's own
 * name: always its size and fingerprint.
 */
const OPAQUE = vocabulary([]);

const shape = (
  fields: Fields,
  variant: ShapeVariant | null = null,
): MessageShape => ({ fields, variant });

const object = (fields: Fields, variant: ShapeVariant | null = null) =>
  ({
    type: "object",
    shape: shape(fields, variant),
  }) as const satisfies FieldRule;

const list = (fields: Fields) =>
  ({ type: "list", shape: shape(fields) }) as const satisfies FieldRule;

/** A variant's cases, each from its own fields. */
const casesOf = (
  cases: Readonly<Record<string, Fields>>,
): Readonly<Record<string, MessageShape>> =>
  Object.fromEntries(
    Object.entries(cases).map(([name, fields]) => [name, shape(fields)]),
  );

// Claude Code: stream-json on the CLI's stdin and stdout.

/** The CLI's built-in tools; MCP tools (`mcp__<server>__<tool>`) are opaque. */
const CLAUDE_TOOLS_LIST = [
  "Bash",
  "BashOutput",
  "KillShell",
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  "Task",
  "ExitPlanMode",
  ASK_USER_QUESTION_TOOL,
];
const CLAUDE_TOOLS = vocabulary(CLAUDE_TOOLS_LIST);

const CLAUDE_HOOK_EVENTS = vocabulary([
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Notification",
  "UserPromptSubmit",
  "SessionStart",
  "SessionEnd",
  "Stop",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PermissionRequest",
]);

const CLAUDE_API_KEY_SOURCES = vocabulary([
  "user",
  "project",
  "org",
  "temporary",
  "none",
]);

const MEDIA_TYPES = vocabulary([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
]);

const CLAUDE_STOP_REASONS = vocabulary([
  "end_turn",
  "max_tokens",
  "stop_sequence",
  "tool_use",
  "pause_turn",
  "refusal",
  "model_context_window_exceeded",
]);

/** Codes on an assistant message an API failure produced. */
const CLAUDE_ASSISTANT_ERRORS = vocabulary([
  "authentication_failed",
  "oauth_org_not_allowed",
  "billing_error",
  "rate_limit",
  "invalid_request",
  "server_error",
  "max_output_tokens",
  "unknown",
]);

const CLAUDE_USAGE = object({
  input_tokens: NUMBER,
  output_tokens: NUMBER,
  cache_creation_input_tokens: NUMBER,
  cache_read_input_tokens: NUMBER,
  service_tier: vocabulary(["standard", "priority", "batch"]),
});

/** Content blocks of assistant and user messages, both directions. */
const CLAUDE_CONTENT_BLOCK = {
  type: vocabulary([
    ...CLAUDE_CONTENT_BLOCK_TYPES,
    "tool_result",
    "image",
    "document",
    "server_tool_use",
    "web_search_tool_result",
  ]),
  id: IDENTIFIER,
  name: CLAUDE_TOOLS,
  tool_use_id: IDENTIFIER,
  is_error: BOOLEAN,
  input: SIZE,
  text: SIZE,
  thinking: SIZE,
  signature: SIZE,
  data: SIZE,
  content: SIZE,
  source: object({
    type: vocabulary(["base64", "url", "text"]),
    media_type: MEDIA_TYPES,
    data: SIZE,
  }),
} as const satisfies Fields;

const CLAUDE_PERMISSION_MODES = vocabulary([
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "dontAsk",
]);

const CLAUDE_TASK_FIELDS = {
  task_id: IDENTIFIER,
  tool_use_id: IDENTIFIER,
  status: vocabulary(["completed", "failed", "stopped"]),
  description: SIZE,
  summary: SIZE,
} as const satisfies Fields;

const CLAUDE_HOOK_FIELDS = {
  hook_id: IDENTIFIER,
  hook_name: OPAQUE,
  hook_event: CLAUDE_HOOK_EVENTS,
  exit_code: NUMBER,
  output: SIZE,
  stdout: SIZE,
  stderr: SIZE,
} as const satisfies Fields;

const CLAUDE_SYSTEM_FIELDS: Readonly<Record<ClaudeSystemSubtype, Fields>> = {
  init: {
    model: OPAQUE,
    permissionMode: CLAUDE_PERMISSION_MODES,
    claude_code_version: VERSION,
    apiKeySource: CLAUDE_API_KEY_SOURCES,
    cwd: SIZE,
    tools: SIZE,
    mcp_servers: list({
      name: OPAQUE,
      status: vocabulary([
        "connected",
        "failed",
        "needs-auth",
        "pending",
        "disabled",
      ]),
    }),
    slash_commands: SIZE,
    agents: SIZE,
    skills: SIZE,
    plugins: SIZE,
  },
  api_retry: {
    attempt: NUMBER,
    max_retries: NUMBER,
    retry_delay_ms: NUMBER,
    error_status: NUMBER,
    error: CLAUDE_ASSISTANT_ERRORS,
  },
  status: {
    status: vocabulary(["compacting"]),
    permissionMode: CLAUDE_PERMISSION_MODES,
  },
  compact_boundary: {
    compact_metadata: object({
      trigger: vocabulary(["manual", "auto"]),
      pre_tokens: NUMBER,
    }),
  },
  control_request_progress: { request_id: IDENTIFIER },
  model_refusal_fallback: { model: OPAQUE },
  model_refusal_no_fallback: { model: OPAQUE },
  local_command_output: { content: SIZE },
  hook_started: CLAUDE_HOOK_FIELDS,
  hook_progress: CLAUDE_HOOK_FIELDS,
  hook_response: CLAUDE_HOOK_FIELDS,
  plugin_install: {},
  task_started: CLAUDE_TASK_FIELDS,
  task_updated: CLAUDE_TASK_FIELDS,
  task_progress: CLAUDE_TASK_FIELDS,
  task_notification: CLAUDE_TASK_FIELDS,
  background_tasks_changed: {},
  thinking_tokens: { tokens: NUMBER },
  session_state_changed: {},
  worker_shutting_down: {},
  commands_changed: {},
  notification: {},
  files_persisted: { files: SIZE, failed: SIZE },
  memory_recall: {},
  elicitation_complete: { mcp_server_name: OPAQUE },
  permission_denied: { tool_name: CLAUDE_TOOLS, tool_use_id: IDENTIFIER },
  mirror_error: {},
  informational: {},
};

/** Control requests in both directions, by subtype. */
const CLAUDE_CONTROL_REQUEST_FIELDS: Readonly<
  Record<ClaudeControlRequestSubtype | ClaudeHostControlRequest, Fields>
> = {
  can_use_tool: {
    tool_name: CLAUDE_TOOLS,
    tool_use_id: IDENTIFIER,
    agent_id: IDENTIFIER,
    input: SIZE,
    permission_suggestions: SIZE,
    decision_reason: SIZE,
    blocked_path: SIZE,
    title: SIZE,
    description: SIZE,
  },
  elicitation: {
    mcp_server_name: OPAQUE,
    message: SIZE,
    requested_schema: SIZE,
  },
  hook_callback: {
    callback_id: IDENTIFIER,
    tool_use_id: IDENTIFIER,
    input: SIZE,
  },
  mcp_message: { server_name: OPAQUE, message: SIZE },
  request_user_dialog: {},
  initialize: {
    systemPrompt: SIZE,
    appendSystemPrompt: SIZE,
    hooks: SIZE,
    sdkMcpServers: SIZE,
    jsonSchema: SIZE,
    agents: SIZE,
  },
  interrupt: {},
  get_usage: { skip_behaviors: BOOLEAN },
  mcp_set_servers: { servers: SIZE },
  set_permission_mode: {
    mode: vocabulary([
      "default",
      "acceptEdits",
      "bypassPermissions",
      "plan",
      "dontAsk",
      "auto",
    ]),
  },
  stop_task: { task_id: IDENTIFIER },
};

const CLAUDE_USAGE_WINDOW = object({ utilization: NUMBER, resets_at: INSTANT });

/** What a successful control response carries, whichever request it answers. */
const CLAUDE_CONTROL_RESPONSE_FIELDS = {
  behavior: vocabulary(["allow", "deny"]),
  action: vocabulary(["accept", "decline", "cancel"]),
  interrupt: BOOLEAN,
  updatedInput: SIZE,
  updatedPermissions: SIZE,
  message: SIZE,
  models: SIZE,
  commands: SIZE,
  agents: SIZE,
  account: object({
    tokenSource: vocabulary(["none", "claude.ai"]),
    apiKeySource: CLAUDE_API_KEY_SOURCES,
    subscriptionType: vocabulary(["free", "pro", "max", "team", "enterprise"]),
    apiProvider: vocabulary(["firstParty", "bedrock", "vertex", "foundry"]),
  }),
  claude_code_version: VERSION,
  added: SIZE,
  removed: SIZE,
  errors: SIZE,
  rate_limits_available: BOOLEAN,
  rate_limits: object({
    five_hour: CLAUDE_USAGE_WINDOW,
    seven_day: CLAUDE_USAGE_WINDOW,
  }),
} as const satisfies Fields;

const CLAUDE_STREAM_EVENT = object({
  type: vocabulary([
    "message_start",
    "message_delta",
    "message_stop",
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
  ]),
  index: NUMBER,
  message: object({ id: IDENTIFIER, model: OPAQUE, usage: CLAUDE_USAGE }),
  content_block: object(CLAUDE_CONTENT_BLOCK),
  delta: object({
    type: vocabulary([
      "text_delta",
      "input_json_delta",
      "thinking_delta",
      "signature_delta",
      "citations_delta",
    ]),
    stop_reason: CLAUDE_STOP_REASONS,
    text: SIZE,
    partial_json: SIZE,
    thinking: SIZE,
    signature: SIZE,
  }),
  usage: CLAUDE_USAGE,
});

type ClaudeLineType =
  | ClaudeMessageType
  | "control_request"
  | "control_response"
  | "control_cancel_request";

const CLAUDE_LINE_FIELDS: Readonly<Record<ClaudeLineType, MessageShape>> = {
  control_request: shape({
    request_id: IDENTIFIER,
    request: object(
      {},
      { key: "subtype", cases: casesOf(CLAUDE_CONTROL_REQUEST_FIELDS) },
    ),
  }),
  control_response: shape({
    response: object(
      {
        request_id: IDENTIFIER,
        response: object(CLAUDE_CONTROL_RESPONSE_FIELDS),
        error: SIZE,
      },
      { key: "subtype", cases: casesOf({ success: {}, error: {} }) },
    ),
  }),
  control_cancel_request: shape({ request_id: IDENTIFIER }),
  assistant: shape({
    message: object({
      id: IDENTIFIER,
      model: OPAQUE,
      stop_reason: CLAUDE_STOP_REASONS,
      content: list(CLAUDE_CONTENT_BLOCK),
      usage: CLAUDE_USAGE,
    }),
    error: CLAUDE_ASSISTANT_ERRORS,
  }),
  // `content` is a list of blocks or, written by Stella, one string.
  user: shape({ message: object({ content: list(CLAUDE_CONTENT_BLOCK) }) }),
  result: shape({
    subtype: vocabulary([
      "success",
      "error_max_turns",
      "error_during_execution",
      "error_max_budget_usd",
      "error_max_structured_output_retries",
    ]),
    is_error: BOOLEAN,
    api_error_status: NUMBER,
    stop_reason: CLAUDE_STOP_REASONS,
    duration_ms: NUMBER,
    duration_api_ms: NUMBER,
    num_turns: NUMBER,
    total_cost_usd: NUMBER,
    usage: CLAUDE_USAGE,
    result: SIZE,
    errors: SIZE,
    modelUsage: SIZE,
    permission_denials: SIZE,
  }),
  system: shape({}, { key: "subtype", cases: casesOf(CLAUDE_SYSTEM_FIELDS) }),
  stream_event: shape({ event: CLAUDE_STREAM_EVENT }),
  rate_limit_event: shape({
    rate_limit_info: object({
      status: vocabulary(["allowed", "allowed_warning", "rejected"]),
      rateLimitType: vocabulary([
        "five_hour",
        "seven_day",
        "seven_day_opus",
        "seven_day_sonnet",
        "overage",
      ]),
      resetsAt: NUMBER,
      utilization: NUMBER,
      isUsingOverage: BOOLEAN,
    }),
  }),
  auth_status: shape({ isAuthenticating: BOOLEAN, output: SIZE, error: SIZE }),
  tool_progress: shape({
    tool_use_id: IDENTIFIER,
    tool_name: CLAUDE_TOOLS,
    task_id: IDENTIFIER,
    elapsed_time_seconds: NUMBER,
  }),
  tool_use_summary: shape({ summary: SIZE, preceding_tool_use_ids: SIZE }),
  prompt_suggestion: shape({ suggestion: SIZE }),
  conversation_reset: shape({}),
  active_goal: shape({}),
  keep_alive: shape({}),
};

// The CLI writes every type it knows; `items.ts` decides what each means.
const CLAUDE_LINE: MessageShape = shape(
  {
    session_id: IDENTIFIER,
    uuid: IDENTIFIER,
    parent_tool_use_id: IDENTIFIER,
  },
  { key: "type", cases: CLAUDE_LINE_FIELDS },
);

// Codex: JSON-RPC over the app server's stdio, both directions.

const CODEX_PLAN_TYPES = vocabulary([
  "free",
  "go",
  "plus",
  "pro",
  "team",
  "business",
  "enterprise",
  "edu",
  "unknown",
]);

const CODEX_ERROR = object({
  message: SIZE,
  additionalDetails: SIZE,
  // A string code, or an object keyed by one; only string codes are kept.
  codexErrorInfo: vocabulary([
    "contextWindowExceeded",
    "usageLimitExceeded",
    "serverOverloaded",
    "internalServerError",
    "unauthorized",
    "badRequest",
    "threadRollbackFailed",
    "sandboxError",
    "other",
  ]),
});

const CODEX_TURN = object({
  id: IDENTIFIER,
  status: vocabulary(CODEX_TURN_STATUSES),
  error: CODEX_ERROR,
  startedAt: NUMBER,
  completedAt: NUMBER,
  durationMs: NUMBER,
  items: SIZE,
});

const CODEX_ITEM_STATUSES = vocabulary([
  "inProgress",
  "completed",
  "failed",
  "declined",
]);

/** Thread items; fields of every kind, each by its rule. */
const CODEX_ITEM = object({
  type: vocabulary(CODEX_ITEM_TYPES),
  id: IDENTIFIER,
  status: CODEX_ITEM_STATUSES,
  exitCode: NUMBER,
  durationMs: NUMBER,
  server: OPAQUE,
  tool: OPAQUE,
  delivery: vocabulary(["async"]),
  command: SIZE,
  cwd: SIZE,
  aggregatedOutput: SIZE,
  changes: SIZE,
  arguments: SIZE,
  result: SIZE,
  error: SIZE,
  text: SIZE,
  summary: SIZE,
  content: SIZE,
  query: SIZE,
  questions: SIZE,
});

const CODEX_TOKENS = object({
  totalTokens: NUMBER,
  inputTokens: NUMBER,
  cachedInputTokens: NUMBER,
  outputTokens: NUMBER,
  reasoningOutputTokens: NUMBER,
});

const CODEX_RATE_LIMIT_WINDOW = object({
  usedPercent: NUMBER,
  windowDurationMins: NUMBER,
  resetsAt: NUMBER,
});

const CODEX_IN_TURN = { threadId: IDENTIFIER, turnId: IDENTIFIER } as const;
const CODEX_ON_ITEM = { ...CODEX_IN_TURN, itemId: IDENTIFIER } as const;
const CODEX_DELTA = { ...CODEX_ON_ITEM, delta: SIZE } as const;
const CODEX_APPROVAL = {
  ...CODEX_ON_ITEM,
  approvalId: IDENTIFIER,
  reason: SIZE,
} as const satisfies Fields;

const CODEX_THREAD_PARAMS = {
  model: OPAQUE,
  approvalPolicy: vocabulary([
    "untrusted",
    "on-failure",
    "on-request",
    "never",
  ]),
  sandbox: vocabulary(["read-only", "workspace-write", "danger-full-access"]),
  cwd: SIZE,
  developerInstructions: SIZE,
  config: SIZE,
} as const satisfies Fields;

/**
 * Notifications the adapter does not consume (`protocol.ts` drops them),
 * listed so their method names reach the log.
 */
const CODEX_UNCONSUMED_NOTIFICATIONS = {
  "thread/started": { thread: object({ id: IDENTIFIER }) },
  "thread/status/changed": { threadId: IDENTIFIER, status: SIZE },
  "thread/name/updated": { threadId: IDENTIFIER, threadName: SIZE },
  "thread/compacted": CODEX_IN_TURN,
  "item/reasoning/summaryTextDelta": CODEX_DELTA,
  "item/reasoning/summaryPartAdded": {
    ...CODEX_ON_ITEM,
    summaryIndex: NUMBER,
  },
  "item/reasoning/textDelta": CODEX_DELTA,
  "item/commandExecution/outputDelta": CODEX_DELTA,
  "item/fileChange/outputDelta": CODEX_DELTA,
  "item/mcpToolCall/progress": { ...CODEX_ON_ITEM, message: SIZE },
  "mcpServer/startupStatus/updated": {
    name: OPAQUE,
    status: vocabulary(["starting", "ready", "failed", "cancelled"]),
    error: SIZE,
  },
  "account/updated": {
    authMode: vocabulary(["apikey", "chatgpt", "chatgptAuthTokens"]),
    planType: CODEX_PLAN_TYPES,
  },
  deprecationNotice: { summary: SIZE, details: SIZE },
  configWarning: { summary: SIZE, details: SIZE },
} as const satisfies Record<string, Fields>;

type CodexMethod =
  | CodexClientRequestMethod
  | CodexClientNotificationMethod
  | CodexNotificationMethod
  | CodexServerRequestMethod
  | keyof typeof CODEX_UNCONSUMED_NOTIFICATIONS;

const CODEX_PARAMS: Readonly<Record<CodexMethod, Fields>> = {
  initialize: {
    // A client name registered with a credential is fingerprinted.
    clientInfo: object({
      name: vocabulary([CODEX_CLIENT_INFO.name]),
      title: vocabulary([CODEX_CLIENT_INFO.title]),
      version: VERSION,
    }),
    capabilities: object({
      experimentalApi: BOOLEAN,
      requestAttestation: BOOLEAN,
      optOutNotificationMethods: SIZE,
    }),
  },
  initialized: {},
  "account/read": { refreshToken: BOOLEAN },
  "model/list": { limit: NUMBER, cursor: SIZE },
  "skills/extraRoots/set": { extraRoots: SIZE },
  "skills/list": { forceReload: BOOLEAN, cwds: SIZE },
  "thread/start": CODEX_THREAD_PARAMS,
  "thread/resume": {
    ...CODEX_THREAD_PARAMS,
    threadId: IDENTIFIER,
    excludeTurns: BOOLEAN,
  },
  "thread/unarchive": { threadId: IDENTIFIER },
  "thread/backgroundTerminals/list": {
    threadId: IDENTIFIER,
    cursor: IDENTIFIER,
    data: list({ itemId: IDENTIFIER }),
    nextCursor: IDENTIFIER,
  },
  "thread/backgroundTerminals/clean": { threadId: IDENTIFIER },
  "turn/start": {
    threadId: IDENTIFIER,
    model: OPAQUE,
    effort: vocabulary(DESKTOP_RUNNER_REASONING_EFFORTS),
    input: list({
      type: vocabulary(["text", "image", "localImage", "skill", "mention"]),
      text: SIZE,
      url: SIZE,
      path: SIZE,
    }),
  },
  "turn/interrupt": CODEX_IN_TURN,
  "turn/started": { threadId: IDENTIFIER, turn: CODEX_TURN },
  "turn/completed": { threadId: IDENTIFIER, turn: CODEX_TURN },
  "item/started": { ...CODEX_IN_TURN, item: CODEX_ITEM },
  "item/completed": { ...CODEX_IN_TURN, item: CODEX_ITEM },
  "item/agentMessage/delta": CODEX_DELTA,
  error: { ...CODEX_IN_TURN, willRetry: BOOLEAN, error: CODEX_ERROR },
  "thread/tokenUsage/updated": {
    ...CODEX_IN_TURN,
    tokenUsage: object({
      last: CODEX_TOKENS,
      total: CODEX_TOKENS,
      modelContextWindow: NUMBER,
    }),
  },
  "turn/plan/updated": { ...CODEX_IN_TURN, explanation: SIZE, plan: SIZE },
  "serverRequest/resolved": { threadId: IDENTIFIER, requestId: IDENTIFIER },
  "account/rateLimits/updated": {
    rateLimits: object({
      limitId: vocabulary(["codex"]),
      planType: CODEX_PLAN_TYPES,
      primary: CODEX_RATE_LIMIT_WINDOW,
      secondary: CODEX_RATE_LIMIT_WINDOW,
      credits: SIZE,
    }),
  },
  "item/commandExecution/requestApproval": {
    ...CODEX_APPROVAL,
    command: SIZE,
    cwd: SIZE,
    commandActions: SIZE,
  },
  "item/fileChange/requestApproval": { ...CODEX_APPROVAL, grantRoot: SIZE },
  "item/permissions/requestApproval": {
    ...CODEX_APPROVAL,
    permissions: SIZE,
  },
  "item/tool/requestUserInput": {
    ...CODEX_ON_ITEM,
    questions: list({
      id: IDENTIFIER,
      isOther: BOOLEAN,
      isSecret: BOOLEAN,
      header: SIZE,
      question: SIZE,
      options: SIZE,
    }),
  },
  "mcpServer/elicitation/request": {
    ...CODEX_IN_TURN,
    serverName: OPAQUE,
    message: SIZE,
    requestedSchema: SIZE,
  },
  "item/tool/call": {
    ...CODEX_IN_TURN,
    callId: IDENTIFIER,
    tool: OPAQUE,
    arguments: SIZE,
  },
  applyPatchApproval: {
    conversationId: IDENTIFIER,
    callId: IDENTIFIER,
    fileChanges: SIZE,
    reason: SIZE,
    grantRoot: SIZE,
  },
  execCommandApproval: {
    conversationId: IDENTIFIER,
    callId: IDENTIFIER,
    command: SIZE,
    cwd: SIZE,
    reason: SIZE,
  },
  "account/chatgptAuthTokens/refresh": { reason: vocabulary(["unauthorized"]) },
  "attestation/generate": {},
  ...CODEX_UNCONSUMED_NOTIFICATIONS,
};

/** What a response carries, whichever request it answers. */
const CODEX_RESULT = object({
  thread: object({ id: IDENTIFIER, modelProvider: vocabulary(["openai"]) }),
  turn: CODEX_TURN,
  account: object({
    type: vocabulary(["apiKey", "chatgpt"]),
    planType: CODEX_PLAN_TYPES,
  }),
  requiresOpenaiAuth: BOOLEAN,
  // Stella's answers to approvals, questions and declined requests.
  decision: vocabulary([
    "accept",
    "acceptForSession",
    "decline",
    "cancel",
    "abort",
  ]),
  action: vocabulary(["accept", "decline", "cancel"]),
  success: BOOLEAN,
  answers: SIZE,
  permissions: SIZE,
  contentItems: SIZE,
  data: SIZE,
  nextCursor: SIZE,
  userAgent: SIZE,
  codexHome: SIZE,
});

const CODEX_LINE: MessageShape = shape(
  {
    id: IDENTIFIER,
    result: CODEX_RESULT,
    error: object({ code: NUMBER, message: SIZE, data: SIZE }),
  },
  {
    key: "method",
    cases: Object.fromEntries(
      Object.entries(CODEX_PARAMS).map(([method, params]) => [
        method,
        shape({ params: object(params) }),
      ]),
    ),
  },
);

// Sidecar: the desktop's socket to its holder.

const SIDECAR_HARNESS = vocabulary(AGENT_HARNESSES);

/** Launch settings may name a private channel: sizes only. */
const SIDECAR_LAUNCH = {
  harness: SIDECAR_HARNESS,
  executable: SIZE,
  configDir: SIZE,
  launch: object({
    processGrant: BOOLEAN,
    configOverrides: SIZE,
    environment: SIZE,
    removedEnvironment: SIZE,
    clientName: SIZE,
  }),
} as const satisfies Fields;

const SIDECAR_HOST_FIELDS: Readonly<
  Record<SidecarHostMessage["type"], Fields>
> = {
  // The secret is never listed.
  hello: {
    protocol: NUMBER,
    appVersion: VERSION,
    apiOrigin: SIZE,
    resume: SIZE,
  },
  "harness.probe": { requestId: IDENTIFIER, ...SIDECAR_LAUNCH },
  "run.start": {
    runId: IDENTIFIER,
    threadId: IDENTIFIER,
    harnessSessionId: IDENTIFIER,
    ...SIDECAR_LAUNCH,
    model: OPAQUE,
    reasoningEffort: vocabulary(DESKTOP_RUNNER_REASONING_EFFORTS),
    policy: object({
      network: vocabulary(DESKTOP_RUNNER_NETWORK_POLICIES),
      fs: vocabulary(DESKTOP_RUNNER_FS_POLICIES),
      approvals: vocabulary(DESKTOP_RUNNER_APPROVAL_MODES),
    }),
    mcp: object({ serverName: OPAQUE, expiresAt: INSTANT, url: SIZE }),
    workspaceDir: SIZE,
    cacheDir: SIZE,
    instructions: SIZE,
    messages: SIZE,
    attachments: SIZE,
    skillFolders: SIZE,
    toolPath: SIZE,
  },
  "run.approval": {
    runId: IDENTIFIER,
    requestId: IDENTIFIER,
    decision: vocabulary(DESKTOP_RUNNER_APPROVAL_DECISIONS),
  },
  "run.answer": { runId: IDENTIFIER, requestId: IDENTIFIER, answers: SIZE },
  "run.interrupt": { runId: IDENTIFIER },
  "run.cancel": { runId: IDENTIFIER },
  "run.token": { runId: IDENTIFIER, expiresAt: INSTANT },
  ack: { runId: IDENTIFIER, seq: NUMBER },
  resume: { runId: IDENTIFIER, afterSeq: NUMBER },
  "harness.process_granted": { id: IDENTIFIER },
  "folder.restore": {
    requestId: IDENTIFIER,
    runId: IDENTIFIER,
    workspaceDir: SIZE,
  },
  drain: {},
  shutdown: {},
};

// A total record binds the list to the union in both directions.
const PROBE_OUTCOME_TYPES = vocabulary(
  Object.keys({
    ready: true,
    needs_login: true,
    limit_until: true,
    unsupported: true,
    failed: true,
  } satisfies Record<SidecarProbeOutcome["type"], true>),
);

/** A TanStack stream chunk; fields of every event type, each by its rule. */
const SIDECAR_CHUNK = object({
  type: vocabulary(Object.values(EventType)),
  messageId: IDENTIFIER,
  toolCallId: IDENTIFIER,
  runId: IDENTIFIER,
  threadId: IDENTIFIER,
  toolCallName: vocabulary([
    ...Object.values(CHAT_LOCAL_RUN_TOOL_NAMES),
    ...CLAUDE_TOOLS_LIST,
  ]),
  name: vocabulary([
    DESKTOP_RUNNER_CHECKPOINT_EVENT,
    DESKTOP_RUNNER_OUTPUT_EVENT,
    HARNESS_CONTINUATION_EVENT,
    ...AGENT_HARNESSES.map(harnessSessionIdEvent),
  ]),
  model: OPAQUE,
  code: OPAQUE,
  finishReason: vocabulary(["stop", "length", "tool_calls", "content_filter"]),
  role: vocabulary(["assistant", "user", "tool"]),
  timestamp: NUMBER,
  error: object({ code: OPAQUE, message: SIZE }),
  delta: SIZE,
  content: SIZE,
  value: SIZE,
  args: SIZE,
  result: SIZE,
  message: SIZE,
  usage: SIZE,
});

const SIDECAR_FIELDS: Readonly<Record<SidecarMessage["type"], Fields>> = {
  hello: {
    protocol: NUMBER,
    sidecarVersion: VERSION,
    mode: vocabulary(SIDECAR_HOLDER_MODES),
    runs: list({
      runId: IDENTIFIER,
      harness: SIDECAR_HARNESS,
      lastSeq: NUMBER,
    }),
  },
  "harness.probed": {
    requestId: IDENTIFIER,
    harness: SIDECAR_HARNESS,
    outcome: object({
      type: PROBE_OUTCOME_TYPES,
      version: VERSION,
      recommendedVersion: VERSION,
      resetsAt: INSTANT,
      reason: vocabulary(SIDECAR_PROBE_FAILURES),
      capabilities: SIZE,
      approvalModes: SIZE,
      models: SIZE,
      message: SIZE,
    }),
  },
  "harness.process": { id: IDENTIFIER, pid: NUMBER },
  "run.event": { runId: IDENTIFIER, seq: NUMBER, chunk: SIDECAR_CHUNK },
  "run.approval_request": {
    runId: IDENTIFIER,
    seq: NUMBER,
    requestId: IDENTIFIER,
    kind: vocabulary(DESKTOP_RUNNER_APPROVAL_KINDS),
    summary: SIZE,
  },
  "run.finished": {
    runId: IDENTIFIER,
    seq: NUMBER,
    outcome: vocabulary(DESKTOP_RUNNER_RUN_OUTCOMES),
    harnessSessionId: IDENTIFIER,
  },
  "folder.restored": {
    requestId: IDENTIFIER,
    outcome: vocabulary(SIDECAR_RESTORE_OUTCOMES),
  },
  "background.tasks": { runId: IDENTIFIER, count: NUMBER },
  rejected: {
    reason: vocabulary(SIDECAR_REJECTIONS),
    messageType: vocabulary(Object.values(SIDECAR_HOST_MESSAGE)),
    runId: IDENTIFIER,
  },
};

/** Every message kind's kept fields, by channel and direction. */
export const PROTOCOL_ALLOWLISTS: Readonly<
  Record<ProtocolChannel, Readonly<Record<ProtocolDirection, MessageShape>>>
> = {
  "claude-code": { in: CLAUDE_LINE, out: CLAUDE_LINE },
  codex: { in: CODEX_LINE, out: CODEX_LINE },
  sidecar: {
    in: shape({}, { key: "type", cases: casesOf(SIDECAR_HOST_FIELDS) }),
    out: shape({}, { key: "type", cases: casesOf(SIDECAR_FIELDS) }),
  },
};

type JsonObject = Readonly<Record<string, unknown>>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A length as the power-of-two band it falls in (`8-15`): enough to tell a
 * short value from a long one, without the exact size.
 */
const band = (length: number) => {
  if (length === 0) {
    return "0";
  }
  let low = 1;
  while (low * 2 <= length) {
    low *= 2;
  }
  return `${String(low)}-${String(low * 2 - 1)}`;
};

/** A value's kind and size, never its content. */
const describe = (value: unknown): string => {
  if (typeof value === "string") {
    return `str:${band(value.length)}`;
  }
  if (Array.isArray(value)) {
    return `arr:${String(value.length)}`;
  }
  if (isObject(value)) {
    return `obj:${String(Object.keys(value).length)}`;
  }
  if (typeof value === "number") {
    return "num";
  }
  if (typeof value === "boolean") {
    return "bool";
  }
  return value === null ? "null" : "unknown";
};

/** A keyed fingerprint: equal within one key, no oracle without it. */
type Fingerprint = (value: string) => string;

const keyedFingerprint =
  (key: Uint8Array): Fingerprint =>
  (value) =>
    `#${hmacSha256Hex(key, value).slice(0, FINGERPRINT_HEX_CHARS)}`;

/** A string outside every closed list: its size and fingerprint. */
const opaque = (value: string, fingerprint: Fingerprint) =>
  `${describe(value)}${fingerprint(value)}`;

const fromVocabulary = (
  value: unknown,
  values: ReadonlySet<string>,
  fingerprint: Fingerprint,
) => {
  if (typeof value !== "string") {
    return describe(value);
  }
  return values.has(value) ? value : opaque(value, fingerprint);
};

/**
 * The leading `major.minor.patch`, which the pattern admits as ASCII digits
 * and dots only; any suffix is fingerprinted.
 */
const version = (value: unknown, fingerprint: Fingerprint) => {
  if (typeof value !== "string") {
    return describe(value);
  }
  const [numeric] = VERSION_CORE.exec(value) ?? [];
  if (numeric === undefined) {
    return opaque(value, fingerprint);
  }
  const suffix = value.slice(numeric.length);
  return suffix === "" ? numeric : `${numeric}+${fingerprint(suffix)}`;
};

/** The instant as Temporal writes it, so nothing of the input is copied. */
const instant = (value: unknown, fingerprint: Fingerprint) => {
  if (typeof value !== "string") {
    return describe(value);
  }
  const parsed = Result.try(() => Temporal.Instant.from(value));
  return Result.isOk(parsed)
    ? parsed.value.toString()
    : opaque(value, fingerprint);
};

const identifier = (value: unknown, fingerprint: Fingerprint) => {
  if (typeof value === "string") {
    return fingerprint(value);
  }
  return typeof value === "number" && Number.isSafeInteger(value)
    ? String(value)
    : describe(value);
};

const finiteNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : describe(value);

const flag = (value: unknown) =>
  typeof value === "boolean" ? String(value) : describe(value);

const joinPath = (prefix: string, key: string) =>
  prefix === "" ? key : `${prefix}.${key}`;

type Rendering = {
  value: unknown;
  path: string;
  out: string[];
  fingerprint: Fingerprint;
};
type ShapeRendering = Omit<Rendering, "value"> & { value: JsonObject };

/** A field's rendering when it is a single token. */
const scalar = (
  rule: FieldRule,
  value: unknown,
  fingerprint: Fingerprint,
): string | null => {
  switch (rule.type) {
    case "vocabulary":
      return fromVocabulary(value, rule.values, fingerprint);
    case "identifier":
      return identifier(value, fingerprint);
    case "version":
      return version(value, fingerprint);
    case "instant":
      return instant(value, fingerprint);
    case "number":
      return finiteNumber(value);
    case "boolean":
      return flag(value);
    case "size":
      return describe(value);
    case "object":
      return isObject(value) ? null : describe(value);
    case "list":
      return null;
    default:
      rule satisfies never;
      return panic("A field rule without a rendering");
  }
};

const renderField = (rule: FieldRule, rendering: Rendering) => {
  const { value, path, out } = rendering;
  const token = scalar(rule, value, rendering.fingerprint);
  if (token !== null) {
    out.push(`${path}=${token}`);
    return;
  }
  if (rule.type === "object" && isObject(value)) {
    renderShape(rule.shape, { ...rendering, value });
    return;
  }
  out.push(`${path}=${describe(value)}`);
  if (rule.type === "list" && Array.isArray(value)) {
    const item: FieldRule = { type: "object", shape: rule.shape };
    for (const [index, entry] of value
      .slice(0, PROTOCOL_LOG_LIST_ITEMS)
      .entries()) {
      renderField(item, {
        ...rendering,
        value: entry,
        path: `${path}[${String(index)}]`,
      });
    }
  }
};

/** The case a variant's discriminator selects, when it names one. */
const selectedCase = (
  variant: ShapeVariant,
  value: JsonObject,
): MessageShape | null => {
  const tag = value[variant.key];
  return typeof tag === "string" && Object.hasOwn(variant.cases, tag)
    ? (variant.cases[tag] ?? null)
    : null;
};

const renderShape = (
  { fields, variant }: MessageShape,
  rendering: ShapeRendering,
) => {
  const { value, path } = rendering;
  if (variant !== null && Object.hasOwn(value, variant.key)) {
    renderField(
      { type: "vocabulary", values: new Set(Object.keys(variant.cases)) },
      {
        ...rendering,
        value: value[variant.key],
        path: joinPath(path, variant.key),
      },
    );
  }
  for (const [key, rule] of Object.entries(fields)) {
    if (Object.hasOwn(value, key)) {
      renderField(rule, {
        ...rendering,
        value: value[key],
        path: joinPath(path, key),
      });
    }
  }
  const selected = variant === null ? null : selectedCase(variant, value);
  if (selected !== null) {
    renderShape(selected, rendering);
  }
};

/** The top-level keys the allowlist names for this value. */
const listedKeys = ({ fields, variant }: MessageShape, value: JsonObject) => {
  const keys = new Set(Object.keys(fields));
  if (variant !== null) {
    keys.add(variant.key);
    const selected = selectedCase(variant, value);
    if (selected !== null) {
      for (const key of listedKeys(selected, value)) {
        keys.add(key);
      }
    }
  }
  return keys;
};

type RedactOptions = {
  channel: ProtocolChannel;
  direction: ProtocolDirection;
  /** One parsed protocol message. */
  message: unknown;
  /** The holder's fingerprint key (`ProtocolLog`). */
  fingerprintKey: Uint8Array;
};

/**
 * One message as log fields, `path=value` separated by spaces: only what the
 * allowlist keeps, then how many top-level fields it did not show.
 */
export const redactProtocolMessage = ({
  channel,
  direction,
  message,
  fingerprintKey,
}: RedactOptions): string => {
  if (!isObject(message)) {
    return `message=${describe(message)}`;
  }
  const allowlist = PROTOCOL_ALLOWLISTS[channel][direction];
  const out: string[] = [];
  renderShape(allowlist, {
    value: message,
    path: "",
    out,
    fingerprint: keyedFingerprint(fingerprintKey),
  });
  const listed = listedKeys(allowlist, message);
  const unlisted = Object.keys(message).filter((key) => !listed.has(key));
  if (unlisted.length > 0) {
    out.push(`unlisted=${String(unlisted.length)}`);
  }
  return out.join(" ");
};

/** Bytes of a fingerprint key. */
export const PROTOCOL_LOG_KEY_BYTES = 32;

/**
 * Where protocol lines go: nowhere unless the member turned the log on. The
 * fingerprint key is random per holder process and kept in memory only, so
 * fingerprints pair up within one holder's log and nobody holding the log
 * can test a guessed value against them.
 */
export type ProtocolLog =
  | { type: "off" }
  | {
      type: "redacted";
      log: (line: string) => void;
      fingerprintKey: Uint8Array;
    };

export const PROTOCOL_LOG_OFF = { type: "off" } as const satisfies ProtocolLog;

/** Hands one line as written on the wire, newline or not, to the log. */
type ProtocolTap = (direction: ProtocolDirection, line: string) => void;

type ProtocolTapOptions = {
  channel: ProtocolChannel;
  /** Which process or connection, such as `pid=4242`. */
  source: string;
};

const ignore: ProtocolTap = () => undefined;

export const protocolTap = (
  protocolLog: ProtocolLog,
  { channel, source }: ProtocolTapOptions,
): ProtocolTap => {
  switch (protocolLog.type) {
    case "off":
      return ignore;
    case "redacted": {
      // Lines the log could not take, reported on the next one it takes.
      const state = { dropped: 0 };
      return (direction, line) => {
        const text = line.endsWith("\n") ? line.slice(0, -1) : line;
        const parsed = Result.try((): unknown => JSON.parse(text));
        const fields = Result.isOk(parsed)
          ? redactProtocolMessage({
              channel,
              direction,
              message: parsed.value,
              fingerprintKey: protocolLog.fingerprintKey,
            })
          : "not_json";
        const entry = `protocol ${channel} ${source} ${direction} ${fields} bytes=${band(Buffer.byteLength(text))}`;
        // A diagnostic line must never change how a run goes: a failed
        // write is counted and reported once the log takes a line again.
        const written = Result.try(() => {
          protocolLog.log(
            state.dropped === 0
              ? entry
              : `${entry} dropped=${String(state.dropped)}`,
          );
        });
        state.dropped = Result.isOk(written) ? 0 : state.dropped + 1;
      };
    }
    default:
      protocolLog satisfies never;
      return panic("A protocol log setting without a tap");
  }
};
