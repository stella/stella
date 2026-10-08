import type { CallToolResult } from "@modelcontextprotocol/server";
import { toolDefinition } from "@tanstack/ai";
import { createMCPClient } from "@tanstack/ai-mcp";
import type { MCPClient } from "@tanstack/ai-mcp";
import { panic, Result } from "better-result";
import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";

import { sleep } from "@stll/concurrency/sleep";
import { Temporal } from "@stll/time";

import type { SafeDb } from "@/api/db/safe-db";
import {
  mcpConnectorAuthorizationReviews,
  mcpConnectors,
  mcpOAuthClients,
  mcpUserConnections,
} from "@/api/db/schema";
import type {
  CachedMcpToolDefinition,
  McpConnectionStatus,
} from "@/api/db/schema";
import { createBackgroundAuditRecorder } from "@/api/lib/audit-log";
import type { ThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { getCuratedMcpOAuthApproval } from "@/api/lib/mcp-connectors/catalog-metadata";
import {
  recordMcpAuthorizationReview,
  resolveMcpIssuerBinding,
} from "@/api/lib/mcp-upstream/authorization-review";
import {
  decryptMcpSecret,
  encryptMcpSecret,
} from "@/api/lib/mcp-upstream/crypto";
import {
  MCP_OAUTH_BINDING_FAILURE_CODE,
  MCP_OAUTH_INVALID_GRANT_CODE,
  discoverOAuthMetadata,
  discoverOAuthMetadataForApproval,
  getOAuthEndpointOrigins,
  refreshOAuthToken,
  tokenExpiresAt,
} from "@/api/lib/mcp-upstream/oauth";
import type {
  ApprovedMcpIssuerBinding,
  BoundOAuthMetadata,
  McpIssuerBinding,
} from "@/api/lib/mcp-upstream/oauth";
import { mcpResourceMatchesConnector } from "@/api/lib/mcp-upstream/url-safety";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
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
const MCP_REFRESH_WAIT_ATTEMPTS = 4;
const MCP_REFRESH_WAIT_INTERVAL_MS = 500;
export const MCP_REFRESH_BACKOFF_MS = 30_000;

const CONNECTION_LOAD_FAILED = failureSink({
  event: "mcp_upstream.connection_load_failed",
  expected: [],
});
const CLIENT_SETUP_FAILED = failureSink({
  event: "mcp_upstream.client_setup_failed",
  expected: [],
});
const TOOL_CACHE_REFRESH_FAILED = failureSink({
  event: "mcp_upstream.tool_cache_refresh_failed",
  expected: [],
});
const TOKEN_REFRESH_FAILED = failureSink({
  event: "mcp_upstream.token_refresh_failed",
  expected: [],
});
const CONNECTION_STATUS_WRITE_FAILED = failureSink({
  event: "mcp_upstream.connection_status_write_failed",
  expected: [],
});

type McpAuthorizationReviewRecorderOptions = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};

// Discovery during a tool call or token refresh can find that the connector's
// authorization changed; the review is recorded for the user whose request
// observed it.
const mcpAuthorizationReviewRecorder = ({
  organizationId,
  userId,
}: McpAuthorizationReviewRecorderOptions) =>
  createBackgroundAuditRecorder({
    organizationId,
    workspaceId: null,
    userId,
    execution: {
      performer: {
        type: "service",
        id: "mcp-authorization-review",
        name: "MCP authorization review",
      },
      trigger: { type: "system", source: "mcp_authorization_review" },
    },
  });

type OutboundFetchDependencies = {
  safeOutboundFetchStream: typeof safeOutboundFetchStream;
  validateOutboundFetchTarget: typeof validateOutboundFetchTarget;
};

type ConnectionDependencies = {
  now?: () => Date;
  wait?: (milliseconds: number) => Promise<void>;
  createMCPClient: typeof createMCPClient;
  decryptMcpSecret: typeof decryptMcpSecret;
  encryptMcpSecret: typeof encryptMcpSecret;
  refreshOAuthToken: typeof refreshOAuthToken;
  discoverOAuthMetadata: typeof discoverOAuthMetadata;
  discoverOAuthMetadataForApproval: typeof discoverOAuthMetadataForApproval;
  tokenExpiresAt: typeof tokenExpiresAt;
};

const DEFAULT_CONNECTION_DEPENDENCIES: ConnectionDependencies = {
  createMCPClient,
  discoverOAuthMetadata,
  discoverOAuthMetadataForApproval,
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
  oauthConnectorIssuer: string | null;
  oauthConnectorConfirmedEndpointOrigins: string[] | null;
  oauthReviewApprovedIssuer: string | null;
  oauthReviewApprovedEndpointOrigins: string[] | null;
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
      oauthIssuerBinding: McpIssuerBinding;
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
  oauthConnectorIssuer: mcpConnectors.oauthIssuer,
  oauthConnectorConfirmedEndpointOrigins:
    mcpConnectors.oauthConfirmedEndpointOrigins,
  oauthReviewApprovedIssuer: mcpConnectorAuthorizationReviews.approvedIssuer,
  oauthReviewApprovedEndpointOrigins:
    mcpConnectorAuthorizationReviews.approvedEndpointOrigins,
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
        mcpConnectorAuthorizationReviews,
        and(
          eq(mcpConnectorAuthorizationReviews.connectorId, mcpConnectors.id),
          eq(mcpConnectorAuthorizationReviews.organizationId, organizationId),
        ),
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
          or(
            isNull(mcpConnectorAuthorizationReviews.status),
            eq(mcpConnectorAuthorizationReviews.status, "approved"),
          ),
        ),
      )
      .orderBy(asc(mcpUserConnections.createdAt), asc(mcpUserConnections.id))
      .limit(LIMITS.mcpGatewayConnectorsMax),
  );

  if (Result.isError(rowsResult)) {
    observeFailure(rowsResult.error, { sink: CONNECTION_LOAD_FAILED });
    return [];
  }

  return await normalizeConnectionRows({
    organizationId,
    rows: rowsResult.value,
    safeDb,
    userId,
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
        mcpConnectorAuthorizationReviews,
        and(
          eq(mcpConnectorAuthorizationReviews.connectorId, mcpConnectors.id),
          eq(mcpConnectorAuthorizationReviews.organizationId, organizationId),
        ),
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
          or(
            isNull(mcpConnectorAuthorizationReviews.status),
            eq(mcpConnectorAuthorizationReviews.status, "approved"),
          ),
        ),
      )
      .limit(1),
  );

  if (Result.isError(rowsResult)) {
    observeFailure(rowsResult.error, { sink: CONNECTION_LOAD_FAILED });
    return null;
  }

  const normalized = await normalizeConnectionRows({
    organizationId,
    rows: rowsResult.value,
    safeDb,
    userId,
  });
  return normalized.at(0) ?? null;
};

type NormalizeConnectionRowsOptions = {
  organizationId: SafeId<"organization">;
  rows: RawConnectionRow[];
  safeDb: SafeDb;
  userId: SafeId<"user">;
};

const normalizeConnectionRows = async ({
  organizationId,
  rows,
  safeDb,
  userId,
}: NormalizeConnectionRowsOptions): Promise<LoadedMcpConnection[]> => {
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
  await markConnectionsStatus({
    connectionIds: needsReauthIds,
    organizationId,
    safeDb,
    status: "needs_reauth",
    userId,
  });
  return loaded;
};

export const createMcpClientForConnection = async ({
  permit,
  organizationId,
  dependencies = DEFAULT_CONNECTION_DEPENDENCIES,
  outboundFetch = DEFAULT_OUTBOUND_FETCH_DEPENDENCIES,
  row,
  safeDb,
  userId,
}: {
  permit: ThirdPartyOutboundPermit;
  organizationId: SafeId<"organization">;
  outboundFetch?: OutboundFetchDependencies;
  dependencies?: ConnectionDependencies;
  row: LoadedMcpConnection;
  safeDb: SafeDb;
  userId: SafeId<"user">;
}): Promise<MCPClient | null> => {
  const bound = bindMcpConnection(row);
  if (Result.isError(bound)) {
    observeFailure(bound.error, { sink: CLIENT_SETUP_FAILED });
    const review = await recordMcpAuthorizationReview({
      safeDb,
      organizationId,
      userId,
      connectorId: row.connectorId,
      connection: { type: "mark" },
      recordAuditEvent: mcpAuthorizationReviewRecorder({
        organizationId,
        userId,
      }),
      observedIssuer:
        row.type === "oauth2" ? row.oauthAuthorizationServerUrl : row.url,
    });
    if (Result.isError(review)) {
      observeFailure(review.error, { sink: CLIENT_SETUP_FAILED });
    }
    return null;
  }
  const token = await resolveAuthorizationToken({
    organizationId,
    permit,
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
    observeFailure(target.error, { sink: CLIENT_SETUP_FAILED });
    return null;
  }

  return await dependencies.createMCPClient({
    transport: createBoundMcpTransport({
      row: bound.value,
      token: token.value,
      safeFetch: outboundFetch.safeOutboundFetchStream,
      permit,
    }),
  });
};

type BoundMcpTransportOptions = {
  row: BoundMcpConnection;
  token: string | null;
  permit: ThirdPartyOutboundPermit;
  safeFetch: typeof safeOutboundFetchStream;
};

const createBoundMcpTransport = ({
  row,
  token,
  permit,
  safeFetch,
}: BoundMcpTransportOptions) => ({
  type: "http" as const,
  url: new URL(row.url).toString(),
  fetch: createSafeMcpFetch(safeFetch, permit),
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
  permit,
  organizationId,
  row,
  safeDb,
  userId,
}: {
  permit: ThirdPartyOutboundPermit;
  organizationId: SafeId<"organization">;
  row: LoadedMcpConnection;
  safeDb: SafeDb;
  userId: SafeId<"user">;
}): Promise<DiscoverCachedMcpToolsResult> => {
  const client = await createMcpClientForConnection({
    permit,
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
  permit,
  organizationId,
  safeDb,
  userId,
}: {
  connectionId: SafeId<"mcpUserConnection">;
  permit: ThirdPartyOutboundPermit;
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
      permit,
      organizationId,
      row,
      safeDb,
      userId,
    });
    const updated = await safeDb((tx) =>
      // audit: skip — derived MCP tool-cache metadata, not a user-facing state change
      tx
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
        .where(eq(mcpUserConnections.id, connectionId)),
    );
    if (Result.isError(updated)) {
      observeFailure(updated.error, { sink: TOOL_CACHE_REFRESH_FAILED });
    }
  } catch (error) {
    observeFailure(error, { sink: TOOL_CACHE_REFRESH_FAILED });
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
  permit,
  row,
  safeDb,
  userId,
}: {
  args: Record<string, unknown>;
  cachedTool: CachedMcpToolDefinition;
  dependencies?: ConnectionDependencies;
  outboundFetch?: OutboundFetchDependencies;
  organizationId: SafeId<"organization">;
  permit: ThirdPartyOutboundPermit;
  row: LoadedMcpConnection;
  safeDb: SafeDb;
  userId: SafeId<"user">;
}): Promise<CallToolResult> => {
  const client = await createMcpClientForConnection({
    organizationId,
    permit,
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
  permit: ThirdPartyOutboundPermit,
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
        permit,
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

type RefreshLeaseFence =
  | {
      type: "claimable";
      organizationId: SafeId<"organization">;
      userId: SafeId<"user">;
      now: Date;
    }
  | { type: "held"; leaseExpiresAt: Date };

// An update sets only the columns its write changes: a lease claim or release
// leaves the connection status as it is.
type RefreshLeaseWriteValues = Partial<
  Pick<
    typeof mcpUserConnections.$inferInsert,
    | "accessTokenEncrypted"
    | "accessTokenIv"
    | "expiresAt"
    | "refreshLeaseExpiresAt"
    | "refreshRetryAfter"
    | "refreshTokenEncrypted"
    | "refreshTokenIv"
    | "status"
    | "updatedAt"
  >
>;

type WriteUnderRefreshLeaseOptions = {
  safeDb: SafeDb;
  connectionId: SafeId<"mcpUserConnection">;
  fence: RefreshLeaseFence;
  values: RefreshLeaseWriteValues;
};

const refreshLeaseCondition = (fence: RefreshLeaseFence) => {
  switch (fence.type) {
    case "claimable": {
      const now = sql`${fence.now.toISOString()}::timestamptz`;
      return and(
        eq(mcpUserConnections.organizationId, fence.organizationId),
        eq(mcpUserConnections.userId, fence.userId),
        or(
          isNull(mcpUserConnections.refreshLeaseExpiresAt),
          lte(mcpUserConnections.refreshLeaseExpiresAt, now),
        ),
        or(
          isNull(mcpUserConnections.refreshRetryAfter),
          lte(mcpUserConnections.refreshRetryAfter, now),
        ),
        or(
          isNull(mcpUserConnections.expiresAt),
          lte(
            mcpUserConnections.expiresAt,
            sql`${new Date(fence.now.getTime() + TOKEN_REFRESH_SKEW_MS).toISOString()}::timestamptz`,
          ),
        ),
      );
    }
    case "held":
      return eq(
        mcpUserConnections.refreshLeaseExpiresAt,
        sql`${fence.leaseExpiresAt.toISOString()}::timestamptz`,
      );
    default: {
      fence satisfies never;
      return panic(`Unhandled refresh lease fence: ${JSON.stringify(fence)}`);
    }
  }
};

/**
 * Every write that coordinates or completes a token refresh: claiming the
 * lease, releasing it with a retry time, storing rotated tokens, or marking the
 * connection for reconnection once the grant is gone. A held fence matches only
 * the lease its holder claimed, so a writer whose lease expired changes nothing.
 */
const writeUnderRefreshLease = async ({
  safeDb,
  connectionId,
  fence,
  values,
}: WriteUnderRefreshLeaseOptions) =>
  await safeDb((tx) =>
    // audit: skip — refresh coordination and token rotation for the caller's existing MCP connection
    tx
      .update(mcpUserConnections)
      .set(values)
      .where(
        and(
          eq(mcpUserConnections.id, connectionId),
          eq(mcpUserConnections.status, "connected"),
          refreshLeaseCondition(fence),
        ),
      )
      .returning({
        id: mcpUserConnections.id,
        expiresAt: mcpUserConnections.refreshLeaseExpiresAt,
      }),
  );

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
    await writeUnderRefreshLease({
      safeDb,
      connectionId,
      fence: { type: "claimable", organizationId, userId, now },
      values: {
        refreshLeaseExpiresAt: new Date(now.getTime() + MCP_REFRESH_LEASE_MS),
      },
    })
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
  await writeUnderRefreshLease({
    safeDb,
    connectionId,
    fence: { type: "held", leaseExpiresAt },
    values: { refreshLeaseExpiresAt: null, refreshRetryAfter: retryAfter },
  });

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
    observeFailure(released.error, { sink: TOKEN_REFRESH_FAILED });
  }
};

type ResolveAuthorizationTokenOptions = {
  dependencies: ConnectionDependencies;
  organizationId: SafeId<"organization">;
  permit: ThirdPartyOutboundPermit;
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
  permit,
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
    permit,
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

/**
 * A connector configured before issuers were stored has neither a connector
 * issuer nor a review, so nothing could approve its connections. Discovery
 * records what the connector uses now as a pending review; the review alone
 * keeps the connector's connections from loading, and the observing
 * connection keeps its tokens so it resumes once an administrator approves.
 */
const requestUnconfiguredIssuerReview = async ({
  dependencies,
  organizationId,
  permit,
  row,
  safeDb,
  userId,
}: ResolveOAuthAuthorizationTokenOptions): Promise<void> => {
  const observed = await dependencies.discoverOAuthMetadataForApproval({
    rawMcpUrl: row.url,
    permit,
  });
  if (Result.isError(observed)) {
    // Without observed metadata there is nothing to approve: no review is
    // recorded and the connection stays unused until discovery succeeds.
    observeFailure(observed.error, { sink: CLIENT_SETUP_FAILED });
    return;
  }
  const review = await recordMcpAuthorizationReview({
    safeDb,
    organizationId,
    userId,
    connectorId: row.connectorId,
    connection: { type: "unchanged" },
    recordAuditEvent: mcpAuthorizationReviewRecorder({
      organizationId,
      userId,
    }),
    observedIssuer: observed.value.authorizationServer.issuer,
    observedEndpointOrigins: getOAuthEndpointOrigins(observed.value),
  });
  if (Result.isError(review)) {
    observeFailure(review.error, { sink: CLIENT_SETUP_FAILED });
  }
};

/**
 * The approved issuer the stored connection may use, or null when it cannot
 * be used: its connector awaits review or it was authorized by another issuer.
 */
const approvedStoredMcpIssuer = async (
  options: ResolveOAuthAuthorizationTokenOptions,
): Promise<ApprovedMcpIssuerBinding | null> => {
  const { organizationId, row, safeDb, userId } = options;
  const binding = row.oauthIssuerBinding;
  switch (binding.type) {
    case "unconfigured":
      await requestUnconfiguredIssuerReview(options);
      return null;
    case "approved":
      break;
    default: {
      binding satisfies never;
      return panic("Unhandled MCP issuer binding");
    }
  }
  if (binding.issuer === row.oauthAuthorizationServerUrl) {
    return binding;
  }
  await markConnectionsStatus({
    connectionIds: [row.userConnectionId],
    organizationId,
    safeDb,
    status: "needs_approval",
    userId,
  });
  return null;
};

type ResolveMcpTokenDuringRefreshOptions =
  ResolveOAuthAuthorizationTokenOptions & {
    now: Date;
  };

const resolveMcpTokenDuringRefresh = async ({
  dependencies,
  organizationId,
  permit,
  row,
  safeDb,
  userId,
  now,
}: ResolveMcpTokenDuringRefreshOptions): Promise<ResolvedAuthorizationToken> => {
  if (row.expiresAt && row.expiresAt.getTime() > now.getTime()) {
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
  for (let attempt = 0; attempt < MCP_REFRESH_WAIT_ATTEMPTS; attempt += 1) {
    await (dependencies.wait?.(MCP_REFRESH_WAIT_INTERVAL_MS) ??
      sleep(MCP_REFRESH_WAIT_INTERVAL_MS));
    // db-await-in-loop: bounded wait for a concurrent refresh; each attempt re-reads one row after a pause
    const refreshedRow = await loadMcpConnectionById({
      connectionId: row.userConnectionId,
      organizationId,
      safeDb,
      userId,
    });
    if (!refreshedRow || refreshedRow.type !== "oauth2") {
      return { type: "skip" };
    }
    const currentTime =
      dependencies.now?.() ??
      new Date(Temporal.Now.instant().epochMilliseconds);
    if (
      refreshedRow.expiresAt &&
      refreshedRow.expiresAt.getTime() <= currentTime.getTime()
    ) {
      continue;
    }
    const bound = bindMcpConnection(refreshedRow);
    if (Result.isError(bound)) {
      observeFailure(bound.error, { sink: TOKEN_REFRESH_FAILED });
      return { type: "skip" };
    }
    if (bound.value.type !== "oauth2") {
      return panic("Expected an OAuth connection after binding");
    }
    if (
      (await approvedStoredMcpIssuer({
        dependencies,
        organizationId,
        permit,
        row: bound.value,
        safeDb,
        userId,
      })) === null
    ) {
      return { type: "skip" };
    }
    return {
      type: "ok",
      value: await dependencies.decryptMcpSecret({
        ciphertext: refreshedRow.accessTokenEncrypted,
        connectorId: refreshedRow.connectorId,
        iv: refreshedRow.accessTokenIv,
        organizationId,
        purpose: "mcp_access_token",
        userId,
      }),
    };
  }
  return { type: "skip" };
};

type DiscoverMcpRefreshMetadataOptions =
  ResolveOAuthAuthorizationTokenOptions & {
    issuerBinding: ApprovedMcpIssuerBinding;
    leaseExpiresAt: Date;
    deferRefresh: () => Promise<void>;
  };

const discoverMcpRefreshMetadata = async ({
  dependencies,
  organizationId,
  permit,
  row,
  safeDb,
  userId,
  issuerBinding,
  leaseExpiresAt,
  deferRefresh,
}: DiscoverMcpRefreshMetadataOptions): Promise<BoundOAuthMetadata | null> => {
  const metadata = await dependencies.discoverOAuthMetadata({
    rawMcpUrl: row.url,
    permit,
    confirmedEndpointOrigins: issuerBinding.endpointOrigins,
  });
  const recordAuditEvent = mcpAuthorizationReviewRecorder({
    organizationId,
    userId,
  });
  if (Result.isError(metadata)) {
    observeFailure(metadata.error, { sink: TOKEN_REFRESH_FAILED });
    if (metadata.error.code === "mcp_authorization_approval_required") {
      const observed = await dependencies.discoverOAuthMetadataForApproval({
        rawMcpUrl: row.url,
        permit,
      });
      if (Result.isError(observed)) {
        observeFailure(observed.error, { sink: TOKEN_REFRESH_FAILED });
        await deferRefresh();
        return null;
      }
      const review = await recordMcpAuthorizationReview({
        safeDb,
        organizationId,
        userId,
        connectorId: row.connectorId,
        recordAuditEvent,
        observedIssuer: observed.value.authorizationServer.issuer,
        observedEndpointOrigins: getOAuthEndpointOrigins(observed.value),
        connection: {
          type: "leased",
          connectionId: row.userConnectionId,
          expiresAt: leaseExpiresAt,
        },
      });
      if (Result.isError(review)) {
        observeFailure(review.error, { sink: TOKEN_REFRESH_FAILED });
      }
    } else if (metadata.error.code === MCP_OAUTH_BINDING_FAILURE_CODE) {
      const review = await recordMcpAuthorizationReview({
        safeDb,
        organizationId,
        userId,
        connectorId: row.connectorId,
        recordAuditEvent,
        observedIssuer: row.oauthAuthorizationServerUrl,
        connection: {
          type: "leased",
          connectionId: row.userConnectionId,
          expiresAt: leaseExpiresAt,
        },
      });
      if (Result.isError(review)) {
        observeFailure(review.error, { sink: TOKEN_REFRESH_FAILED });
      }
    } else {
      await deferRefresh();
    }
    return null;
  }
  if (metadata.value.authorizationServer.issuer !== issuerBinding.issuer) {
    const review = await recordMcpAuthorizationReview({
      safeDb,
      organizationId,
      userId,
      connectorId: row.connectorId,
      recordAuditEvent,
      observedIssuer: metadata.value.authorizationServer.issuer,
      observedEndpointOrigins: getOAuthEndpointOrigins(metadata.value),
      connection: {
        type: "leased",
        connectionId: row.userConnectionId,
        expiresAt: leaseExpiresAt,
      },
    });
    if (Result.isError(review)) {
      observeFailure(review.error, { sink: TOKEN_REFRESH_FAILED });
    }
    return null;
  }

  return metadata.value;
};

const resolveOAuthAuthorizationToken = async ({
  dependencies,
  organizationId,
  permit,
  row,
  safeDb,
  userId,
}: ResolveOAuthAuthorizationTokenOptions): Promise<ResolvedAuthorizationToken> => {
  const issuerBinding = await approvedStoredMcpIssuer({
    dependencies,
    organizationId,
    permit,
    row,
    safeDb,
    userId,
  });
  if (issuerBinding === null) {
    return { type: "skip" };
  }
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
    await markNeedsReauth({
      connectionId: row.userConnectionId,
      organizationId,
      safeDb,
      userId,
    });
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
    observeFailure(lease.error, { sink: TOKEN_REFRESH_FAILED });
    return { type: "skip" };
  }
  if (lease.value === null) {
    return await resolveMcpTokenDuringRefresh({
      dependencies,
      organizationId,
      permit,
      row,
      safeDb,
      userId,
      now,
    });
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
  const metadata = await discoverMcpRefreshMetadata({
    dependencies,
    organizationId,
    permit,
    row,
    safeDb,
    userId,
    issuerBinding,
    leaseExpiresAt,
    deferRefresh,
  });
  if (!metadata) {
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
    metadata,
    permit,
    clientId: row.oauthClientId,
    clientSecret,
    refreshToken,
  });

  if (Result.isError(refreshed)) {
    if (refreshed.error.code === MCP_OAUTH_INVALID_GRANT_CODE) {
      await markNeedsReauth({
        connectionId: row.userConnectionId,
        organizationId,
        safeDb,
        userId,
        leaseExpiresAt,
      });
    } else {
      observeFailure(refreshed.error, { sink: TOKEN_REFRESH_FAILED });
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

  const persistResult = await writeUnderRefreshLease({
    safeDb,
    connectionId: row.userConnectionId,
    fence: { type: "held", leaseExpiresAt },
    values: {
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
    },
  });

  if (Result.isError(persistResult)) {
    observeFailure(persistResult.error, { sink: TOKEN_REFRESH_FAILED });
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
      oauthIssuerBinding: resolveMcpIssuerBinding({
        curatedApproval: getCuratedMcpOAuthApproval(rawRow.url),
        connectorIssuer: rawRow.oauthConnectorIssuer,
        connectorConfirmedEndpointOrigins:
          rawRow.oauthConnectorConfirmedEndpointOrigins,
        reviewApprovedIssuer: rawRow.oauthReviewApprovedIssuer,
        reviewApprovedEndpointOrigins:
          rawRow.oauthReviewApprovedEndpointOrigins,
      }),
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

type MarkNeedsReauthOptions = {
  connectionId: SafeId<"mcpUserConnection">;
  organizationId: SafeId<"organization">;
  safeDb: SafeDb;
  userId: SafeId<"user">;
  leaseExpiresAt?: Date;
};

const markNeedsReauth = async ({
  connectionId,
  organizationId,
  safeDb,
  userId,
  leaseExpiresAt,
}: MarkNeedsReauthOptions) => {
  if (!leaseExpiresAt) {
    await markConnectionsStatus({
      connectionIds: [connectionId],
      organizationId,
      safeDb,
      status: "needs_reauth",
      userId,
    });
    return;
  }
  const result = await writeUnderRefreshLease({
    safeDb,
    connectionId,
    fence: { type: "held", leaseExpiresAt },
    values: {
      status: "needs_reauth",
      refreshLeaseExpiresAt: null,
      updatedAt: new Date(),
    },
  });
  if (Result.isError(result)) {
    observeFailure(result.error, { sink: CONNECTION_STATUS_WRITE_FAILED });
  }
};

type MarkConnectionsStatusOptions = {
  connectionIds: readonly SafeId<"mcpUserConnection">[];
  organizationId: SafeId<"organization">;
  safeDb: SafeDb;
  status: Extract<McpConnectionStatus, "needs_approval" | "needs_reauth">;
  userId: SafeId<"user">;
};

const markConnectionsStatus = async ({
  connectionIds,
  organizationId,
  safeDb,
  status,
  userId,
}: MarkConnectionsStatusOptions) => {
  if (connectionIds.length === 0) {
    return;
  }
  const result = await safeDb((tx) =>
    // audit: skip — derived status for the caller's existing MCP connections once stored credentials or authorization no longer apply
    tx
      .update(mcpUserConnections)
      .set({ status, refreshLeaseExpiresAt: null, updatedAt: new Date() })
      .where(
        and(
          inArray(mcpUserConnections.id, connectionIds),
          eq(mcpUserConnections.organizationId, organizationId),
          eq(mcpUserConnections.userId, userId),
          eq(mcpUserConnections.status, "connected"),
        ),
      ),
  );
  if (Result.isError(result)) {
    observeFailure(result.error, { sink: CONNECTION_STATUS_WRITE_FAILED });
  }
};
