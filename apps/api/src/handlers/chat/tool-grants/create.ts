import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import * as v from "valibot";

import { isGrantableChatTool } from "@stll/api-contract/chat-tool-grants";

import { chatThreads, chatToolGrants } from "@/api/db/schema";
import { resolveStoredGrantSubject } from "@/api/handlers/chat/tools/chat-tool-grants";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { withAggregateLock } from "@/api/lib/db/aggregate-lock";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  contract: "patch",
  permissions: { chat: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "chat_thread_ui" },
  body: v.object({
    scope: v.picklist(["conversation", "always"]),
    threadId: resourceIdSchema("chatThread"),
    toolName: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
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
 * whose grant policy requires approval on every call. Storing it again is a
 * no-op (unique per subject and scope).
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
    // The shared policy allows grants only for grantable approval-gated
    // built-in tools and connector tools, so one user's grants in scope for a
    // conversation stay bounded by the tools that exist.
    if (!isGrantableChatTool(toolName)) {
      return Result.err(notGrantable());
    }
    const organizationId = session.activeOrganizationId;

    const stored = yield* Result.await(
      safeDb(async (tx) => {
        await withAggregateLock({
          tx,
          aggregate: "chatThread",
          id: { id: threadId, organizationId, userId: user.id },
          mode: "update",
        });
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

        await withAggregateLock({
          tx,
          aggregate: "chatToolGrants",
          id: { organizationId, userId: user.id },
        });
        const subject = await resolveStoredGrantSubject({
          organizationId,
          toolName,
          tx,
          userId: user.id,
        });
        if (subject === null) {
          return Result.err(notGrantable());
        }
        const mcpConnectorId =
          subject.type === "mcp-connector" ? subject.connectorId : null;

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

declareAggregateMutation(createChatToolGrant, {
  type: "aggregate",
  aggregates: ["chatThread", "chatToolGrants"],
});

export default createChatToolGrant;
