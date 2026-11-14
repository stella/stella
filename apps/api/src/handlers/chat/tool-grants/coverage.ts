import { Result } from "better-result";
import { and, eq, or } from "drizzle-orm";
import * as v from "valibot";

import { chatToolGrants } from "@/api/db/schema";
import { resolveStoredGrantSubject } from "@/api/handlers/chat/tools/chat-tool-grants";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { resourceIdSchema } from "@/api/lib/custom-schema";

const config = {
  contract: "patch",
  permissions: { chat: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "chat_thread_ui" },
  access: "read",
  query: v.object({
    threadId: resourceIdSchema("chatThread"),
    toolName: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
  }),
} satisfies HandlerConfig;

/**
 * Whether a stored grant covers `toolName` in this conversation right now,
 * resolving a connector tool to the exact connector it belongs to. The web
 * app asks before an approval card answers itself.
 */
const readChatToolGrantCoverage = createSafeRootHandler(
  config,
  async function* ({ query: { threadId, toolName }, safeDb, session, user }) {
    const organizationId = session.activeOrganizationId;
    const covered = yield* Result.await(
      safeDb(async (tx) => {
        const subject = await resolveStoredGrantSubject({
          organizationId,
          toolName,
          tx,
          userId: user.id,
        });
        if (subject === null) {
          return false;
        }
        const grant = (
          await tx
            .select({ id: chatToolGrants.id })
            .from(chatToolGrants)
            .where(
              and(
                eq(chatToolGrants.organizationId, organizationId),
                eq(chatToolGrants.userId, user.id),
                or(
                  eq(chatToolGrants.scope, "always"),
                  eq(chatToolGrants.chatThreadId, threadId),
                ),
                subject.type === "tool"
                  ? eq(chatToolGrants.toolName, subject.toolName)
                  : eq(chatToolGrants.mcpConnectorId, subject.connectorId),
              ),
            )
            .limit(1)
        ).at(0);
        return grant !== undefined;
      }),
    );
    return Result.ok({ covered });
  },
);

export default readChatToolGrantCoverage;
