import type { MCPClient } from "@ai-sdk/mcp";
import type { ToolSet } from "ai";

import type { SafeDb } from "@/api/db";
import { captureError } from "@/api/lib/analytics";
import type { SafeId } from "@/api/lib/branded-types";
import {
  createMcpClientForConnection,
  loadActiveMcpConnectionsForUser,
} from "@/api/lib/mcp-upstream/connections";
import type { LoadedMcpConnection } from "@/api/lib/mcp-upstream/connections";
import { namespaceMcpToolName } from "@/api/lib/mcp-upstream/namespace";

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

  const rows = await loadActiveMcpConnectionsForUser({
    organizationId,
    safeDb,
    userId,
  });

  for (const row of rows) {
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
    const client = await createMcpClientForConnection({
      organizationId,
      row,
      safeDb,
      userId,
    });
    if (!client) {
      return;
    }
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
