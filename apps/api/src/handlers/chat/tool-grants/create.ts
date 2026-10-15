import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { isGrantableChatTool } from "@stll/api-contract/chat-tool-grants";

import {
  chatThreads,
  chatToolGrants,
  mcpConnectors,
  mcpUserConnections,
} from "@/api/db/schema";
import {
  CHAT_TOOL_GRANTS_MAX,
  resolveExternalMcpGrantConnectorId,
} from "@/api/handlers/chat/tools/chat-tool-grants";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { isExternalMcpToolName } from "@/api/lib/mcp-upstream/namespace";

const config = {
  contract: "patch",
  permissions: { chat: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "chat_thread_ui" },
  body: t.Object({
    scope: t.Union([t.Literal("conversation"), t.Literal("always")]),
    /** The conversation the grant was given in. */
    threadId: tSafeId("chatThread"),
    toolName: t.String({ minLength: 1, maxLength: 128 }),
  }),
} satisfies HandlerConfig;

const notGrantable = () =>
  new HandlerError({
    status: 409,
    message: "This tool asks for approval on every call",
  });

/**
 * Store a standing approval for one tool (or, for an external connector tool,
 * for its connector). The API decides what the grant covers and refuses tools
 * whose grant policy requires approval on every call.
 */
const createChatToolGrant = createSafeRootHandler(
  config,
  async function* ({
    body: { scope, threadId, toolName },
    recordAuditEvent,
    safeDb,
    session,
    user,
  }) {
    if (!isGrantableChatTool(toolName)) {
      return Result.err(notGrantable());
    }
    const organizationId = session.activeOrganizationId;

    const stored = yield* Result.await(
      safeDb(async (tx) => {
        const thread = (
          await tx
            .select({ id: chatThreads.id })
            .from(chatThreads)
            .where(
              and(
                eq(chatThreads.id, threadId),
                eq(chatThreads.organizationId, organizationId),
                eq(chatThreads.userId, user.id),
              ),
            )
            .limit(1)
        ).at(0);
        if (!thread) {
          return Result.err(
            new HandlerError({ status: 404, message: "Chat thread not found" }),
          );
        }

        let mcpConnectorId: (typeof chatToolGrants.$inferInsert)["mcpConnectorId"] =
          null;
        if (isExternalMcpToolName(toolName)) {
          const connectors = await tx
            .select({ id: mcpConnectors.id, slug: mcpConnectors.slug })
            .from(mcpUserConnections)
            .innerJoin(
              mcpConnectors,
              eq(mcpConnectors.id, mcpUserConnections.connectorId),
            )
            .where(
              and(
                eq(mcpUserConnections.organizationId, organizationId),
                eq(mcpUserConnections.userId, user.id),
                eq(mcpUserConnections.enabled, true),
              ),
            )
            .limit(LIMITS.mcpGatewayConnectorsMax);
          mcpConnectorId = resolveExternalMcpGrantConnectorId({
            connectors,
            toolName,
          });
          if (mcpConnectorId === null) {
            return Result.err(notGrantable());
          }
        }

        const held = await tx
          .select({ id: chatToolGrants.id })
          .from(chatToolGrants)
          .where(
            and(
              eq(chatToolGrants.organizationId, organizationId),
              eq(chatToolGrants.userId, user.id),
            ),
          )
          .limit(CHAT_TOOL_GRANTS_MAX);
        if (held.length >= CHAT_TOOL_GRANTS_MAX) {
          return Result.err(
            new HandlerError({
              status: 409,
              message: "Remove a stored approval before adding another",
            }),
          );
        }

        const values = {
          organizationId,
          userId: user.id,
          scope,
          chatThreadId: scope === "conversation" ? threadId : null,
          toolName: mcpConnectorId === null ? toolName : null,
          mcpConnectorId,
        };
        const inserted = await tx
          .insert(chatToolGrants)
          .values(values)
          .onConflictDoNothing()
          .returning({ id: chatToolGrants.id });
        const grant = inserted.at(0);
        if (grant) {
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.CREATE,
            resourceType: AUDIT_RESOURCE_TYPE.CHAT_TOOL_GRANT,
            resourceId: grant.id,
            workspaceId: null,
            metadata: {
              chatThreadId: threadId,
              mcpConnectorId,
              scope,
              toolName: values.toolName,
            },
          });
        }
        return Result.ok({
          created: grant !== undefined,
          mcpConnectorId,
          scope,
          toolName: values.toolName,
        });
      }),
    );

    return stored;
  },
);

export default createChatToolGrant;
