import { Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";
import * as v from "valibot";

import {
  STELLA_MCP_APP_LIMITS,
  stellaMcpAppPartSchema,
  stellaMcpAppToolCallSchema,
  stellaMcpAppToolResultSchema,
} from "@stll/api-contract/stella-mcp-app";
import type { StellaMcpAppToolResult } from "@stll/api-contract/stella-mcp-app";
import { workspaceIsVisible } from "@stll/api-contract/workspace-status";

import type { SafeDb } from "@/api/db/safe-db";
import { chatMessages, chatThreads } from "@/api/db/schema";
import { normalizePersistedChatMessageContent } from "@/api/handlers/chat/chat-message-parts";
import {
  appMayCall,
  appPresentsTool,
  chatMcpAppByUri,
} from "@/api/handlers/chat/mcp-apps/catalog";
import { resolveToolWorkspaceIds } from "@/api/handlers/chat/tools/authorized-workspace-ids";
import { buildMcpContextFromChat } from "@/api/handlers/chat/tools/registry-adapter/mcp-chat-context";
import type { RegistryReadToolName } from "@/api/handlers/chat/tools/registry-adapter/ref-field-map";
import {
  executeRegistryRead,
  isRegistryReadToolName,
} from "@/api/handlers/chat/tools/registry-adapter/run-registry-tool";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { resolveCredentialMemberExecutionContext } from "@/api/lib/chat/credential-member-execution-context";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { readBounded } from "@/api/lib/db/read-bounded";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { isMemberRole } from "@/api/lib/member-roles";
import type { AuthorizedMemberRole } from "@/api/lib/permission-authorization";
import { withCurrentMemberRole } from "@/api/lib/permission-authorization";
import type { McpErrorCode } from "@/api/mcp/error-codes";
import { getStaticMcpToolOutputContract } from "@/api/mcp/static-tool-definitions";
import { serializeToolResult } from "@/api/mcp/tool-utils";

const config = {
  contract: "patch",
  permissions: { chat: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "chat_thread_ui" },
  params: v.object({
    threadId: resourceIdSchema("chatThread"),
    toolCallId: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
  }),
  // Validated inside the handler so a refusal never echoes the arguments.
  body: v.unknown(),
  contentDelivery: {
    type: "none",
    reason:
      "Answers an app's read in the MCP result shape; it returns no stored-file grant.",
  },
} satisfies HandlerConfig;

const refusal = (
  code: McpErrorCode,
  message: string,
): StellaMcpAppToolResult => ({
  content: [
    { type: "text", text: JSON.stringify({ error: { code, message } }) },
  ],
  isError: true,
});

type ShownAppLookup = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  threadId: SafeId<"chatThread">;
  toolCallId: string;
};

/**
 * The stella app part this member's thread stores for the call. The thread
 * and its messages are the member's own; a part another member's thread
 * holds, or one that was never stored, is not found.
 */
const readShownApp = async ({
  safeDb,
  organizationId,
  userId,
  threadId,
  toolCallId,
}: ShownAppLookup) =>
  await safeDb(async (tx) => {
    // A call id names one call of the thread; a second message claiming the
    // same id leaves the app unresolved rather than picking one.
    const read = await readBounded(
      tx
        .select({ id: chatMessages.id, content: chatMessages.content })
        .from(chatMessages)
        .innerJoin(chatThreads, eq(chatThreads.id, chatMessages.threadId))
        .where(
          and(
            eq(chatMessages.threadId, threadId),
            eq(chatMessages.userId, userId),
            eq(chatMessages.role, "assistant"),
            eq(chatThreads.userId, userId),
            eq(chatThreads.organizationId, organizationId),
            sql`${chatMessages.content} -> 'data' @> ${JSON.stringify([
              { type: "ui-resource", toolCallId },
            ])}::text::jsonb`,
          ),
        ),
      1,
    );
    if (read.type === "overflow") {
      return null;
    }
    for (const row of read.rows) {
      const parts = normalizePersistedChatMessageContent(
        row.content,
        row.id,
      ).parts;
      for (const part of parts) {
        const parsed = v.safeParse(stellaMcpAppPartSchema, part);
        if (parsed.success && parsed.output.toolCallId === toolCallId) {
          return parsed.output;
        }
      }
    }
    return null;
  });

const callArgumentsFit = (body: unknown) => {
  const serialized = Result.try(() => JSON.stringify(body));
  return (
    Result.isOk(serialized) &&
    typeof serialized.value === "string" &&
    new TextEncoder().encode(serialized.value).byteLength <=
      STELLA_MCP_APP_LIMITS.callArgumentsBytes
  );
};

type MemberReadOptions = {
  name: RegistryReadToolName;
  args: Record<string, unknown>;
  memberRole: AuthorizedMemberRole;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};

/**
 * Run one read as this member, as a fresh MCP call by them would: their
 * current membership, matters and features, the read's own gates, and the
 * MCP result shape the app parses.
 */
export const runMemberRead = async ({
  name,
  args,
  memberRole,
  organizationId,
  userId,
}: MemberReadOptions): Promise<StellaMcpAppToolResult> => {
  const current = await resolveCredentialMemberExecutionContext({
    organizationId,
    userId,
  });
  if (Result.isError(current)) {
    return refusal("internal_error", "Your access could not be confirmed.");
  }
  const execution = current.value;
  if (execution === null || !isMemberRole(execution.role)) {
    return refusal(
      "permission_denied",
      "You are no longer a member of this organization.",
    );
  }
  const usable = execution.accessibleWorkspaces.filter(({ status }) =>
    workspaceIsVisible(status),
  );
  const context = buildMcpContextFromChat({
    organizationId,
    userId,
    userEmail: execution.userEmail,
    featureAccessSnapshot: execution.featureAccessSnapshot,
    memberRole: withCurrentMemberRole(memberRole, execution.role),
    pinServerValidatedWorkspaceId: execution.pinServerValidatedWorkspaceId,
    safeDb: execution.safeDb,
    scopedDb: execution.scopedDb,
    toolWorkspaceIds: resolveToolWorkspaceIds({
      pinnedIds: [],
      accessibleWorkspaceIds: usable.map(({ id }) => id),
    }),
    workspaceStatusById: new Map(usable.map(({ id, status }) => [id, status])),
  });
  const outcome = await executeRegistryRead({ toolName: name, args, context });
  if (outcome.type === "refused") {
    return refusal("permission_denied", outcome.error.message);
  }
  const wire = serializeToolResult(
    outcome.result,
    getStaticMcpToolOutputContract(name),
    name,
  );
  const parsed = v.safeParse(stellaMcpAppToolResultSchema, {
    content: wire.content,
    ...(wire.structuredContent === undefined
      ? {}
      : { structuredContent: wire.structuredContent }),
    ...(wire.isError === undefined ? {} : { isError: wire.isError }),
  });
  return parsed.success
    ? parsed.output
    : refusal("internal_error", "The app call answered in an unknown shape.");
};

type CallDependencies = {
  runRead?: (options: MemberReadOptions) => Promise<StellaMcpAppToolResult>;
};

/**
 * Answer one call an app sent back through its host. The app may call only
 * what its manifest lists; nothing in the request widens that. A call the
 * list allows runs as a read by this member.
 */
export const createCallChatMcpAppTool = ({
  runRead = runMemberRead,
}: CallDependencies = {}) =>
  createSafeRootHandler(
    config,
    async function* ({ body, memberRole, params, safeDb, session, user }) {
      const call = v.safeParse(stellaMcpAppToolCallSchema, body);
      if (!call.success || !callArgumentsFit(body)) {
        return Result.ok(
          refusal(
            "validation_error",
            "Send a tool name and arguments within the call size limit.",
          ),
        );
      }
      const shown = yield* Result.await(
        readShownApp({
          safeDb,
          organizationId: session.activeOrganizationId,
          userId: user.id,
          threadId: params.threadId,
          toolCallId: params.toolCallId,
        }),
      );
      const app =
        shown === null ? undefined : chatMcpAppByUri(shown.resource.uri);
      if (
        shown === null ||
        app === undefined ||
        !appPresentsTool(app, shown.toolName)
      ) {
        return Result.err(
          new HandlerError({
            status: 404,
            code: "not_found",
            message: "App not found",
          }),
        );
      }
      const { name } = call.output;
      // The link handoff is on every list; a signed-in browser opens links
      // itself, so the server never mints one for an app in chat.
      if (!appMayCall(app, name) || !isRegistryReadToolName(name)) {
        return Result.ok(
          refusal("permission_denied", `This app cannot call ${name}.`),
        );
      }
      return Result.ok(
        await runRead({
          name,
          args: call.output.arguments,
          memberRole,
          organizationId: session.activeOrganizationId,
          userId: user.id,
        }),
      );
    },
  );

const callChatMcpAppTool = createCallChatMcpAppTool();

declareAggregateMutation(callChatMcpAppTool, {
  type: "independent",
  reason:
    "Runs one read an app asks for and writes nothing; the POST only carries the app's arguments.",
});

export default callChatMcpAppTool;
