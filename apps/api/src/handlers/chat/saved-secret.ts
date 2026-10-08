import { Result } from "better-result";
import { and, eq, isNull, or } from "drizzle-orm";
import { t } from "elysia";

import {
  chatThreads,
  mcpConnectors,
  mcpUserConnections,
} from "@/api/db/schema";
import { readSavedChatSecret } from "@/api/handlers/chat/chat-secrets";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  permissions: { chat: ["create"], integration: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "chat_thread_ui" },
  params: t.Object({ threadId: tSafeId("chatThread") }),
  query: t.Object({ connectorSlug: t.String({ minLength: 1, maxLength: 80 }) }),
} satisfies HandlerConfig;

const savedSecret = createSafeRootHandler(
  config,
  async function* ({
    params: { threadId },
    query: { connectorSlug },
    safeDb,
    session,
    user,
  }) {
    const result = yield* Result.await(
      safeDb(async (tx) => {
        const thread = (
          await tx
            .select({ id: chatThreads.id })
            .from(chatThreads)
            .where(
              and(
                eq(chatThreads.id, threadId),
                eq(chatThreads.organizationId, session.activeOrganizationId),
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
        const connectors = await tx
          .select({
            id: mcpConnectors.id,
            url: mcpConnectors.url,
            authType: mcpConnectors.authType,
            displayName: mcpConnectors.displayName,
            responseDisposition: mcpUserConnections.responseDisposition,
          })
          .from(mcpConnectors)
          .innerJoin(
            mcpUserConnections,
            and(
              eq(mcpUserConnections.connectorId, mcpConnectors.id),
              eq(
                mcpUserConnections.organizationId,
                session.activeOrganizationId,
              ),
              eq(mcpUserConnections.userId, user.id),
              eq(mcpUserConnections.enabled, true),
            ),
          )
          .where(
            and(
              eq(mcpConnectors.slug, connectorSlug),
              or(
                isNull(mcpConnectors.organizationId),
                eq(mcpConnectors.organizationId, session.activeOrganizationId),
              ),
            ),
          )
          .limit(2);
        const connector =
          connectors.length === 1 ? connectors.at(0) : undefined;
        if (!connector || connector.authType !== "bearer") {
          return Result.err(
            new HandlerError({
              status: 404,
              message:
                "Enable this connector in settings before providing a credential",
            }),
          );
        }
        const stored = await readSavedChatSecret({
          tx,
          organizationId: session.activeOrganizationId,
          userId: user.id,
          connectorId: connector.id,
          targetUrl: connector.url,
        });
        return Result.ok({
          available: stored !== undefined,
          connector: {
            displayName: connector.displayName,
            host: new URL(connector.url).host,
            responseDisposition: connector.responseDisposition,
          },
        });
      }),
    );
    return result;
  },
);
export default savedSecret;
