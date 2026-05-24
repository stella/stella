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
import { captureError } from "@/api/lib/analytics";
import type { SafeId } from "@/api/lib/branded-types";
import {
  safeOutboundFetchStream,
  validateOutboundFetchTarget,
} from "@/api/lib/safe-outbound-fetch";
import type { SafeOutboundFetchBody } from "@/api/lib/safe-outbound-fetch";

const MCP_TOOL_PREFIX = "mcp";
const MCP_HTTP_REQUEST_TIMEOUT_MS = 10_000;
// Chat sends load tool schemas serially before the model call. Keep the cap
// explicit so one user cannot turn many slow MCP servers into unbounded latency.
const MAX_ACTIVE_MCP_CONNECTIONS_PER_CHAT = 20;
const MCP_HTTP_RESPONSE_MAX_BYTES = 10_000_000;
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

type RawConnectionRow = {
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
  oauthResourceUrl: string | null;
  oauthAuthorizationServerUrl: string | null;
  refreshTokenEncrypted: Buffer | null;
  refreshTokenIv: Buffer | null;
  slug: string;
  staticTokenEncrypted: Buffer | null;
  staticTokenIv: Buffer | null;
  url: string;
  userConnectionId: SafeId<"mcpUserConnection">;
};

type McpConnectionBase = {
  allowedTools: string[] | null;
  connectorId: SafeId<"mcpConnector">;
  description: string;
  displayName: string;
  slug: string;
  url: string;
  userConnectionId: SafeId<"mcpUserConnection">;
};

type LoadedMcpConnection =
  | (McpConnectionBase & { type: "none" })
  | (McpConnectionBase & {
      staticTokenEncrypted: Buffer;
      staticTokenIv: Buffer;
      type: "bearer";
    })
  | (McpConnectionBase & {
      accessTokenEncrypted: Buffer;
      accessTokenIv: Buffer;
      expiresAt: Date | null;
      oauthAuthorizationServerUrl: string;
      oauthClientId: string;
      oauthClientSecretEncrypted: Buffer | null;
      oauthClientSecretIv: Buffer | null;
      oauthResourceUrl: string;
      refreshTokenEncrypted: Buffer | null;
      refreshTokenIv: Buffer | null;
      type: "oauth2";
    });

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
  value.replace(/[^a-zA-Z0-9_-]/gu, "_");

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
        oauthResourceUrl: mcpUserConnections.resourceUrl,
        oauthAuthorizationServerUrl: mcpUserConnections.authorizationServerUrl,
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
          eq(
            mcpOAuthClients.authorizationServerUrl,
            mcpUserConnections.authorizationServerUrl,
          ),
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

  for (const rawRow of rowsResult.value) {
    const row = await normalizeMcpConnectionRow({ rawRow, safeDb });
    if (!row) {
      continue;
    }

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
  row: LoadedMcpConnection;
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
    const target = await validateOutboundFetchTarget(row.url);
    if (Result.isError(target)) {
      captureError(target.error, {
        source: "external-mcp-tools",
        connectorSlug: row.slug,
      });
      return;
    }

    const transport = {
      type: "http" as const,
      url: target.value.url.toString(),
      redirect: "error" as const,
      fetch: createSafeMcpFetch(MCP_HTTP_REQUEST_TIMEOUT_MS),
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

const createSafeMcpFetch = (timeoutMs: number): FetchFunction => {
  const safeFetch: FetchFunction = Object.assign(
    async (
      input: Parameters<FetchFunction>[0],
      init: Parameters<FetchFunction>[1],
    ) => {
      if (init?.signal?.aborted) {
        throw init.signal.reason;
      }

      const url = mcpFetchUrl(input);
      const response = await safeOutboundFetchStream({
        body: await mcpFetchBody(input, init),
        headers: mcpFetchHeaders(input, init),
        maxBytes: MCP_HTTP_RESPONSE_MAX_BYTES,
        method:
          init?.method ?? (input instanceof Request ? input.method : "GET"),
        signal:
          init?.signal ?? (input instanceof Request ? input.signal : undefined),
        timeoutMs,
        url,
      });
      if (Result.isError(response)) {
        throw response.error;
      }

      return new Response(response.value.body, {
        headers: response.value.headers,
        status: response.value.status,
      });
    },
    { preconnect: fetch.preconnect },
  );

  return safeFetch;
};

const mcpFetchUrl = (input: Parameters<FetchFunction>[0]): URL => {
  if (input instanceof Request) {
    return new URL(input.url);
  }

  return new URL(input.toString());
};

const mcpFetchHeaders = (
  input: Parameters<FetchFunction>[0],
  init: Parameters<FetchFunction>[1],
): Headers => {
  const headers = new Headers(input instanceof Request ? input.headers : {});
  const initHeaders = new Headers(init?.headers);
  for (const [key, value] of initHeaders.entries()) {
    headers.set(key, value);
  }
  return headers;
};

const mcpFetchBody = async (
  input: Parameters<FetchFunction>[0],
  init: Parameters<FetchFunction>[1],
): Promise<SafeOutboundFetchBody | undefined> => {
  if (init?.body !== undefined && init.body !== null) {
    return normalizeMcpFetchBody(init.body);
  }

  if (input instanceof Request && input.method !== "GET") {
    return await input.arrayBuffer();
  }

  return undefined;
};

const normalizeMcpFetchBody = (body: unknown): SafeOutboundFetchBody => {
  if (
    typeof body === "string" ||
    body instanceof URLSearchParams ||
    body instanceof Uint8Array ||
    body instanceof ArrayBuffer
  ) {
    return body;
  }

  throw new TypeError("Unsupported MCP request body type");
};

export const buildExternalMcpSystemHint = (
  connectors: readonly LoadedExternalMcpConnector[],
): string => {
  if (connectors.length === 0) {
    return "";
  }

  const lines = connectors.map((connector) => {
    const toolSummary = summarizeExternalMcpToolNames(connector.toolNames);
    const description =
      connector.description.trim() || toolSummary || connector.displayName;

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
    .map((name) => name.replaceAll(/[_-]+/gu, " "))
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
  row: LoadedMcpConnection;
  safeDb: SafeDb;
  userId: SafeId<"user">;
}): Promise<{ type: "ok"; value: string | null } | { type: "skip" }> => {
  if (row.type === "none") {
    return { type: "ok", value: null };
  }

  if (row.type === "bearer") {
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

  if (!row.refreshTokenEncrypted || !row.refreshTokenIv) {
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
    resourceUrl: row.oauthResourceUrl,
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

  // eslint-disable-next-line arrow-body-style -- block body holds the audit-skip directive that the require-audit-on-mutation rule scans for inside this arrow's body range
  const persistResult = await safeDb((tx) => {
    // audit: skip — MCP tool execution metadata; audit happens at the parent user action
    return tx
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
      .where(eq(mcpUserConnections.id, row.userConnectionId));
  });

  if (Result.isError(persistResult)) {
    captureError(persistResult.error, { source: "external-mcp-tools" });
    return { type: "skip" };
  }

  return { type: "ok", value: refreshed.value.access_token };
};

const normalizeMcpConnectionRow = async ({
  rawRow,
  safeDb,
}: {
  rawRow: RawConnectionRow;
  safeDb: SafeDb;
}): Promise<LoadedMcpConnection | null> => {
  const base = {
    allowedTools: rawRow.allowedTools,
    connectorId: rawRow.connectorId,
    description: rawRow.description,
    displayName: rawRow.displayName,
    slug: rawRow.slug,
    url: rawRow.url,
    userConnectionId: rawRow.userConnectionId,
  } satisfies McpConnectionBase;

  if (rawRow.authType === "none") {
    return { ...base, type: "none" };
  }

  if (rawRow.authType === "bearer") {
    if (!rawRow.staticTokenEncrypted || !rawRow.staticTokenIv) {
      return null;
    }

    return {
      ...base,
      staticTokenEncrypted: rawRow.staticTokenEncrypted,
      staticTokenIv: rawRow.staticTokenIv,
      type: "bearer",
    };
  }

  if (
    !rawRow.accessTokenEncrypted ||
    !rawRow.accessTokenIv ||
    !rawRow.oauthAuthorizationServerUrl ||
    !rawRow.oauthClientId ||
    !rawRow.oauthResourceUrl
  ) {
    await markNeedsReauth({ connectionId: rawRow.userConnectionId, safeDb });
    return null;
  }

  return {
    ...base,
    accessTokenEncrypted: rawRow.accessTokenEncrypted,
    accessTokenIv: rawRow.accessTokenIv,
    expiresAt: rawRow.expiresAt,
    oauthAuthorizationServerUrl: rawRow.oauthAuthorizationServerUrl,
    oauthClientId: rawRow.oauthClientId,
    oauthClientSecretEncrypted: rawRow.oauthClientSecretEncrypted,
    oauthClientSecretIv: rawRow.oauthClientSecretIv,
    oauthResourceUrl: rawRow.oauthResourceUrl,
    refreshTokenEncrypted: rawRow.refreshTokenEncrypted,
    refreshTokenIv: rawRow.refreshTokenIv,
    type: "oauth2",
  };
};

const markNeedsReauth = async ({
  connectionId,
  safeDb,
}: {
  connectionId: SafeId<"mcpUserConnection">;
  safeDb: SafeDb;
}) => {
  // eslint-disable-next-line arrow-body-style -- block body holds the audit-skip directive that the require-audit-on-mutation rule scans for inside this arrow's body range
  const result = await safeDb((tx) => {
    // audit: skip — MCP tool execution metadata; audit happens at the parent user action
    return tx
      .update(mcpUserConnections)
      .set({ status: "needs_reauth", updatedAt: new Date() })
      .where(eq(mcpUserConnections.id, connectionId));
  });
  if (Result.isError(result)) {
    captureError(result.error, { source: "external-mcp-tools" });
  }
};
