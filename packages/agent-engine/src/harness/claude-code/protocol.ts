import * as v from "valibot";

/**
 * The part of the Claude Code CLI's stream-json protocol (one JSON object per
 * line on stdin and stdout, `--input-format stream-json --output-format
 * stream-json`) this adapter consumes. Conversation messages arrive by `type`;
 * `control_request` / `control_response` pairs carry the side channel the
 * Agent SDK uses (initialize, permission prompts, interrupt). Unknown fields
 * are dropped; a known message with the wrong shape is a protocol violation.
 */

const RequestId = v.pipe(v.string(), v.nonEmpty());

/** The fields every stdout line is read by before its type decides the rest. */
export const ClaudeOutputEnvelopeSchema = v.looseObject({ type: v.string() });

export const ControlRequestSchema = v.object({
  type: v.literal("control_request"),
  request_id: RequestId,
  request: v.looseObject({ subtype: v.string() }),
});

export const ControlResponseSchema = v.object({
  type: v.literal("control_response"),
  response: v.variant("subtype", [
    v.object({
      subtype: v.literal("success"),
      request_id: RequestId,
      response: v.optional(v.unknown()),
    }),
    v.object({
      subtype: v.literal("error"),
      request_id: RequestId,
      error: v.string(),
    }),
  ]),
});

export const ControlCancelRequestSchema = v.object({
  type: v.literal("control_cancel_request"),
  request_id: RequestId,
});

export const InitializeResponseSchema = v.object({
  models: v.array(
    v.object({
      value: v.string(),
      displayName: v.string(),
      supportedEffortLevels: v.optional(v.array(v.string())),
    }),
  ),
  account: v.object({
    /** `none` when no subscription sign-in is present. */
    tokenSource: v.optional(v.string()),
    /** Where an API key would come from; `none` when no key is in use. */
    apiKeySource: v.optional(v.string()),
    subscriptionType: v.optional(v.string()),
    apiProvider: v.optional(v.string()),
  }),
  claude_code_version: v.optional(v.string()),
});

export const McpSetServersResponseSchema = v.object({
  added: v.array(v.string()),
  errors: v.record(v.string(), v.string()),
});

const UsageWindowSchema = v.nullish(
  v.object({
    /** Percentage of the window used, 0-100. */
    utilization: v.nullable(v.number()),
    /** ISO 8601. */
    resets_at: v.nullable(v.string()),
  }),
);

/** `get_usage`: experimental upstream; only the plan's main windows are read. */
export const GetUsageResponseSchema = v.object({
  rate_limits_available: v.boolean(),
  rate_limits: v.nullable(
    v.object({ five_hour: UsageWindowSchema, seven_day: UsageWindowSchema }),
  ),
});
export type ClaudeUsageWindows = NonNullable<
  v.InferOutput<typeof GetUsageResponseSchema>["rate_limits"]
>;

/**
 * Every top-level message type the pinned CLI writes besides the control
 * channel. What Stella does with each is decided in `items.ts`; a type not
 * listed here is reported as an unsupported item.
 */
const CLAUDE_MESSAGE_TYPES = [
  "assistant",
  "user",
  "result",
  "system",
  "stream_event",
  "rate_limit_event",
  "auth_status",
  "tool_progress",
  "tool_use_summary",
  "prompt_suggestion",
  "conversation_reset",
  "active_goal",
  "keep_alive",
] as const;
export type ClaudeMessageType = (typeof CLAUDE_MESSAGE_TYPES)[number];

const CLAUDE_MESSAGE_TYPE_SET: ReadonlySet<string> = new Set(
  CLAUDE_MESSAGE_TYPES,
);

export const isClaudeMessageType = (type: string): type is ClaudeMessageType =>
  CLAUDE_MESSAGE_TYPE_SET.has(type);

/** Every `system` message subtype the pinned CLI writes. */
const CLAUDE_SYSTEM_SUBTYPES = [
  "init",
  "api_retry",
  "status",
  "compact_boundary",
  "control_request_progress",
  "model_refusal_fallback",
  "model_refusal_no_fallback",
  "local_command_output",
  "hook_started",
  "hook_progress",
  "hook_response",
  "plugin_install",
  "task_started",
  "task_updated",
  "task_progress",
  "task_notification",
  "background_tasks_changed",
  "thinking_tokens",
  "session_state_changed",
  "worker_shutting_down",
  "commands_changed",
  "notification",
  "files_persisted",
  "memory_recall",
  "elicitation_complete",
  "permission_denied",
  "mirror_error",
  "informational",
] as const;
export type ClaudeSystemSubtype = (typeof CLAUDE_SYSTEM_SUBTYPES)[number];

const CLAUDE_SYSTEM_SUBTYPE_SET: ReadonlySet<string> = new Set(
  CLAUDE_SYSTEM_SUBTYPES,
);

export const isClaudeSystemSubtype = (
  subtype: string,
): subtype is ClaudeSystemSubtype => CLAUDE_SYSTEM_SUBTYPE_SET.has(subtype);

/** Content blocks the CLI's assistant messages carry, Messages API shaped. */
const CLAUDE_CONTENT_BLOCK_TYPES = [
  "text",
  "thinking",
  "redacted_thinking",
  "tool_use",
] as const;
type ClaudeContentBlockType = (typeof CLAUDE_CONTENT_BLOCK_TYPES)[number];

const CLAUDE_CONTENT_BLOCK_TYPE_SET: ReadonlySet<string> = new Set(
  CLAUDE_CONTENT_BLOCK_TYPES,
);

export const isClaudeContentBlockType = (
  type: string,
): type is ClaudeContentBlockType => CLAUDE_CONTENT_BLOCK_TYPE_SET.has(type);

export const ContentBlockSchema = v.variant("type", [
  v.object({ type: v.literal("text"), text: v.string() }),
  v.object({ type: v.literal("thinking"), thinking: v.string() }),
  v.object({ type: v.literal("redacted_thinking") }),
  v.object({
    type: v.literal("tool_use"),
    id: v.string(),
    name: v.string(),
    input: v.record(v.string(), v.unknown()),
  }),
]);
type ClaudeContentBlock = v.InferOutput<typeof ContentBlockSchema>;
export type ClaudeToolUse = Extract<ClaudeContentBlock, { type: "tool_use" }>;

/** A subagent's messages carry the tool call that started it. */
const ParentToolUseId = v.nullish(v.string());

export const AssistantMessageSchema = v.object({
  type: v.literal("assistant"),
  message: v.object({
    id: v.string(),
    content: v.array(v.looseObject({ type: v.string() })),
  }),
  parent_tool_use_id: ParentToolUseId,
  /** Set on the synthetic message an API failure produces. */
  error: v.optional(v.string()),
});

const TextBlockSchema = v.object({
  type: v.string(),
  text: v.optional(v.string()),
});

export const ToolResultBlockSchema = v.object({
  type: v.literal("tool_result"),
  tool_use_id: v.string(),
  content: v.optional(v.union([v.string(), v.array(TextBlockSchema)])),
  is_error: v.optional(v.boolean()),
});
export type ClaudeToolResult = v.InferOutput<typeof ToolResultBlockSchema>;

export const UserMessageSchema = v.object({
  type: v.literal("user"),
  message: v.object({
    content: v.union([
      v.string(),
      v.array(v.looseObject({ type: v.string() })),
    ]),
  }),
  parent_tool_use_id: ParentToolUseId,
});

export const ResultMessageSchema = v.object({
  type: v.literal("result"),
  subtype: v.string(),
  is_error: v.boolean(),
  result: v.optional(v.string()),
  errors: v.optional(v.array(v.string())),
  api_error_status: v.nullish(v.number()),
  usage: v.optional(
    v.object({
      input_tokens: v.number(),
      output_tokens: v.number(),
      cache_creation_input_tokens: v.nullish(v.number()),
      cache_read_input_tokens: v.nullish(v.number()),
    }),
  ),
});
export type ClaudeResultMessage = v.InferOutput<typeof ResultMessageSchema>;

export const SystemMessageSchema = v.object({
  type: v.literal("system"),
  subtype: v.string(),
});

export const ApiRetryMessageSchema = v.object({
  attempt: v.number(),
  max_retries: v.number(),
  error: v.string(),
});

export const StreamEventMessageSchema = v.object({
  type: v.literal("stream_event"),
  parent_tool_use_id: ParentToolUseId,
  event: v.looseObject({ type: v.string() }),
});

/** The raw stream events that carry the answer's text as it is written. */
export const STREAM_EVENTS = {
  message_start: v.object({ message: v.object({ id: v.string() }) }),
  content_block_start: v.object({
    index: v.number(),
    content_block: v.object({ type: v.string() }),
  }),
  content_block_delta: v.object({
    index: v.number(),
    delta: v.object({ type: v.string(), text: v.optional(v.string()) }),
  }),
} as const;

export const RateLimitEventSchema = v.object({
  type: v.literal("rate_limit_event"),
  rate_limit_info: v.object({
    status: v.string(),
    /** Unix seconds. */
    resetsAt: v.optional(v.number()),
    rateLimitType: v.optional(v.string()),
  }),
});
export type ClaudeRateLimitInfo = v.InferOutput<
  typeof RateLimitEventSchema
>["rate_limit_info"];

export const CanUseToolRequestSchema = v.object({
  subtype: v.literal("can_use_tool"),
  tool_name: v.string(),
  input: v.record(v.string(), v.unknown()),
  tool_use_id: v.string(),
  permission_suggestions: v.optional(
    v.array(v.looseObject({ type: v.string() })),
  ),
  decision_reason: v.optional(v.string()),
  title: v.optional(v.string()),
  description: v.optional(v.string()),
});

/**
 * Every request the CLI sends on the control channel, and how Stella answers
 * it. `prompt` reaches the user; `decline` and `refuse` are answered at once
 * because Stella never enables what would make them meaningful.
 */
export const CLAUDE_CONTROL_REQUESTS = {
  can_use_tool: { handling: "prompt" },
  // MCP servers never elicit through the client; stella's enforces its own.
  elicitation: { handling: "decline", response: { action: "decline" } },
  // No hooks are registered on initialize.
  hook_callback: { handling: "refuse" },
  // No in-process (SDK) MCP servers are registered.
  mcp_message: { handling: "refuse" },
  // No dialog kinds are declared on initialize.
  request_user_dialog: { handling: "refuse" },
} as const;
export type ClaudeControlRequestSubtype = keyof typeof CLAUDE_CONTROL_REQUESTS;

export const isClaudeControlRequestSubtype = (
  subtype: string,
): subtype is ClaudeControlRequestSubtype =>
  Object.hasOwn(CLAUDE_CONTROL_REQUESTS, subtype);

export const AskUserQuestionInputSchema = v.object({
  questions: v.array(
    v.object({
      question: v.string(),
      header: v.string(),
      options: v.array(
        v.object({ label: v.string(), description: v.string() }),
      ),
      multiSelect: v.optional(v.boolean()),
    }),
  ),
});
