import * as v from "valibot";

/**
 * The part of the `codex app-server` protocol (JSON-RPC over stdio, one JSON
 * object per line, no `jsonrpc` member) this adapter consumes. Unknown fields
 * are dropped; a known message with the wrong shape is a protocol violation.
 * `real-codex.test.ts` binds the method and item lists below to the schema
 * an installed CLI generates, so an upstream change fails a test.
 */

const RequestId = v.union([v.string(), v.number()]);
export type CodexRequestId = v.InferOutput<typeof RequestId>;

export const JsonRpcMessageSchema = v.union([
  v.object({
    id: RequestId,
    method: v.string(),
    params: v.optional(v.unknown()),
  }),
  v.object({
    id: RequestId,
    error: v.object({ code: v.number(), message: v.string() }),
  }),
  v.object({ id: RequestId, result: v.unknown() }),
  v.object({ method: v.string(), params: v.optional(v.unknown()) }),
]);

export const InitializeResponseSchema = v.object({
  userAgent: v.string(),
  codexHome: v.string(),
});

export const GetAccountResponseSchema = v.object({
  account: v.nullable(
    v.object({ type: v.string(), planType: v.nullish(v.string()) }),
  ),
  requiresOpenaiAuth: v.boolean(),
});

export const ModelListResponseSchema = v.object({
  data: v.array(
    v.object({
      id: v.string(),
      displayName: v.string(),
      hidden: v.boolean(),
      isDefault: v.boolean(),
      supportedReasoningEfforts: v.array(
        v.object({ reasoningEffort: v.string() }),
      ),
      inputModalities: v.array(v.string()),
    }),
  ),
  nextCursor: v.nullable(v.string()),
});

export const ThreadResponseSchema = v.object({
  thread: v.object({ id: v.string() }),
});

const TurnStatusSchema = v.picklist([
  "completed",
  "interrupted",
  "failed",
  "inProgress",
]);

const TurnErrorSchema = v.object({
  message: v.string(),
  /** Open upstream: known string codes, object variants, and new strings. */
  codexErrorInfo: v.nullable(
    v.union([v.string(), v.record(v.string(), v.unknown())]),
  ),
});
export type CodexTurnError = v.InferOutput<typeof TurnErrorSchema>;

const TurnSchema = v.object({
  id: v.string(),
  status: TurnStatusSchema,
  error: v.nullish(TurnErrorSchema),
  startedAt: v.nullish(v.number()),
});

export const TurnStartResponseSchema = v.object({ turn: TurnSchema });

/**
 * Every thread item kind the pinned protocol defines. `real-codex.test.ts`
 * binds this list to the schema the installed CLI generates; what Stella does
 * with each kind is decided in `items.ts`.
 */
export const CODEX_ITEM_TYPES = [
  "userMessage",
  "hookPrompt",
  "agentMessage",
  "functionCallOutput",
  "plan",
  "reasoning",
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "collabAgentToolCall",
  "subAgentActivity",
  "webSearch",
  "imageView",
  "sleep",
  "imageGeneration",
  "enteredReviewMode",
  "exitedReviewMode",
  "contextCompaction",
] as const;
export type CodexItemType = (typeof CODEX_ITEM_TYPES)[number];

const CODEX_ITEM_TYPE_SET: ReadonlySet<string> = new Set(CODEX_ITEM_TYPES);

export const isCodexItemType = (type: string): type is CodexItemType =>
  CODEX_ITEM_TYPE_SET.has(type);

const McpContentBlock = v.object({
  type: v.string(),
  text: v.optional(v.string()),
});

export const CodexItemSchema = v.variant("type", [
  v.object({
    type: v.literal("agentMessage"),
    id: v.string(),
    text: v.string(),
    delivery: v.nullish(v.literal("async")),
    questions: v.nullish(
      v.array(
        v.object({
          title: v.string(),
          options: v.nullable(v.array(v.string())),
        }),
      ),
    ),
  }),
  v.object({
    type: v.literal("reasoning"),
    id: v.string(),
    summary: v.array(v.string()),
    content: v.array(v.string()),
  }),
  v.object({
    type: v.literal("commandExecution"),
    id: v.string(),
    command: v.string(),
    status: v.picklist(["inProgress", "completed", "failed", "declined"]),
    aggregatedOutput: v.nullish(v.string()),
    exitCode: v.nullish(v.number()),
  }),
  v.object({
    type: v.literal("fileChange"),
    id: v.string(),
    changes: v.array(
      v.object({
        path: v.string(),
        kind: v.object({ type: v.picklist(["add", "delete", "update"]) }),
      }),
    ),
    status: v.picklist(["inProgress", "completed", "failed", "declined"]),
  }),
  v.object({
    type: v.literal("mcpToolCall"),
    id: v.string(),
    server: v.string(),
    tool: v.string(),
    status: v.picklist(["inProgress", "completed", "failed"]),
    arguments: v.unknown(),
    // Optional in the pinned schema: an item may omit what it does not have.
    result: v.nullish(
      v.object({
        content: v.array(v.unknown()),
        structuredContent: v.nullish(v.unknown()),
      }),
    ),
    error: v.nullish(v.object({ message: v.string() })),
  }),
  v.object({ type: v.literal("webSearch"), id: v.string(), query: v.string() }),
]);
export type CodexItem = v.InferOutput<typeof CodexItemSchema>;

export const isMcpTextBlock = (
  block: unknown,
): block is v.InferOutput<typeof McpContentBlock> =>
  v.is(McpContentBlock, block);

/** The first item fields, read before the kind decides the full schema. */
const ItemEnvelopeSchema = v.object({
  threadId: v.string(),
  turnId: v.string(),
  item: v.object({ type: v.string(), id: v.optional(v.string()) }),
});

/** Notifications this adapter consumes; every other method is ignored. */
export const CODEX_NOTIFICATIONS = {
  "turn/started": v.object({ threadId: v.string(), turn: TurnSchema }),
  "turn/completed": v.object({ threadId: v.string(), turn: TurnSchema }),
  "item/started": ItemEnvelopeSchema,
  "item/completed": ItemEnvelopeSchema,
  "item/agentMessage/delta": v.object({
    threadId: v.string(),
    turnId: v.string(),
    itemId: v.string(),
    delta: v.string(),
  }),
  error: v.object({
    threadId: v.string(),
    turnId: v.string(),
    willRetry: v.boolean(),
    error: TurnErrorSchema,
  }),
  "thread/tokenUsage/updated": v.object({
    threadId: v.string(),
    turnId: v.string(),
    tokenUsage: v.object({
      last: v.object({
        inputTokens: v.number(),
        cachedInputTokens: v.number(),
        outputTokens: v.number(),
        reasoningOutputTokens: v.number(),
      }),
    }),
  }),
  "serverRequest/resolved": v.object({
    threadId: v.string(),
    requestId: RequestId,
  }),
  "account/rateLimits/updated": v.object({
    rateLimits: v.object({
      limitId: v.nullish(v.string()),
      primary: v.nullish(
        v.object({ usedPercent: v.number(), resetsAt: v.nullish(v.number()) }),
      ),
      secondary: v.nullish(
        v.object({ usedPercent: v.number(), resetsAt: v.nullish(v.number()) }),
      ),
    }),
  }),
} as const;
export type CodexNotificationMethod = keyof typeof CODEX_NOTIFICATIONS;

export type CodexRateLimits = v.InferOutput<
  (typeof CODEX_NOTIFICATIONS)["account/rateLimits/updated"]
>["rateLimits"];

export const isCodexNotificationMethod = (
  method: string,
): method is CodexNotificationMethod =>
  Object.hasOwn(CODEX_NOTIFICATIONS, method);

const ApprovalTarget = {
  threadId: v.string(),
  turnId: v.string(),
  itemId: v.string(),
  reason: v.nullish(v.string()),
};

/**
 * Every request the server can send, and how Stella answers it. `approval`
 * and `question` reach the user; `decline` and `refuse` are answered at once
 * because Stella never enables what would make them meaningful.
 */
export const CODEX_SERVER_REQUESTS = {
  "item/commandExecution/requestApproval": {
    handling: "approval",
    params: v.object({ ...ApprovalTarget, command: v.nullish(v.string()) }),
  },
  "item/fileChange/requestApproval": {
    handling: "approval",
    params: v.object(ApprovalTarget),
  },
  "item/permissions/requestApproval": {
    handling: "approval",
    params: v.object({
      ...ApprovalTarget,
      permissions: v.object({
        network: v.nullish(v.unknown()),
        fileSystem: v.nullish(v.unknown()),
      }),
    }),
  },
  "item/tool/requestUserInput": {
    handling: "question",
    params: v.object({
      threadId: v.string(),
      turnId: v.string(),
      itemId: v.string(),
      questions: v.array(
        v.object({
          id: v.string(),
          header: v.string(),
          question: v.string(),
          isOther: v.boolean(),
          isSecret: v.boolean(),
          options: v.nullable(
            v.array(v.object({ label: v.string(), description: v.string() })),
          ),
        }),
      ),
    }),
  },
  // Stella's MCP server never elicits input from the client.
  "mcpServer/elicitation/request": {
    handling: "decline",
    response: { action: "decline", content: null, _meta: null },
  },
  // No dynamic tools are registered.
  "item/tool/call": {
    handling: "decline",
    response: { contentItems: [], success: false },
  },
  // The v1 approval flow is not used by turns started through `turn/start`.
  applyPatchApproval: { handling: "decline", response: { decision: "abort" } },
  execCommandApproval: { handling: "decline", response: { decision: "abort" } },
  // Credentials stay in the harness's own store; Stella supplies none.
  "account/chatgptAuthTokens/refresh": { handling: "refuse" },
  // `initialize` does not opt into attestation.
  "attestation/generate": { handling: "refuse" },
} as const;
export type CodexServerRequestMethod = keyof typeof CODEX_SERVER_REQUESTS;

export const isCodexServerRequestMethod = (
  method: string,
): method is CodexServerRequestMethod =>
  Object.hasOwn(CODEX_SERVER_REQUESTS, method);

/** JSON-RPC "method not found". */
export const METHOD_NOT_FOUND = -32_601;

/** `initialize` capabilities; diffs are not consumed, so opt out of them. */
export const CODEX_OPT_OUT_NOTIFICATIONS = ["turn/diff/updated"] as const;
