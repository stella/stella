import type { CallToolResult } from "@modelcontextprotocol/server";
import { toolDefinition } from "@tanstack/ai";
import { createMCPClient } from "@tanstack/ai-mcp";
import type { MCPClient } from "@tanstack/ai-mcp";
import { panic, Result } from "better-result";
import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";

import { Temporal } from "@stll/time";

import type { SafeDb } from "@/api/db/safe-db";
import {
  mcpConnectors,
  mcpOAuthClients,
  mcpUserConnections,
} from "@/api/db/schema";
import type { CachedMcpToolDefinition } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { recordMcpAuthorizationReview } from "@/api/lib/mcp-upstream/authorization-review";
import {
  decryptMcpSecret,
  encryptMcpSecret,
} from "@/api/lib/mcp-upstream/crypto";
import {
  MCP_OAUTH_BINDING_FAILURE_CODE,
  MCP_OAUTH_INVALID_GRANT_CODE,
  discoverOAuthMetadata,
  refreshOAuthToken,
  tokenExpiresAt,
} from "@/api/lib/mcp-upstream/oauth";
import { mcpResourceMatchesConnector } from "@/api/lib/mcp-upstream/url-safety";
import {
  safeOutboundFetchStream,
  validateOutboundFetchTarget,
} from "@/api/lib/safe-outbound-fetch";
import type { SafeOutboundFetchBody } from "@/api/lib/safe-outbound-fetch";
import {
  errorResult,
  serializeMcpData,
  serializeToolResult,
} from "@/api/mcp/tool-utils";

import { normalizeDiscoveredMcpTools } from "./cached-tools";

const MCP_DISCOVERY_REQUEST_TIMEOUT_MS = 10_000;
export const MCP_TOOL_EXECUTION_REQUEST_TIMEOUT_MS = 5 * 60_000;
const MCP_HTTP_RESPONSE_MAX_BYTES = 10_000_000;
const MCP_CALL_TOOL_METHOD = "tools/call";
const TOKEN_REFRESH_SKEW_MS = 60_000;
const MCP_REFRESH_LEASE_MS = 90_000;
export const MCP_REFRESH_BACKOFF_MS = 30_000;

type OutboundFetchDependencies = {
  safeOutboundFetchStream: typeof safeOutboundFetchStream;
  validateOutboundFetchTarget: typeof validateOutboundFetchTarget;
};

type ConnectionDependencies = {
  now?: () => Date;
  createMCPClient: typeof createMCPClient;
  decryptMcpSecret: typeof decryptMcpSecret;
  encryptMcpSecret: typeof encryptMcpSecret;
  refreshOAuthToken: typeof refreshOAuthToken;
  discoverOAuthMetadata: typeof discoverOAuthMetadata;
  tokenExpiresAt: typeof tokenExpiresAt;
};

const DEFAULT_CONNECTION_DEPENDENCIES: ConnectionDependencies = {
  createMCPClient,
  discoverOAuthMetadata,
  decryptMcpSecret,
  encryptMcpSecret,
  refreshOAuthToken,
  tokenExpiresAt,
};

const DEFAULT_OUTBOUND_FETCH_DEPENDENCIES: OutboundFetchDependencies = {
  safeOutboundFetchStream,
  validateOutboundFetchTarget,
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

const boundMcpConnection = Symbol("BoundMcpConnection");

type BoundMcpConnection = Readonly<LoadedMcpConnection> & {
  readonly [boundMcpConnection]: true;
};

const bindMcpConnection = (
  row: LoadedMcpConnection,
): Result<BoundMcpConnection, HandlerError<502>> => {
  if (row.type === "oauth2") {
    const matches = Result.try(() =>
      mcpResourceMatchesConnector({
        resourceUrl: row.oauthResourceUrl,
        connectorUrl: row.url,
      }),
    );
    if (Result.isError(matches) || !matches.value) {
      return Result.err(
        new HandlerError({
          status: 502,
          message: "MCP connection resource does not match the connector URL",
        }),
      );
    }
  }
  return Result.ok(
    Object.freeze({ ...row, [boundMcpConnection]: true as const }),
  );
};

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
  const loaded: LoadedMcpConnection[] = [];
  const needsReauthIds: SafeId<"mcpUserConnection">[] = [];
  for (const rawRow of rows) {
    const normalized = normalizeMcpConnectionRow(rawRow);
    switch (normalized.type) {
      case "loaded":
        loaded.push(normalized.connection);
        break;
      case "needsReauth":
        needsReauthIds.push(normalized.connectionId);
        break;
      case "unusable":
        break;
      default: {
        normalized satisfies never;
        return panic(
          `Unhandled MCP connection row: ${JSON.stringify(normalized)}`,
        );
      }
    }
  }
  // Every malformed OAuth row is repaired by one statement.
  await markConnectionsNeedReauth({ connectionIds: needsReauthIds, safeDb });
  return loaded;
};

export const createMcpClientForConnection = async ({
  organizationId,
  dependencies = DEFAULT_CONNECTION_DEPENDENCIES,
  outboundFetch = DEFAULT_OUTBOUND_FETCH_DEPENDENCIES,
  row,
  safeDb,
  userId,
}: {
  organizationId: SafeId<"organization">;
  outboundFetch?: OutboundFetchDependencies;
  dependencies?: ConnectionDependencies;
  row: LoadedMcpConnection;
  safeDb: SafeDb;
  userId: SafeId<"user">;
}): Promise<MCPClient | null> => {
  const bound = bindMcpConnection(row);
  if (Result.isError(bound)) {
    captureError(bound.error, {
      source: "mcp-upstream-client",
      connectorSlug: row.slug,
    });
    const review = await recordMcpAuthorizationReview({
      safeDb,
      organizationId,
      userId,
      connectorId: row.connectorId,
      observedIssuer:
        row.type === "oauth2" ? row.oauthAuthorizationServerUrl : row.url,
    });
    if (Result.isError(review)) {
      captureError(review.error, { source: "mcp-upstream-client" });
    }
    return null;
  }
  const token = await resolveAuthorizationToken({
    organizationId,
    row: bound.value,
    safeDb,
    userId,
    dependencies,
  });
  if (token.type === "skip") {
    return null;
  }

  const target = await outboundFetch.validateOutboundFetchTarget(
    bound.value.url,
  );
  if (Result.isError(target)) {
    captureError(target.error, {
      source: "mcp-upstream-client",
      connectorSlug: row.slug,
    });
    return null;
  }

  return await dependencies.createMCPClient({
    transport: createBoundMcpTransport({
      row: bound.value,
      token: token.value,
      safeFetch: outboundFetch.safeOutboundFetchStream,
    }),
  });
};

type BoundMcpTransportOptions = {
  row: BoundMcpConnection;
  token: string | null;
  safeFetch: typeof safeOutboundFetchStream;
};

const createBoundMcpTransport = ({
  row,
  token,
  safeFetch,
}: BoundMcpTransportOptions) => ({
  type: "http" as const,
  url: new URL(row.url).toString(),
  fetch: createSafeMcpFetch(safeFetch),
  ...(token === null ? {} : { headers: { Authorization: `Bearer ${token}` } }),
});

/** Metadata the upstream server reports during the MCP `initialize`
 * handshake. `null` when no authenticated client could be opened. */
type McpServerMetadata = {
  version: string | null;
  instructions: string | null;
};

type DiscoverCachedMcpToolsResult = {
  tools: CachedMcpToolDefinition[];
  server: McpServerMetadata | null;
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
}): Promise<DiscoverCachedMcpToolsResult> => {
  const client = await createMcpClientForConnection({
    organizationId,
    row,
    safeDb,
    userId,
  });
  if (!client) {
    return { tools: [], server: null };
  }

  try {
    const tools = await client.tools();
    return {
      tools: normalizeDiscoveredMcpTools({
        connectorSlug: row.slug,
        tools,
      }),
      // Bound what an upstream server can persist on our connector row and
      // ship in the catalogue payload; the values are server-controlled.
      server: {
        version: null,
        instructions: null,
      },
    };
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

    const { tools: cachedTools, server } = await discoverCachedMcpTools({
      organizationId,
      row,
      safeDb,
      userId,
    });
    // oxlint-disable-next-line arrow-body-style -- block body holds the audit-skip directive
    const updated = await safeDb((tx) => {
      // audit: skip — derived MCP tool-cache metadata, not a user-facing state change
      return tx
        .update(mcpUserConnections)
        .set({
          cachedTools,
          cachedToolsRefreshedAt: new Date(),
          // Server-reported metadata, captured with this user's
          // credentials and kept on their own connection row.
          serverVersion: server?.version ?? null,
          instructions: server?.instructions ?? null,
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
  execute: (args: Record<string, unknown>) => unknown;
};

const isExecutableMcpTool = (value: unknown): value is ExecutableMcpTool =>
  typeof value === "object" &&
  value !== null &&
  "execute" in value &&
  typeof value.execute === "function";

// `@tanstack/ai-mcp` deliberately unwraps the protocol result before exposing
// `execute`: text content becomes a string and declared structured output
// becomes the raw object. Treat every value here as application output. A raw
// object that happens to contain `content` or `resultType` must not be trusted
// as a protocol envelope and allowed to overwrite our own result shape.
const asCallToolResult = (value: unknown): CallToolResult =>
  serializeMcpData(value);

export const proxyMcpToolCall = async ({
  args,
  cachedTool,
  dependencies,
  outboundFetch,
  organizationId,
  row,
  safeDb,
  userId,
}: {
  args: Record<string, unknown>;
  cachedTool: CachedMcpToolDefinition;
  dependencies?: ConnectionDependencies;
  outboundFetch?: OutboundFetchDependencies;
  organizationId: SafeId<"organization">;
  row: LoadedMcpConnection;
  safeDb: SafeDb;
  userId: SafeId<"user">;
}): Promise<CallToolResult> => {
  const client = await createMcpClientForConnection({
    organizationId,
    ...(dependencies === undefined ? {} : { dependencies }),
    ...(outboundFetch === undefined ? {} : { outboundFetch }),
    row,
    safeDb,
    userId,
  });
  if (!client) {
    return serializeToolResult(
      errorResult("External MCP connection is unavailable"),
    );
  }

  try {
    const tools = await client.tools(
      [
        toolDefinition({
          name: cachedTool.rawName,
          description:
            cachedTool.description ?? cachedTool.title ?? cachedTool.rawName,
          inputSchema: cachedTool.inputSchema,
        }),
      ],
      { callToolTimeoutMs: MCP_TOOL_EXECUTION_REQUEST_TIMEOUT_MS },
    );
    const tool: unknown = tools.at(0);
    if (!isExecutableMcpTool(tool)) {
      return serializeToolResult(
        errorResult("External MCP tool is unavailable"),
      );
    }

    const result = await tool.execute(args);
    return asCallToolResult(result);
  } finally {
    await client.close();
  }
};

const createSafeMcpFetch = (
  safeOutboundFetchStreamImpl: typeof safeOutboundFetchStream,
): typeof fetch => {
  const safeFetch: typeof fetch = Object.assign(
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      if (init?.signal?.aborted) {
        throw init.signal.reason;
      }

      const url = mcpFetchUrl(input);
      const body = await mcpFetchBody(input, init);
      const response = await safeOutboundFetchStreamImpl({
        body,
        headers: mcpFetchHeaders(input, init),
        maxBytes: MCP_HTTP_RESPONSE_MAX_BYTES,
        method:
          init?.method ?? (input instanceof Request ? input.method : "GET"),
        signal:
          init?.signal ?? (input instanceof Request ? input.signal : undefined),
        timeoutMs: mcpRequestTimeoutMs(body),
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

const mcpRequestTimeoutMs = (
  body: SafeOutboundFetchBody | undefined,
): number => {
  const text = mcpFetchBodyText(body);
  if (text === null) {
    return MCP_DISCOVERY_REQUEST_TIMEOUT_MS;
  }

  const parsed = Result.try((): unknown => JSON.parse(text));
  if (Result.isError(parsed)) {
    return MCP_DISCOVERY_REQUEST_TIMEOUT_MS;
  }

  const messages = Array.isArray(parsed.value) ? parsed.value : [parsed.value];
  return messages.some(isMcpCallToolRequest)
    ? MCP_TOOL_EXECUTION_REQUEST_TIMEOUT_MS
    : MCP_DISCOVERY_REQUEST_TIMEOUT_MS;
};

const mcpFetchBodyText = (
  body: SafeOutboundFetchBody | undefined,
): string | null => {
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof ArrayBuffer || body instanceof Uint8Array) {
    return new TextDecoder().decode(body);
  }
  return null;
};

const isMcpCallToolRequest = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  "method" in value &&
  value.method === MCP_CALL_TOOL_METHOD;

const mcpFetchUrl = (input: Parameters<typeof fetch>[0]): URL => {
  if (input instanceof Request) {
    return new URL(input.url);
  }

  return new URL(input.toString());
};

const mcpFetchHeaders = (
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1] | undefined,
): Headers => {
  const headers = new Headers(input instanceof Request ? input.headers : {});
  const initHeaders = new Headers(init?.headers);
  for (const [key, value] of initHeaders.entries()) {
    headers.set(key, value);
  }
  return headers;
};

const mcpFetchBody = async (
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1] | undefined,
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

  return panic("Unsupported MCP request body type");
};

type ClaimMcpRefreshLeaseOptions = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  connectionId: SafeId<"mcpUserConnection">;
  now: Date;
};

export const claimMcpRefreshLease = async ({
  safeDb,
  organizationId,
  userId,
  connectionId,
  now,
}: ClaimMcpRefreshLeaseOptions) =>
  (
    await safeDb((tx) =>
      // audit: skip — bounded refresh coordination for the caller's connection
      tx
        .update(mcpUserConnections)
        .set({
          refreshLeaseExpiresAt: new Date(now.getTime() + MCP_REFRESH_LEASE_MS),
        })
        .where(
          and(
            eq(mcpUserConnections.id, connectionId),
            eq(mcpUserConnections.organizationId, organizationId),
            eq(mcpUserConnections.userId, userId),
            eq(mcpUserConnections.status, "connected"),
            or(
              isNull(mcpUserConnections.refreshLeaseExpiresAt),
              lte(
                mcpUserConnections.refreshLeaseExpiresAt,
                sql`${now.toISOString()}::timestamptz`,
              ),
            ),
            or(
              isNull(mcpUserConnections.refreshRetryAfter),
              lte(
                mcpUserConnections.refreshRetryAfter,
                sql`${now.toISOString()}::timestamptz`,
              ),
            ),
            or(
              isNull(mcpUserConnections.expiresAt),
              lte(
                mcpUserConnections.expiresAt,
                sql`${new Date(now.getTime() + TOKEN_REFRESH_SKEW_MS).toISOString()}::timestamptz`,
              ),
            ),
          ),
        )
        .returning({ expiresAt: mcpUserConnections.refreshLeaseExpiresAt }),
    )
  ).map((rows) => rows.at(0)?.expiresAt ?? null);

type ReleaseMcpRefreshLeaseOptions = {
  safeDb: SafeDb;
  connectionId: SafeId<"mcpUserConnection">;
  leaseExpiresAt: Date;
  retryAfter: Date;
};

export const releaseMcpRefreshLease = async ({
  safeDb,
  connectionId,
  leaseExpiresAt,
  retryAfter,
}: ReleaseMcpRefreshLeaseOptions) =>
  await safeDb((tx) =>
    // audit: skip — retry timing for an existing connection
    tx
      .update(mcpUserConnections)
      .set({ refreshLeaseExpiresAt: null, refreshRetryAfter: retryAfter })
      .where(
        and(
          eq(mcpUserConnections.id, connectionId),
          eq(mcpUserConnections.status, "connected"),
          eq(
            mcpUserConnections.refreshLeaseExpiresAt,
            sql`${leaseExpiresAt.toISOString()}::timestamptz`,
          ),
        ),
      ),
  );

type DeferMcpRefreshOptions = {
  safeDb: SafeDb;
  connectionId: SafeId<"mcpUserConnection">;
  leaseExpiresAt: Date;
  now: Date;
};

const deferMcpRefresh = async ({
  safeDb,
  connectionId,
  leaseExpiresAt,
  now,
}: DeferMcpRefreshOptions) => {
  const released = await releaseMcpRefreshLease({
    safeDb,
    connectionId,
    leaseExpiresAt,
    retryAfter: new Date(now.getTime() + MCP_REFRESH_BACKOFF_MS),
  });
  if (Result.isError(released)) {
    captureError(released.error, { source: "mcp-upstream-token-refresh" });
  }
};

type ResolveAuthorizationTokenOptions = {
  dependencies: ConnectionDependencies;
  organizationId: SafeId<"organization">;
  row: BoundMcpConnection;
  safeDb: SafeDb;
  userId: SafeId<"user">;
};

type ResolvedAuthorizationToken =
  | { type: "ok"; value: string | null }
  | { type: "skip" };

const resolveAuthorizationToken = async ({
  dependencies,
  organizationId,
  row,
  safeDb,
  userId,
}: ResolveAuthorizationTokenOptions): Promise<ResolvedAuthorizationToken> => {
  if (row.type === "none") {
    return { type: "ok", value: null };
  }

  if (row.type === "bearer") {
    return {
      type: "ok",
      value: await dependencies.decryptMcpSecret({
        ciphertext: row.staticTokenEncrypted,
        connectorId: row.connectorId,
        iv: row.staticTokenIv,
        organizationId,
        purpose: "mcp_static_token",
        userId,
      }),
    };
  }

  return await resolveOAuthAuthorizationToken({
    dependencies,
    organizationId,
    row,
    safeDb,
    userId,
  });
};

type ResolveOAuthAuthorizationTokenOptions = Omit<
  ResolveAuthorizationTokenOptions,
  "row"
> & {
  row: Extract<BoundMcpConnection, { type: "oauth2" }>;
};

const resolveOAuthAuthorizationToken = async ({
  dependencies,
  organizationId,
  row,
  safeDb,
  userId,
}: ResolveOAuthAuthorizationTokenOptions): Promise<ResolvedAuthorizationToken> => {
  const now =
    dependencies.now?.() ?? new Date(Temporal.Now.instant().epochMilliseconds);
  if (
    !row.expiresAt ||
    row.expiresAt.getTime() > now.getTime() + TOKEN_REFRESH_SKEW_MS
  ) {
    return {
      type: "ok",
      value: await dependencies.decryptMcpSecret({
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

  const lease = await claimMcpRefreshLease({
    safeDb,
    organizationId,
    userId,
    connectionId: row.userConnectionId,
    now,
  });
  if (Result.isError(lease)) {
    captureError(lease.error, { source: "mcp-upstream-token-refresh" });
    return { type: "skip" };
  }
  if (lease.value === null) {
    return { type: "skip" };
  }
  const leaseExpiresAt = lease.value;
  const deferRefresh = async () =>
    await deferMcpRefresh({
      safeDb,
      connectionId: row.userConnectionId,
      leaseExpiresAt,
      now:
        dependencies.now?.() ??
        new Date(Temporal.Now.instant().epochMilliseconds),
    });
  const metadata = await dependencies.discoverOAuthMetadata(row.url);
  if (Result.isError(metadata)) {
    captureError(metadata.error, { source: "mcp-upstream-token-refresh" });
    if (metadata.error.code === MCP_OAUTH_BINDING_FAILURE_CODE) {
      const review = await recordMcpAuthorizationReview({
        safeDb,
        organizationId,
        userId,
        connectorId: row.connectorId,
        observedIssuer: row.oauthAuthorizationServerUrl,
        lease: {
          connectionId: row.userConnectionId,
          expiresAt: leaseExpiresAt,
        },
      });
      if (Result.isError(review)) {
        captureError(review.error, { source: "mcp-upstream-token-refresh" });
      }
    } else {
      await deferRefresh();
    }
    return { type: "skip" };
  }
  if (
    metadata.value.authorizationServer.issuer !==
    row.oauthAuthorizationServerUrl
  ) {
    const review = await recordMcpAuthorizationReview({
      safeDb,
      organizationId,
      userId,
      connectorId: row.connectorId,
      observedIssuer: metadata.value.authorizationServer.issuer,
      lease: { connectionId: row.userConnectionId, expiresAt: leaseExpiresAt },
    });
    if (Result.isError(review)) {
      captureError(review.error, { source: "mcp-upstream-token-refresh" });
    }
    return { type: "skip" };
  }

  const refreshToken = await dependencies.decryptMcpSecret({
    ciphertext: row.refreshTokenEncrypted,
    connectorId: row.connectorId,
    iv: row.refreshTokenIv,
    organizationId,
    purpose: "mcp_refresh_token",
    userId,
  });
  const clientSecret =
    row.oauthClientSecretEncrypted && row.oauthClientSecretIv
      ? await dependencies.decryptMcpSecret({
          ciphertext: row.oauthClientSecretEncrypted,
          connectorId: row.connectorId,
          iv: row.oauthClientSecretIv,
          organizationId,
          purpose: "mcp_client_secret",
        })
      : null;
  const refreshed = await dependencies.refreshOAuthToken({
    metadata: metadata.value,
    clientId: row.oauthClientId,
    clientSecret,
    refreshToken,
  });

  if (Result.isError(refreshed)) {
    if (refreshed.error.code === MCP_OAUTH_INVALID_GRANT_CODE) {
      await markNeedsReauth({
        connectionId: row.userConnectionId,
        safeDb,
        leaseExpiresAt,
      });
    } else {
      captureError(refreshed.error, { source: "mcp-upstream-token-refresh" });
      await deferRefresh();
    }
    return { type: "skip" };
  }

  const encryptedAccess = await dependencies.encryptMcpSecret({
    connectorId: row.connectorId,
    organizationId,
    purpose: "mcp_access_token",
    secret: refreshed.value.access_token,
    userId,
  });
  const encryptedRefresh = refreshed.value.refresh_token
    ? await dependencies.encryptMcpSecret({
        connectorId: row.connectorId,
        organizationId,
        purpose: "mcp_refresh_token",
        secret: refreshed.value.refresh_token,
        userId,
      })
    : null;

  // oxlint-disable-next-line arrow-body-style -- block body holds the audit-skip directive
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
        expiresAt: dependencies.tokenExpiresAt(refreshed.value),
        status: "connected",
        refreshLeaseExpiresAt: null,
        refreshRetryAfter: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(mcpUserConnections.id, row.userConnectionId),
          eq(mcpUserConnections.status, "connected"),
          eq(
            mcpUserConnections.refreshLeaseExpiresAt,
            sql`${leaseExpiresAt.toISOString()}::timestamptz`,
          ),
        ),
      )
      .returning({ id: mcpUserConnections.id });
  });

  if (Result.isError(persistResult)) {
    captureError(persistResult.error, { source: "mcp-upstream-token-refresh" });
    return { type: "skip" };
  }
  if (persistResult.value.length === 0) {
    return { type: "skip" };
  }

  return { type: "ok", value: refreshed.value.access_token };
};

/**
 * What a stored row can serve, decided without I/O. An OAuth row missing the
 * material a refresh needs cannot recover by itself, so it asks the caller to
 * mark it for reauthorization.
 */
type NormalizedConnectionRow =
  | { type: "loaded"; connection: LoadedMcpConnection }
  | { type: "needsReauth"; connectionId: SafeId<"mcpUserConnection"> }
  | { type: "unusable" };

const normalizeMcpConnectionRow = (
  rawRow: RawConnectionRow,
): NormalizedConnectionRow => {
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
    return { type: "loaded", connection: { ...base, type: "none" } };
  }

  if (rawRow.authType === "bearer") {
    if (!rawRow.staticTokenEncrypted || !rawRow.staticTokenIv) {
      return { type: "unusable" };
    }

    return {
      type: "loaded",
      connection: {
        ...base,
        staticTokenEncrypted: rawRow.staticTokenEncrypted,
        staticTokenIv: rawRow.staticTokenIv,
        type: "bearer",
      },
    };
  }

  if (
    !rawRow.accessTokenEncrypted ||
    !rawRow.accessTokenIv ||
    !rawRow.oauthAuthorizationServerUrl ||
    !rawRow.oauthClientId ||
    !rawRow.oauthResourceUrl
  ) {
    return { type: "needsReauth", connectionId: rawRow.userConnectionId };
  }

  return {
    type: "loaded",
    connection: {
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
    },
  };
};

const markNeedsReauth = async ({
  connectionId,
  safeDb,
  leaseExpiresAt,
}: {
  connectionId: SafeId<"mcpUserConnection">;
  safeDb: SafeDb;
  leaseExpiresAt?: Date;
}) => {
  if (!leaseExpiresAt) {
    await markConnectionsNeedReauth({ connectionIds: [connectionId], safeDb });
    return;
  }
  const result = await safeDb((tx) =>
    // audit: skip — derived status for an existing connection
    tx
      .update(mcpUserConnections)
      .set({
        status: "needs_reauth",
        refreshLeaseExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(mcpUserConnections.id, connectionId),
          eq(mcpUserConnections.status, "connected"),
          eq(
            mcpUserConnections.refreshLeaseExpiresAt,
            sql`${leaseExpiresAt.toISOString()}::timestamptz`,
          ),
        ),
      ),
  );
  if (Result.isError(result)) {
    captureError(result.error, { source: "mcp-upstream-token-refresh" });
  }
};

const markConnectionsNeedReauth = async ({
  connectionIds,
  safeDb,
}: {
  connectionIds: readonly SafeId<"mcpUserConnection">[];
  safeDb: SafeDb;
}) => {
  if (connectionIds.length === 0) {
    return;
  }
  // oxlint-disable-next-line arrow-body-style -- block body holds the audit-skip directive
  const result = await safeDb((tx) => {
    // audit: skip — derived MCP connection reauth status from failed token validation
    return tx
      .update(mcpUserConnections)
      .set({ status: "needs_reauth", updatedAt: new Date() })
      .where(inArray(mcpUserConnections.id, connectionIds));
  });
  if (Result.isError(result)) {
    captureError(result.error, { source: "mcp-upstream-mark-needs-reauth" });
  }
};
