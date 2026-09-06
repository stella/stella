import type { CallToolResult } from "@modelcontextprotocol/server";
import { Result } from "better-result";
import { and, asc, eq } from "drizzle-orm";

import { mcpConnectors, mcpUserConnections } from "@/api/db/schema";
import type { CachedMcpToolDefinition } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { LIMITS } from "@/api/lib/limits";
import { readCachedMcpTools } from "@/api/lib/mcp-upstream/cached-tools";
import {
  loadActiveMcpConnectionsForUser,
  proxyMcpToolCall,
  refreshCachedMcpToolsForConnection,
} from "@/api/lib/mcp-upstream/connections";
import type { LoadedMcpConnection } from "@/api/lib/mcp-upstream/connections";
import type { McpRequestContext } from "@/api/mcp/context";
import { McpGatewayLoadError } from "@/api/mcp/errors";
import { consumeMcpGatewayRateLimit } from "@/api/mcp/gateway/rate-limit";
import type { InternalToolErrorResult } from "@/api/mcp/tool-types";
import {
  MCP_INTERNAL_ERROR_HINT,
  serializeToolResult,
  structuredErrorResult,
} from "@/api/mcp/tool-utils";

const mcpStructuredErrorResult = (
  args: Parameters<typeof structuredErrorResult>[0],
): CallToolResult => serializeToolResult(structuredErrorResult(args));

export type ExternalGatewayDependencies = {
  loadActiveMcpConnectionsForUser: typeof loadActiveMcpConnectionsForUser;
  proxyMcpToolCall: typeof proxyMcpToolCall;
  refreshCachedMcpToolsForConnection: typeof refreshCachedMcpToolsForConnection;
};

const defaultDependencies: ExternalGatewayDependencies = {
  loadActiveMcpConnectionsForUser,
  proxyMcpToolCall,
  refreshCachedMcpToolsForConnection,
};

type GatewayConnectionToolRow = {
  cachedTools: CachedMcpToolDefinition[] | null;
  connectorId: typeof mcpConnectors.$inferSelect.id;
  displayName: string;
  slug: string;
  userConnectionId: typeof mcpUserConnections.$inferSelect.id;
  allowedTools: string[] | null;
};

export type ResolvedExternalMcpTool = {
  cachedTool: CachedMcpToolDefinition;
  connectorDisplayName: string;
  connectorSlug: string;
  connection: LoadedMcpConnection;
};

/**
 * Map a dynamic-gateway load fault to a retryable `internal_error` envelope, or
 * `null` when the error is not a load fault (the caller rethrows). Shared by the
 * external and skill dispatch paths so a transient backing-store outage answers
 * a `tools/call` with a retryable error instead of a non-retryable
 * `unknown_tool`. The underlying failure was captured at the load site.
 */
export const gatewayLoadErrorResult = (
  error: unknown,
): InternalToolErrorResult | null =>
  error instanceof McpGatewayLoadError
    ? structuredErrorResult({
        code: "internal_error",
        message: "MCP gateway tools are temporarily unavailable",
        retryable: true,
        hint: MCP_INTERNAL_ERROR_HINT,
      })
    : null;

export const listGatewayExternalMcpTools = async ({
  context,
  dependencies = defaultDependencies,
}: {
  context: McpRequestContext;
  dependencies?: ExternalGatewayDependencies;
}): Promise<ResolvedExternalMcpTool[]> => {
  let cachedRows = await loadCachedGatewayToolRows({ context });
  if (cachedRows.length === 0) {
    return [];
  }

  if (
    await refreshMissingCachedTools({ context, rows: cachedRows, dependencies })
  ) {
    cachedRows = await loadCachedGatewayToolRows({ context });
  }

  const connections = await dependencies.loadActiveMcpConnectionsForUser({
    organizationId: context.organizationId,
    safeDb: context.safeDb,
    userId: context.userId,
  });
  const connectionsById = new Map(
    connections.map((connection) => [connection.userConnectionId, connection]),
  );
  const tools: ResolvedExternalMcpTool[] = [];

  for (const row of cachedRows) {
    const connection = connectionsById.get(row.userConnectionId);
    if (!connection) {
      continue;
    }

    const allowedTools = row.allowedTools ? new Set(row.allowedTools) : null;
    for (const cachedTool of readCachedMcpTools(row.cachedTools)) {
      if (allowedTools && !allowedTools.has(cachedTool.rawName)) {
        continue;
      }
      tools.push({
        cachedTool,
        connectorDisplayName: row.displayName,
        connectorSlug: row.slug,
        connection,
      });
    }
  }

  return tools;
};

export const resolveGatewayExternalMcpTool = async ({
  context,
  toolName,
  dependencies = defaultDependencies,
}: {
  context: McpRequestContext;
  toolName: string;
  dependencies?: ExternalGatewayDependencies;
}): Promise<ResolvedExternalMcpTool | null> =>
  (await listGatewayExternalMcpTools({ context, dependencies })).find(
    ({ cachedTool }) => cachedTool.exposedName === toolName,
  ) ?? null;

export const callGatewayExternalMcpTool = async ({
  args,
  context,
  toolName,
  dependencies = defaultDependencies,
}: {
  args: Record<string, unknown>;
  context: McpRequestContext;
  toolName: string;
  dependencies?: ExternalGatewayDependencies;
}) => {
  let resolved: ResolvedExternalMcpTool | null;
  try {
    resolved = await resolveGatewayExternalMcpTool({
      context,
      toolName,
      dependencies,
    });
  } catch (error) {
    // A load fault means we cannot tell whether the tool exists: answer with a
    // retryable error, never a definitive `unknown_tool`.
    const loadError = gatewayLoadErrorResult(error);
    if (loadError) {
      return serializeToolResult(loadError);
    }
    throw error;
  }
  if (!resolved) {
    return mcpStructuredErrorResult({
      code: "unknown_tool",
      message: `Unknown tool: ${toolName}`,
      hint: "Call tools/list for the tools available to this session.",
    });
  }

  const allowed = await consumeMcpGatewayRateLimit({
    connectorSlug: resolved.connectorSlug,
    userId: context.userId,
  });
  if (!allowed) {
    await recordGatewayToolAudit({
      context,
      durationMs: 0,
      outcome: "rate_limited",
      resolved,
      toolKind: "external_mcp",
    });
    return mcpStructuredErrorResult({
      code: "rate_limited",
      message: "External MCP tool rate limit exceeded",
      retryable: true,
      hint: `Too many calls to this connector. Retry after up to ${LIMITS.mcpGatewayRateLimitWindowMs} ms.`,
    });
  }

  const startedAt = Date.now();
  try {
    const result = await dependencies.proxyMcpToolCall({
      args,
      cachedTool: resolved.cachedTool,
      organizationId: context.organizationId,
      row: resolved.connection,
      safeDb: context.safeDb,
      userId: context.userId,
    });
    await recordGatewayToolAudit({
      context,
      durationMs: Date.now() - startedAt,
      outcome: result.isError ? "error" : "success",
      resolved,
      toolKind: "external_mcp",
    });
    return result;
  } catch (error) {
    captureError(error, {
      source: "mcp-gateway-external-call",
      connectorSlug: resolved.connectorSlug,
      toolName: resolved.cachedTool.rawName,
    });
    await recordGatewayToolAudit({
      context,
      durationMs: Date.now() - startedAt,
      outcome: "error",
      resolved,
      toolKind: "external_mcp",
    });
    return mcpStructuredErrorResult({
      code: "internal_error",
      message: "External MCP tool execution failed",
      hint: MCP_INTERNAL_ERROR_HINT,
    });
  }
};

export const recordSkillGatewayToolAudit = async ({
  context,
  durationMs,
  outcome,
  skillId,
  toolName,
}: {
  context: McpRequestContext;
  durationMs: number;
  outcome: "error" | "success";
  skillId: string;
  toolName: string;
}) => {
  const recordAuditEvent = context.recordAuditEvent;

  const result = await context.safeDb(
    async (tx) =>
      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.EXECUTE,
        resourceType: AUDIT_RESOURCE_TYPE.MCP_GATEWAY_TOOL,
        resourceId: skillId,
        workspaceId: null,
        metadata: {
          durationMs,
          outcome,
          toolKind: "skill",
          toolName,
        },
      }),
  );
  if (Result.isError(result)) {
    captureError(result.error, { source: "mcp-gateway-skill-audit" });
  }
};

const recordGatewayToolAudit = async ({
  context,
  durationMs,
  outcome,
  resolved,
  toolKind,
}: {
  context: McpRequestContext;
  durationMs: number;
  outcome: "error" | "rate_limited" | "success";
  resolved: ResolvedExternalMcpTool;
  toolKind: "external_mcp";
}) => {
  const recordAuditEvent = context.recordAuditEvent;

  const result = await context.safeDb(
    async (tx) =>
      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.EXECUTE,
        resourceType: AUDIT_RESOURCE_TYPE.MCP_GATEWAY_TOOL,
        resourceId: resolved.connection.userConnectionId,
        workspaceId: null,
        metadata: {
          connectorSlug: resolved.connectorSlug,
          durationMs,
          exposedToolName: resolved.cachedTool.exposedName,
          outcome,
          toolKind,
          toolName: resolved.cachedTool.rawName,
        },
      }),
  );
  if (Result.isError(result)) {
    captureError(result.error, { source: "mcp-gateway-external-audit" });
  }
};

const refreshMissingCachedTools = async ({
  context,
  rows,
  dependencies,
}: {
  context: McpRequestContext;
  rows: readonly GatewayConnectionToolRow[];
  dependencies: ExternalGatewayDependencies;
}): Promise<boolean> => {
  const missingRows = rows.filter((row) => row.cachedTools === null);
  if (missingRows.length === 0) {
    return false;
  }

  await Promise.all(
    missingRows.map(
      async (row) =>
        // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- per-connector upstream discovery drives each refresh; no cross-connection batch exists
        await dependencies.refreshCachedMcpToolsForConnection({
          connectionId: row.userConnectionId,
          organizationId: context.organizationId,
          safeDb: context.safeDb,
          userId: context.userId,
        }),
    ),
  );

  return true;
};

const loadCachedGatewayToolRows = async ({
  context,
}: {
  context: McpRequestContext;
}): Promise<GatewayConnectionToolRow[]> => {
  const rows = await context.safeDb((tx) =>
    tx
      .select({
        userConnectionId: mcpUserConnections.id,
        connectorId: mcpConnectors.id,
        slug: mcpConnectors.slug,
        displayName: mcpConnectors.displayName,
        allowedTools: mcpConnectors.allowedTools,
        cachedTools: mcpUserConnections.cachedTools,
      })
      .from(mcpUserConnections)
      .innerJoin(
        mcpConnectors,
        eq(mcpConnectors.id, mcpUserConnections.connectorId),
      )
      .where(
        and(
          eq(mcpUserConnections.organizationId, context.organizationId),
          eq(mcpUserConnections.userId, context.userId),
          eq(mcpUserConnections.enabled, true),
          eq(mcpUserConnections.status, "connected"),
        ),
      )
      .orderBy(asc(mcpUserConnections.createdAt), asc(mcpUserConnections.id))
      .limit(LIMITS.mcpGatewayConnectorsMax),
  );

  if (Result.isError(rows)) {
    captureError(rows.error, { source: "mcp-gateway-external-list" });
    // Propagate the load fault as a distinct state: returning `[]` here would
    // make a transient DB outage indistinguishable from "no connectors", so a
    // `tools/call` would answer `unknown_tool` and `tools/list` would silently
    // shrink. Callers map this to a retryable error / a loud list failure.
    throw new McpGatewayLoadError({
      message: "Failed to load MCP gateway connectors",
      cause: rows.error,
    });
  }

  return rows.value;
};
