import { toolDefinition } from "@tanstack/ai";
import { and, eq, isNull, or } from "drizzle-orm";
import * as v from "valibot";

import {
  REQUEST_SECRET_TOOL_NAME,
  USE_CONNECTOR_SECRET_TOOL_NAME,
  chatSecretTargetSchema,
  requestSecretInputSchema,
  requestSecretOutputSchema,
} from "@stll/api-contract/chat-secret";

import type { SafeDb } from "@/api/db/safe-db";
import {
  mcpConnectorAuthorizationReviews,
  mcpConnectors,
  mcpUserConnections,
} from "@/api/db/schema";
import { consumeChatSecret } from "@/api/handlers/chat/chat-secrets";
import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import type { SafeId } from "@/api/lib/branded-types";
import { approvedMcpAuthorizationReview } from "@/api/lib/mcp-upstream/authorization-review";
import { callWithChatSecret } from "@/api/lib/mcp-upstream/chat-secret";

const useSecretInputSchema = v.strictObject({
  secretRef: v.pipe(v.string(), v.uuid()),
  target: chatSecretTargetSchema,
  toolName: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  arguments: v.record(v.string(), v.unknown()),
});
const useSecretOutputSchema = v.variant("status", [
  v.strictObject({ status: v.literal("completed") }),
  v.strictObject({
    status: v.literal("unavailable"),
    code: v.picklist([
      "reference-unavailable",
      "connector-unavailable",
      "request-failed",
    ]),
    message: v.string(),
    hint: v.string(),
  }),
]);

type SecretToolsContext = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  threadId: SafeId<"chatThread">;
};

export const createSecretTools = ({
  safeDb,
  organizationId,
  userId,
  threadId,
}: SecretToolsContext) => ({
  [REQUEST_SECRET_TOOL_NAME]: toolDefinition({
    name: REQUEST_SECRET_TOOL_NAME,
    description:
      "Request a credential in a private input card. Use only for a connector the user has enabled that accepts a bearer credential. Name its exact connector slug and explain the purpose. Never request credentials through ask-user or ordinary chat. The result contains an opaque reference, never the value. If declined, continue without it. References last 24 hours and permit eight connector operations; use use_connector_secret to call a tool already known from the connector catalog. Browser login remains manual and the code runner cannot resolve references.",
    inputSchema: toTanStackToolSchema(requestSecretInputSchema),
    outputSchema: toTanStackToolSchema(requestSecretOutputSchema),
  }),
  [USE_CONNECTOR_SECRET_TOOL_NAME]: toolDefinition({
    name: USE_CONNECTOR_SECRET_TOOL_NAME,
    description:
      "Use a provided private reference for its exact MCP connector. Call an allowed tool whose name and arguments are known from the connector catalog. Only completion status is returned; response content remains private. Each operation consumes one use, including failed requests. If unavailable, request_secret asks for another credential; never ask the user to paste one into chat. Calls require approval.",
    inputSchema: toTanStackToolSchema(useSecretInputSchema),
    outputSchema: toTanStackToolSchema(useSecretOutputSchema),
  }).server(async ({ secretRef, target, toolName, arguments: args }) => {
    const rows = await safeDb((tx) =>
      tx
        .select({
          id: mcpConnectors.id,
          connectionId: mcpUserConnections.id,
          url: mcpConnectors.url,
          allowedTools: mcpConnectors.allowedTools,
          authType: mcpConnectors.authType,
        })
        .from(mcpConnectors)
        .innerJoin(
          mcpUserConnections,
          and(
            eq(mcpUserConnections.connectorId, mcpConnectors.id),
            eq(mcpUserConnections.organizationId, organizationId),
            eq(mcpUserConnections.userId, userId),
            eq(mcpUserConnections.enabled, true),
          ),
        )
        .leftJoin(
          mcpConnectorAuthorizationReviews,
          and(
            eq(mcpConnectorAuthorizationReviews.connectorId, mcpConnectors.id),
            eq(mcpConnectorAuthorizationReviews.organizationId, organizationId),
          ),
        )
        .where(
          and(
            eq(mcpConnectors.slug, target.connectorSlug),
            or(
              isNull(mcpConnectors.organizationId),
              eq(mcpConnectors.organizationId, organizationId),
            ),
            approvedMcpAuthorizationReview,
          ),
        )
        .limit(2),
    );
    const connector =
      rows.isOk() && rows.value.length === 1 ? rows.value.at(0) : undefined;
    if (!connector || connector.authType !== "bearer") {
      return {
        status: "unavailable" as const,
        code: "connector-unavailable" as const,
        message: "Connector is unavailable",
        hint: "Choose an available bearer connector before calling request_secret.",
      };
    }
    const encrypted = await consumeChatSecret({
      safeDb,
      organizationId,
      userId,
      threadId,
      connectorId: connector.id,
      targetConnectionId: connector.connectionId,
      targetUrl: connector.url,
      secretRef,
    });
    if (encrypted.isErr()) {
      return {
        status: "unavailable" as const,
        code: "reference-unavailable" as const,
        message: "Private reference is unavailable",
        hint: "Call request_secret for this connector again.",
      };
    }
    const called = await callWithChatSecret({
      encrypted: encrypted.value,
      organizationId,
      userId,
      connectorId: connector.id,
      url: connector.url,
      allowedTools: connector.allowedTools,
      permit: grantThirdPartyOutboundPermit(),
      operation: { toolName, arguments: args },
    });
    if (called.isErr()) {
      return {
        status: "unavailable" as const,
        code: "request-failed" as const,
        message: "Connector request failed",
        hint: "Check the connector settings or call request_secret for a new credential.",
      };
    }
    return { status: "completed" as const };
  }),
});
