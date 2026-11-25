import * as v from "valibot";

/**
 * The part of the Agent Client Protocol (JSON-RPC 2.0 over stdio, one JSON
 * object per line; protocol version 1) this adapter consumes. Parsing is
 * lenient where agents differ: unknown fields are dropped, an unknown
 * `session/update` kind is ignored, and optional fields may be absent or
 * `null`. A known message whose required fields are missing is a protocol
 * violation.
 */

export const ACP_PROTOCOL_VERSION = 1;

/** How stella introduces itself in `initialize`. */
export const ACP_CLIENT_INFO = { name: "stella", title: "stella" } as const;

const RequestId = v.union([v.string(), v.number()]);
export type AcpRequestId = v.InferOutput<typeof RequestId>;

export const AcpJsonRpcMessageSchema = v.union([
  v.object({
    id: RequestId,
    method: v.string(),
    params: v.optional(v.unknown()),
  }),
  v.object({
    id: v.nullable(RequestId),
    error: v.object({
      code: v.number(),
      message: v.string(),
      data: v.optional(v.unknown()),
    }),
  }),
  // An answer carries a result, `null` included; one with neither a result
  // nor a well-formed error is not an answer.
  v.pipe(
    v.looseObject({ id: RequestId, result: v.unknown() }),
    v.check((message) => Object.hasOwn(message, "result")),
    v.transform(({ id, result }) => ({ id, result })),
  ),
  v.object({ method: v.string(), params: v.optional(v.unknown()) }),
]);

/** JSON-RPC error codes ACP gives a meaning. */
export const ACP_ERROR = {
  authRequired: -32_000,
  resourceNotFound: -32_002,
  invalidRequest: -32_600,
  methodNotFound: -32_601,
  invalidParams: -32_602,
  internalError: -32_603,
} as const;

/** Requests stella sends the agent. */
const ACP_CLIENT_REQUESTS = [
  "initialize",
  "authenticate",
  "session/new",
  "session/load",
  "session/resume",
  "session/prompt",
  "session/set_mode",
  "session/set_model",
  "session/set_config_option",
] as const;
export type AcpClientRequestMethod = (typeof ACP_CLIENT_REQUESTS)[number];

const ACP_CLIENT_NOTIFICATIONS = ["session/cancel"] as const;
export type AcpClientNotificationMethod =
  (typeof ACP_CLIENT_NOTIFICATIONS)[number];

/** Requests the agent sends stella; any other is answered "not found". */
export const ACP_AGENT_REQUESTS = {
  requestPermission: "session/request_permission",
} as const;

export const ACP_AGENT_NOTIFICATIONS = {
  update: "session/update",
  /** The agent withdraws a request it sent, such as a permission request. */
  cancelRequest: "$/cancel_request",
} as const;

/** `$/cancel_request`: the request the agent stopped waiting for. */
export const AcpCancelRequestSchema = v.object({ requestId: RequestId });

const looseRecord = v.record(v.string(), v.unknown());

const NamedId = v.object({
  id: v.string(),
  name: v.string(),
  description: v.nullish(v.string()),
});

export const AcpInitializeResponseSchema = v.object({
  protocolVersion: v.number(),
  agentCapabilities: v.nullish(
    v.object({
      loadSession: v.nullish(v.boolean()),
      promptCapabilities: v.nullish(
        v.object({
          image: v.nullish(v.boolean()),
          audio: v.nullish(v.boolean()),
          embeddedContext: v.nullish(v.boolean()),
        }),
      ),
      mcpCapabilities: v.nullish(
        v.object({ http: v.nullish(v.boolean()), sse: v.nullish(v.boolean()) }),
      ),
      sessionCapabilities: v.nullish(
        v.object({
          resume: v.nullish(looseRecord),
          list: v.nullish(looseRecord),
          additionalDirectories: v.nullish(looseRecord),
        }),
      ),
    }),
  ),
  authMethods: v.nullish(v.array(NamedId)),
  agentInfo: v.nullish(
    v.object({
      name: v.string(),
      title: v.nullish(v.string()),
      version: v.string(),
    }),
  ),
});
export type AcpInitializeResponse = v.InferOutput<
  typeof AcpInitializeResponseSchema
>;

const SelectOption = v.object({
  value: v.string(),
  name: v.string(),
  description: v.nullish(v.string()),
});

/**
 * A session setting the agent offers. Options may come grouped; stella reads
 * them flat. A setting of another type than `select` is kept by id only.
 */
const ConfigOption = v.object({
  id: v.string(),
  name: v.nullish(v.string()),
  category: v.nullish(v.string()),
  type: v.nullish(v.string()),
  currentValue: v.nullish(v.unknown()),
  options: v.nullish(
    v.array(
      v.union([
        SelectOption,
        v.object({
          group: v.nullish(v.string()),
          name: v.nullish(v.string()),
          options: v.array(SelectOption),
        }),
      ]),
    ),
  ),
});
export type AcpConfigOption = v.InferOutput<typeof ConfigOption>;

/** What `session/new`, `session/load` and `session/resume` report. */
const SessionState = {
  modes: v.nullish(
    v.object({
      currentModeId: v.string(),
      availableModes: v.array(NamedId),
    }),
  ),
  models: v.nullish(
    v.object({
      currentModelId: v.string(),
      availableModels: v.array(
        v.object({
          modelId: v.string(),
          name: v.string(),
          description: v.nullish(v.string()),
        }),
      ),
    }),
  ),
  configOptions: v.nullish(v.array(ConfigOption)),
};

export const AcpNewSessionResponseSchema = v.object({
  sessionId: v.pipe(v.string(), v.nonEmpty()),
  ...SessionState,
});

/** `session/load` and `session/resume` may answer `null`. */
export const AcpOpenedSessionResponseSchema = v.nullish(v.object(SessionState));
export type AcpSessionState = v.InferOutput<
  typeof AcpOpenedSessionResponseSchema
>;

export const ACP_STOP_REASONS = [
  "end_turn",
  "max_tokens",
  "max_turn_requests",
  "refusal",
  "cancelled",
] as const;

export const AcpPromptResponseSchema = v.object({
  stopReason: v.string(),
  usage: v.nullish(
    v.object({
      inputTokens: v.nullish(v.number()),
      outputTokens: v.nullish(v.number()),
      cachedReadTokens: v.nullish(v.number()),
      thoughtTokens: v.nullish(v.number()),
    }),
  ),
});

/** A content block the agent wrote; only text is read as text. */
const ContentBlock = v.looseObject({ type: v.string() });
export type AcpContentBlock = v.InferOutput<typeof ContentBlock>;

export const acpBlockText = (block: AcpContentBlock): string | null => {
  const text: unknown = Reflect.get(block, "text");
  return block.type === "text" && typeof text === "string" ? text : null;
};

export const ACP_TOOL_KINDS = [
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "switch_mode",
  "other",
] as const;

export const ACP_TOOL_STATUSES = [
  "pending",
  "in_progress",
  "completed",
  "failed",
] as const;

const ToolCallContent = v.variant("type", [
  v.object({ type: v.literal("content"), content: ContentBlock }),
  v.object({
    type: v.literal("diff"),
    path: v.string(),
    oldText: v.nullish(v.string()),
    newText: v.string(),
  }),
  v.object({ type: v.literal("terminal"), terminalId: v.string() }),
]);
export type AcpToolCallContent = v.InferOutput<typeof ToolCallContent>;

const Location = v.object({ path: v.string(), line: v.nullish(v.number()) });
export type AcpLocation = v.InferOutput<typeof Location>;

/**
 * A tool call or an update to one. Every field but the id may be absent
 * (unchanged) or, on an update, `null` (cleared). A content entry of a kind
 * stella does not know is dropped, not refused.
 */
const AcpToolCallFieldsSchema = v.object({
  toolCallId: v.pipe(v.string(), v.nonEmpty()),
  title: v.nullish(v.string()),
  kind: v.nullish(v.string()),
  status: v.nullish(v.string()),
  content: v.nullish(v.array(v.unknown())),
  locations: v.nullish(v.array(Location)),
  rawInput: v.nullish(v.unknown()),
  rawOutput: v.nullish(v.unknown()),
  _meta: v.nullish(looseRecord),
});
export type AcpToolCallFields = v.InferOutput<typeof AcpToolCallFieldsSchema>;

export const parseToolCallContent = (
  entries: readonly unknown[],
): AcpToolCallContent[] =>
  entries.flatMap((entry) => {
    const parsed = v.safeParse(ToolCallContent, entry);
    return parsed.success ? [parsed.output] : [];
  });

const PlanEntry = v.object({
  content: v.string(),
  status: v.nullish(v.string()),
  priority: v.nullish(v.string()),
});

/** The `session/update` kinds stella reads; any other is ignored. */
export const AcpSessionUpdateSchema = v.variant("sessionUpdate", [
  v.object({
    sessionUpdate: v.literal("agent_message_chunk"),
    content: ContentBlock,
  }),
  v.object({
    sessionUpdate: v.literal("agent_thought_chunk"),
    content: ContentBlock,
  }),
  v.object({
    sessionUpdate: v.literal("user_message_chunk"),
    content: ContentBlock,
  }),
  v.object({
    sessionUpdate: v.literal("tool_call"),
    ...AcpToolCallFieldsSchema.entries,
  }),
  v.object({
    sessionUpdate: v.literal("tool_call_update"),
    ...AcpToolCallFieldsSchema.entries,
  }),
  v.object({ sessionUpdate: v.literal("plan"), entries: v.array(PlanEntry) }),
  v.object({
    sessionUpdate: v.literal("usage_update"),
    used: v.number(),
    size: v.number(),
  }),
  v.object({
    sessionUpdate: v.literal("current_mode_update"),
    currentModeId: v.string(),
  }),
]);
export type AcpSessionUpdate = v.InferOutput<typeof AcpSessionUpdateSchema>;

export const AcpSessionNotificationSchema = v.object({
  sessionId: v.string(),
  update: v.looseObject({ sessionUpdate: v.string() }),
});

export const ACP_PERMISSION_OPTION_KINDS = [
  "allow_once",
  "allow_always",
  "reject_once",
  "reject_always",
] as const;

export const AcpRequestPermissionSchema = v.object({
  sessionId: v.string(),
  toolCall: AcpToolCallFieldsSchema,
  options: v.array(
    v.object({
      optionId: v.pipe(v.string(), v.nonEmpty()),
      name: v.nullish(v.string()),
      kind: v.string(),
    }),
  ),
});

/** How stella answers a permission request. */
export type AcpPermissionOutcome =
  { outcome: "selected"; optionId: string } | { outcome: "cancelled" };

/** An MCP server a session connects to, in the shapes ACP defines. */
export type AcpMcpServer =
  | {
      type: "http";
      name: string;
      url: string;
      headers: { name: string; value: string }[];
    }
  | {
      name: string;
      command: string;
      args: string[];
      env: { name: string; value: string }[];
    };
