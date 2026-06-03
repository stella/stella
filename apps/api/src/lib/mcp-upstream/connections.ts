import { createMCPClient } from "@ai-sdk/mcp";
import type { ListToolsResult, MCPClient } from "@ai-sdk/mcp";
import type { FetchFunction } from "@ai-sdk/provider-utils";
import {
  CallToolResultSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { Result } from "better-result";
import { and, asc, eq } from "drizzle-orm";

import type { SafeDb } from "@/api/db";
import {
  mcpConnectors,
  mcpOAuthClients,
  mcpUserConnections,
} from "@/api/db/schema";
import type { CachedMcpToolDefinition } from "@/api/db/schema";
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
import { LIMITS } from "@/api/lib/limits";
import {
  safeOutboundFetchStream,
  validateOutboundFetchTarget,
} from "@/api/lib/safe-outbound-fetch";
import type { SafeOutboundFetchBody } from "@/api/lib/safe-outbound-fetch";
import {
  MCP_TOOL_EXECUTION_OPTIONS,
  errorResult,
  textResult,
} from "@/api/mcp/tool-utils";

import { normalizeDiscoveredMcpTools } from "./cached-tools";

const MCP_HTTP_REQUEST_TIMEOUT_MS = 10_000;
const MCP_HTTP_RESPONSE_MAX_BYTES = 10_000_000;
const TOKEN_REFRESH_SKEW_MS = 60_000;

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

export type LoadedMcpConnection =
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

const selectConnectionFields = {
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
} satisfies Record<string, unknown>;

export const loadActiveMcpConnectionsForUser = async ({
  organizationId,
  safeDb,
  userId,
}: {
  organizationId: SafeId<"organization">;
  safeDb: SafeDb;
  userId: SafeId<"user">;
}): Promise<LoadedMcpConnection[]> => {
  const rowsResult = await safeDb((tx) =>
    // oxlint-disable-next-line mcp-security/no-direct-oauth-client-join -- this module is the shared typed MCP connection loader.
    tx
      .select(selectConnectionFields)
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
      .orderBy(asc(mcpUserConnections.createdAt), asc(mcpUserConnections.id))
      .limit(LIMITS.mcpGatewayConnectorsMax),
  );

  if (Result.isError(rowsResult)) {
    captureError(rowsResult.error, { source: "mcp-upstream-connections" });
    return [];
  }

  return await normalizeConnectionRows({
    rows: rowsResult.value,
    safeDb,
  });
};

export const loadMcpConnectionById = async ({
  connectionId,
  organizationId,
  safeDb,
  userId,
}: {
  connectionId: SafeId<"mcpUserConnection">;
  organizationId: SafeId<"organization">;
  safeDb: SafeDb;
  userId: SafeId<"user">;
}): Promise<LoadedMcpConnection | null> => {
  const rowsResult = await safeDb((tx) =>
    // oxlint-disable-next-line mcp-security/no-direct-oauth-client-join -- this module is the shared typed MCP connection loader.
    tx
      .select(selectConnectionFields)
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
          eq(mcpUserConnections.id, connectionId),
          eq(mcpUserConnections.organizationId, organizationId),
          eq(mcpUserConnections.userId, userId),
          eq(mcpUserConnections.status, "connected"),
        ),
      )
      .limit(1),
  );

  if (Result.isError(rowsResult)) {
    captureError(rowsResult.error, { source: "mcp-upstream-connections" });
    return null;
  }

  const normalized = await normalizeConnectionRows({
    rows: rowsResult.value,
    safeDb,
  });
  return normalized.at(0) ?? null;
};

const normalizeConnectionRows = async ({
  rows,
  safeDb,
}: {
  rows: RawConnectionRow[];
  safeDb: SafeDb;
}): Promise<LoadedMcpConnection[]> => {
  const normalized: LoadedMcpConnection[] = [];
  for (const rawRow of rows) {
    const row = await normalizeMcpConnectionRow({ rawRow, safeDb });
    if (row) {
      normalized.push(row);
    }
  }
  return normalized;
};

export const createMcpClientForConnection = async ({
  organizationId,
  row,
  safeDb,
  userId,
}: {
  organizationId: SafeId<"organization">;
  row: LoadedMcpConnection;
  safeDb: SafeDb;
  userId: SafeId<"user">;
}): Promise<MCPClient | null> => {
  const token = await resolveAuthorizationToken({
    organizationId,
    row,
    safeDb,
    userId,
  });
  if (token.type === "skip") {
    return null;
  }

  const target = await validateOutboundFetchTarget(row.url);
  if (Result.isError(target)) {
    captureError(target.error, {
      source: "mcp-upstream-client",
      connectorSlug: row.slug,
    });
    return null;
  }

  return await createMCPClient({
    transport: {
      type: "http",
      url: target.value.url.toString(),
      redirect: "error",
      fetch: createSafeMcpFetch(MCP_HTTP_REQUEST_TIMEOUT_MS),
      ...(token.value === null
        ? {}
        : { headers: { Authorization: `Bearer ${token.value}` } }),
    },
  });
};

export const discoverCachedMcpTools = async ({
  organizationId,
  row,
  safeDb,
  userId,
}: {
  organizationId: SafeId<"organization">;
  row: LoadedMcpConnection;
  safeDb: SafeDb;
  userId: SafeId<"user">;
}): Promise<CachedMcpToolDefinition[]> => {
  const client = await createMcpClientForConnection({
    organizationId,
    row,
    safeDb,
    userId,
  });
  if (!client) {
    return [];
  }

  try {
    const tools = await client.listTools();
    return normalizeDiscoveredMcpTools({
      connectorSlug: row.slug,
      tools: tools.tools,
    });
  } finally {
    await client.close();
  }
};

export const refreshCachedMcpToolsForConnection = async ({
  connectionId,
  organizationId,
  safeDb,
  userId,
}: {
  connectionId: SafeId<"mcpUserConnection">;
  organizationId: SafeId<"organization">;
  safeDb: SafeDb;
  userId: SafeId<"user">;
}): Promise<void> => {
  try {
    const row = await loadMcpConnectionById({
      connectionId,
      organizationId,
      safeDb,
      userId,
    });
    if (!row) {
      return;
    }

    const cachedTools = await discoverCachedMcpTools({
      organizationId,
      row,
      safeDb,
      userId,
    });
    // eslint-disable-next-line arrow-body-style -- block body holds the audit-skip directive
    const updated = await safeDb((tx) => {
      // audit: skip — derived MCP tool-cache metadata, not a user-facing state change
      return tx
        .update(mcpUserConnections)
        .set({
          cachedTools,
          cachedToolsRefreshedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(mcpUserConnections.id, connectionId));
    });
    if (Result.isError(updated)) {
      captureError(updated.error, { source: "mcp-upstream-cache-refresh" });
    }
  } catch (error) {
    captureError(error, { source: "mcp-upstream-cache-refresh" });
  }
};

type ExecutableMcpTool = {
  execute: (
    args: Record<string, unknown>,
    options: typeof MCP_TOOL_EXECUTION_OPTIONS,
  ) => unknown;
};

const isExecutableMcpTool = (value: unknown): value is ExecutableMcpTool =>
  typeof value === "object" &&
  value !== null &&
  "execute" in value &&
  typeof value.execute === "function";

const asCallToolResult = (value: unknown): CallToolResult => {
  const parsed = CallToolResultSchema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }

  return textResult(value);
};

export const proxyMcpToolCall = async ({
  args,
  cachedTool,
  organizationId,
  row,
  safeDb,
  userId,
}: {
  args: Record<string, unknown>;
  cachedTool: CachedMcpToolDefinition;
  organizationId: SafeId<"organization">;
  row: LoadedMcpConnection;
  safeDb: SafeDb;
  userId: SafeId<"user">;
}): Promise<CallToolResult> => {
  const client = await createMcpClientForConnection({
    organizationId,
    row,
    safeDb,
    userId,
  });
  if (!client) {
    return errorResult("External MCP connection is unavailable");
  }

  try {
    const definitions: ListToolsResult = {
      tools: [
        {
          name: cachedTool.rawName,
          inputSchema: cachedTool.inputSchema,
          ...(cachedTool.description === undefined
            ? {}
            : { description: cachedTool.description }),
          ...(cachedTool.title === undefined
            ? {}
            : { title: cachedTool.title }),
          ...(cachedTool.readOnlyHint === undefined
            ? {}
            : { annotations: { readOnlyHint: cachedTool.readOnlyHint } }),
        },
      ],
    };
    const tool = client.toolsFromDefinitions(definitions)[cachedTool.rawName];
    if (!isExecutableMcpTool(tool)) {
      return errorResult("External MCP tool is unavailable");
    }

    const result = await tool.execute(args, MCP_TOOL_EXECUTION_OPTIONS);
    return asCallToolResult(result);
  } finally {
    await client.close();
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

  // eslint-disable-next-line arrow-body-style -- block body holds the audit-skip directive
  const persistResult = await safeDb((tx) => {
    // audit: skip — OAuth token refresh metadata for an existing MCP connection
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
    captureError(persistResult.error, { source: "mcp-upstream-token-refresh" });
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
  // eslint-disable-next-line arrow-body-style -- block body holds the audit-skip directive
  const result = await safeDb((tx) => {
    // audit: skip — derived MCP connection reauth status from failed token validation
    return tx
      .update(mcpUserConnections)
      .set({ status: "needs_reauth", updatedAt: new Date() })
      .where(eq(mcpUserConnections.id, connectionId));
  });
  if (Result.isError(result)) {
    captureError(result.error, { source: "mcp-upstream-mark-needs-reauth" });
  }
};
