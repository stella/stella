import { createMCPClient } from "@ai-sdk/mcp";
import type { MCPClient } from "@ai-sdk/mcp";
import type { FetchFunction } from "@ai-sdk/provider-utils";
import type { ToolSet } from "ai";
import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import type { SafeDb } from "@/api/db";
import {
  mcpConnectors,
  mcpOAuthClients,
  mcpUserConnections,
} from "@/api/db/schema";
import {
  decryptMcpSecret,
  encryptMcpSecret,
} from "@/api/handlers/mcp-connectors/crypto";
import {
  refreshOAuthToken,
  tokenExpiresAt,
} from "@/api/handlers/mcp-connectors/oauth";
import { validateSafeMcpFetchUrl } from "@/api/handlers/mcp-connectors/url-safety";
import { captureError } from "@/api/lib/analytics";
import type { SafeId } from "@/api/lib/branded-types";

const MCP_TOOL_PREFIX = "mcp";
const MCP_HTTP_REQUEST_TIMEOUT_MS = 10_000;
// Chat sends load tool schemas serially before the model call. Keep the cap
// explicit so one user cannot turn many slow MCP servers into unbounded latency.
const MAX_ACTIVE_MCP_CONNECTIONS_PER_CHAT = 20;
const TOKEN_REFRESH_SKEW_MS = 60_000;

export type LoadedExternalMcpTools = {
  close: () => Promise<void> | void;
  connectors: LoadedExternalMcpConnector[];
  tools: ToolSet;
};

export type LoadedExternalMcpConnector = {
  description: string;
  displayName: string;
  slug: string;
  toolNames: string[];
};

type ConnectionRow = {
  accessTokenEncrypted: Buffer | null;
  accessTokenIv: Buffer | null;
  allowedTools: string[] | null;
  authType: "none" | "bearer" | "oauth2";
  connectorId: SafeId<"mcpConnector">;
  description: string;
  displayName: string;
  expiresAt: Date | null;
  oauthClientId: string | null;
  oauthClientSecretEncrypted: Buffer | null;
  oauthClientSecretIv: Buffer | null;
  oauthAuthorizationServerUrl: string | null;
  refreshTokenEncrypted: Buffer | null;
  refreshTokenIv: Buffer | null;
  slug: string;
  staticTokenEncrypted: Buffer | null;
  staticTokenIv: Buffer | null;
  url: string;
  userConnectionId: SafeId<"mcpUserConnection">;
};

export const namespaceMcpToolName = ({
  connectorSlug,
  toolName,
}: {
  connectorSlug: string;
  toolName: string;
}): string =>
  [
    MCP_TOOL_PREFIX,
    sanitizeToolNamePart(connectorSlug),
    sanitizeToolNamePart(toolName),
  ].join("__");

const sanitizeToolNamePart = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_-]/g, "_");

export const loadExternalMcpToolsForUser = async ({
  organizationId,
  safeDb,
  userId,
}: {
  organizationId: SafeId<"organization">;
  safeDb: SafeDb;
  userId: SafeId<"user">;
}): Promise<LoadedExternalMcpTools> => {
  const clients: MCPClient[] = [];
  const connectors: LoadedExternalMcpConnector[] = [];
  const loadedTools: ToolSet = {};

  const rowsResult = await safeDb((tx) =>
    tx
      .select({
        userConnectionId: mcpUserConnections.id,
        connectorId: mcpConnectors.id,
        slug: mcpConnectors.slug,
        displayName: mcpConnectors.displayName,
        description: mcpConnectors.description,
        url: mcpConnectors.url,
        authType: mcpConnectors.authType,
        allowedTools: mcpConnectors.allowedTools,
        accessTokenEncrypted: mcpUserConnections.accessTokenEncrypted,
        accessTokenIv: mcpUserConnections.accessTokenIv,
        refreshTokenEncrypted: mcpUserConnections.refreshTokenEncrypted,
        refreshTokenIv: mcpUserConnections.refreshTokenIv,
        staticTokenEncrypted: mcpUserConnections.staticTokenEncrypted,
        staticTokenIv: mcpUserConnections.staticTokenIv,
        expiresAt: mcpUserConnections.expiresAt,
        oauthAuthorizationServerUrl: mcpOAuthClients.authorizationServerUrl,
        oauthClientId: mcpOAuthClients.clientId,
        oauthClientSecretEncrypted: mcpOAuthClients.clientSecretEncrypted,
        oauthClientSecretIv: mcpOAuthClients.clientSecretIv,
      })
      .from(mcpUserConnections)
      .innerJoin(
        mcpConnectors,
        eq(mcpConnectors.id, mcpUserConnections.connectorId),
      )
      .leftJoin(
        mcpOAuthClients,
        and(
          eq(mcpOAuthClients.connectorId, mcpConnectors.id),
          eq(mcpOAuthClients.organizationId, organizationId),
        ),
      )
      .where(
        and(
          eq(mcpUserConnections.organizationId, organizationId),
          eq(mcpUserConnections.userId, userId),
          eq(mcpUserConnections.enabled, true),
          eq(mcpUserConnections.status, "connected"),
        ),
      )
      .limit(MAX_ACTIVE_MCP_CONNECTIONS_PER_CHAT),
  );

  if (Result.isError(rowsResult)) {
    captureError(rowsResult.error, { source: "external-mcp-tools" });
    return { close: () => undefined, connectors, tools: loadedTools };
  }

  for (const row of rowsResult.value) {
    await loadConnectorTools({
      clients,
      connectors,
      loadedTools,
      organizationId,
      row,
      safeDb,
      userId,
    });
  }

  return {
    close: async () => {
      const closeTasks: Promise<void>[] = [];
      for (const client of clients) {
        closeTasks.push(client.close());
      }
      await Promise.allSettled(closeTasks);
    },
    connectors,
    tools: loadedTools,
  };
};

const loadConnectorTools = async ({
  clients,
  connectors,
  loadedTools,
  organizationId,
  row,
  safeDb,
  userId,
}: {
  clients: MCPClient[];
  connectors: LoadedExternalMcpConnector[];
  loadedTools: ToolSet;
  organizationId: SafeId<"organization">;
  row: ConnectionRow;
  safeDb: SafeDb;
  userId: SafeId<"user">;
}) => {
  try {
    const token = await resolveAuthorizationToken({
      organizationId,
      row,
      safeDb,
      userId,
    });
    if (token.type === "skip") {
      return;
    }
    const safeUrl = await validateSafeMcpFetchUrl(row.url);
    if (Result.isError(safeUrl)) {
      captureError(safeUrl.error, {
        source: "external-mcp-tools",
        connectorSlug: row.slug,
      });
      return;
    }

    const transport = {
      type: "http" as const,
      url: safeUrl.value.toString(),
      redirect: "error" as const,
      fetch: createMcpFetchWithTimeout(MCP_HTTP_REQUEST_TIMEOUT_MS),
      ...(token.value === null
        ? {}
        : { headers: { Authorization: `Bearer ${token.value}` } }),
    };
    const client = await createMCPClient({
      transport,
    });
    clients.push(client);

    const tools = await client.tools();
    const allowedTools = row.allowedTools ? new Set(row.allowedTools) : null;
    const toolNames: string[] = [];

    for (const [toolName, toolDefinition] of Object.entries(tools)) {
      if (allowedTools && !allowedTools.has(toolName)) {
        continue;
      }

      toolNames.push(toolName);
      loadedTools[
        namespaceMcpToolName({
          connectorSlug: row.slug,
          toolName,
        })
      ] = toolDefinition;
    }

    connectors.push({
      description: row.description,
      displayName: row.displayName,
      slug: row.slug,
      toolNames,
    });
  } catch (error) {
    captureError(error, {
      source: "external-mcp-tools",
      connectorSlug: row.slug,
    });
  }
};

const createMcpFetchWithTimeout = (timeoutMs: number): FetchFunction => {
  const timeoutFetch: FetchFunction = Object.assign(
    async (
      input: Parameters<FetchFunction>[0],
      init: Parameters<FetchFunction>[1],
    ) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const upstreamSignal = init?.signal;
      const abortFromUpstream = () => controller.abort(upstreamSignal?.reason);

      if (upstreamSignal?.aborted) {
        abortFromUpstream();
      } else {
        upstreamSignal?.addEventListener("abort", abortFromUpstream, {
          once: true,
        });
      }

      try {
        return await fetch(input, {
          ...init,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
        upstreamSignal?.removeEventListener("abort", abortFromUpstream);
      }
    },
    { preconnect: fetch.preconnect },
  );

  return timeoutFetch;
};

const GENERIC_CUSTOM_MCP_DESCRIPTION =
  "Custom MCP server added by your organization.";

export const buildExternalMcpSystemHint = (
  connectors: readonly LoadedExternalMcpConnector[],
): string => {
  if (connectors.length === 0) {
    return "";
  }

  const lines = connectors.map((connector) => {
    const toolSummary = summarizeExternalMcpToolNames(connector.toolNames);
    const description =
      connector.description === GENERIC_CUSTOM_MCP_DESCRIPTION && toolSummary
        ? toolSummary
        : connector.description;

    return `- ${connector.displayName} (\`mcp__${connector.slug}__*\`): ${description}`;
  });

  return [
    "CONNECTED MCP SERVERS: Use these external connectors only when relevant. Prefer the connector whose short description matches the user's jurisdiction or data need; rely on each tool's schema for exact inputs.",
    ...lines,
  ].join("\n");
};

const summarizeExternalMcpToolNames = (
  toolNames: readonly string[],
): string => {
  if (toolNames.length === 0) {
    return "";
  }

  const readableTools = toolNames
    .slice(0, 6)
    .map((name) => name.replaceAll(/[_-]+/g, " "))
    .join(", ");
  return `External MCP tools: ${readableTools}.`;
};

const resolveAuthorizationToken = async ({
  organizationId,
  row,
  safeDb,
  userId,
}: {
  organizationId: SafeId<"organization">;
  row: ConnectionRow;
  safeDb: SafeDb;
  userId: SafeId<"user">;
}): Promise<{ type: "ok"; value: string | null } | { type: "skip" }> => {
  if (row.authType === "none") {
    return { type: "ok", value: null };
  }

  if (row.authType === "bearer") {
    if (!row.staticTokenEncrypted || !row.staticTokenIv) {
      return { type: "skip" };
    }

    return {
      type: "ok",
      value: await decryptMcpSecret({
        ciphertext: row.staticTokenEncrypted,
        connectorId: row.connectorId,
        iv: row.staticTokenIv,
        organizationId,
        purpose: "mcp_static_token",
        userId,
      }),
    };
  }

  if (!row.accessTokenEncrypted || !row.accessTokenIv) {
    return { type: "skip" };
  }

  if (
    !row.expiresAt ||
    row.expiresAt.getTime() > Date.now() + TOKEN_REFRESH_SKEW_MS
  ) {
    return {
      type: "ok",
      value: await decryptMcpSecret({
        ciphertext: row.accessTokenEncrypted,
        connectorId: row.connectorId,
        iv: row.accessTokenIv,
        organizationId,
        purpose: "mcp_access_token",
        userId,
      }),
    };
  }

  if (
    !row.refreshTokenEncrypted ||
    !row.refreshTokenIv ||
    !row.oauthAuthorizationServerUrl ||
    !row.oauthClientId
  ) {
    await markNeedsReauth({ connectionId: row.userConnectionId, safeDb });
    return { type: "skip" };
  }

  const refreshToken = await decryptMcpSecret({
    ciphertext: row.refreshTokenEncrypted,
    connectorId: row.connectorId,
    iv: row.refreshTokenIv,
    organizationId,
    purpose: "mcp_refresh_token",
    userId,
  });
  const clientSecret =
    row.oauthClientSecretEncrypted && row.oauthClientSecretIv
      ? await decryptMcpSecret({
          ciphertext: row.oauthClientSecretEncrypted,
          connectorId: row.connectorId,
          iv: row.oauthClientSecretIv,
          organizationId,
          purpose: "mcp_client_secret",
        })
      : null;
  const refreshed = await refreshOAuthToken({
    authorizationServerUrl: row.oauthAuthorizationServerUrl,
    clientId: row.oauthClientId,
    clientSecret,
    refreshToken,
    resourceUrl: row.url,
  });

  if (Result.isError(refreshed)) {
    await markNeedsReauth({ connectionId: row.userConnectionId, safeDb });
    return { type: "skip" };
  }

  const encryptedAccess = await encryptMcpSecret({
    connectorId: row.connectorId,
    organizationId,
    purpose: "mcp_access_token",
    secret: refreshed.value.access_token,
    userId,
  });
  const encryptedRefresh = refreshed.value.refresh_token
    ? await encryptMcpSecret({
        connectorId: row.connectorId,
        organizationId,
        purpose: "mcp_refresh_token",
        secret: refreshed.value.refresh_token,
        userId,
      })
    : null;

  await safeDb((tx) =>
    tx
      .update(mcpUserConnections)
      .set({
        accessTokenEncrypted: encryptedAccess.ciphertext,
        accessTokenIv: encryptedAccess.iv,
        refreshTokenEncrypted:
          encryptedRefresh?.ciphertext ?? row.refreshTokenEncrypted,
        refreshTokenIv: encryptedRefresh?.iv ?? row.refreshTokenIv,
        expiresAt: tokenExpiresAt(refreshed.value),
        status: "connected",
        updatedAt: new Date(),
      })
      .where(eq(mcpUserConnections.id, row.userConnectionId)),
  );

  return { type: "ok", value: refreshed.value.access_token };
};

const markNeedsReauth = async ({
  connectionId,
  safeDb,
}: {
  connectionId: SafeId<"mcpUserConnection">;
  safeDb: SafeDb;
}) => {
  await safeDb((tx) =>
    tx
      .update(mcpUserConnections)
      .set({ status: "needs_reauth", updatedAt: new Date() })
      .where(eq(mcpUserConnections.id, connectionId)),
  );
};
