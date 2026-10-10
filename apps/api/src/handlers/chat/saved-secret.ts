import { Result } from "better-result";
import { and, eq, isNull, or } from "drizzle-orm";
import { t } from "elysia";

import {
  chatThreads,
  mcpConnectorAuthorizationReviews,
  mcpConnectors,
  mcpUserConnections,
} from "@/api/db/schema";
import { readSavedChatSecret } from "@/api/handlers/chat/chat-secrets";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { approvedMcpAuthorizationReview } from "@/api/lib/mcp-upstream/authorization-review";
import { hasMemberPermission } from "@/api/lib/permission-authorization";

const config = {
  // Connector access is checked in the handler, as on submission: this read
  // writes nothing, so it declares no integration write.
  permissions: { chat: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "chat_thread_ui" },
  params: t.Object({ threadId: tSafeId("chatThread") }),
  query: t.Object({ connectorSlug: t.String({ minLength: 1, maxLength: 80 }) }),
} satisfies HandlerConfig;

const connectorUnavailable = () =>
  new HandlerError({
    status: 404,
    message: "Enable this connector in settings before providing a credential",
  });

const savedSecret = createSafeRootHandler(
  config,
  async function* ({
    params: { threadId },
    query: { connectorSlug },
    safeDb,
    session,
    user,
    memberRole,
  }) {
    if (!hasMemberPermission(memberRole, { integration: ["create"] })) {
      return Result.err(
        new HandlerError({
          status: 403,
          message: "Connector access is unavailable",
        }),
      );
    }
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
            connectionId: mcpUserConnections.id,
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
          .leftJoin(
            mcpConnectorAuthorizationReviews,
            and(
              eq(
                mcpConnectorAuthorizationReviews.connectorId,
                mcpConnectors.id,
              ),
              eq(
                mcpConnectorAuthorizationReviews.organizationId,
                session.activeOrganizationId,
              ),
            ),
          )
          .where(
            and(
              eq(mcpConnectors.slug, connectorSlug),
              or(
                isNull(mcpConnectors.organizationId),
                eq(mcpConnectors.organizationId, session.activeOrganizationId),
              ),
              approvedMcpAuthorizationReview,
            ),
          )
          .limit(2);
        // An ambiguous slug resolves to no connector.
        if (connectors.length > 1) {
          return Result.err(connectorUnavailable());
        }
        const connector = connectors.at(0);
        if (!connector || connector.authType !== "bearer") {
          return Result.err(connectorUnavailable());
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
            connectionId: connector.connectionId,
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
