import { Result } from "better-result";
import { and, asc, eq } from "drizzle-orm";

import { mcpConnectors, mcpUserConnections } from "@/api/db/schema";
import type { CachedMcpToolDefinition } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics";
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
import { consumeMcpGatewayRateLimit } from "@/api/mcp/gateway/rate-limit";
import { errorResult } from "@/api/mcp/tool-utils";

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

export const listGatewayExternalMcpTools = async ({
  context,
}: {
  context: McpRequestContext;
}): Promise<ResolvedExternalMcpTool[]> => {
  let cachedRows = await loadCachedGatewayToolRows({ context });
  if (cachedRows.length === 0) {
    return [];
  }

  if (await refreshMissingCachedTools({ context, rows: cachedRows })) {
    cachedRows = await loadCachedGatewayToolRows({ context });
  }

  const connections = await loadActiveMcpConnectionsForUser({
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
}: {
  context: McpRequestContext;
  toolName: string;
}): Promise<ResolvedExternalMcpTool | null> =>
  (await listGatewayExternalMcpTools({ context })).find(
    ({ cachedTool }) => cachedTool.exposedName === toolName,
  ) ?? null;

export const callGatewayExternalMcpTool = async ({
  args,
  context,
  toolName,
}: {
  args: Record<string, unknown>;
  context: McpRequestContext;
  toolName: string;
}) => {
  const resolved = await resolveGatewayExternalMcpTool({ context, toolName });
  if (!resolved) {
    return errorResult(`Unknown tool: ${toolName}`);
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
    return errorResult("External MCP tool rate limit exceeded");
  }

  const startedAt = Date.now();
  try {
    const result = await proxyMcpToolCall({
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
    return errorResult("External MCP tool execution failed");
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
}: {
  context: McpRequestContext;
  rows: readonly GatewayConnectionToolRow[];
}): Promise<boolean> => {
  const missingRows = rows.filter((row) => row.cachedTools === null);
  if (missingRows.length === 0) {
    return false;
  }

  await Promise.all(
    missingRows.map(
      async (row) =>
        await refreshCachedMcpToolsForConnection({
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
    return [];
  }

  return rows.value;
};
