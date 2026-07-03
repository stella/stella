import type { MCPToolSource, ServerTool } from "@tanstack/ai";
import type { MCPClient } from "@tanstack/ai-mcp";

import type { SafeDb } from "@/api/db";
import type {
  ChatTool,
  ChatToolMap,
} from "@/api/handlers/chat/tools/chat-tool-types";
import {
  getExternalMcpToolDefinitionsForConnector,
  selectAllowedExternalMcpToolDefinitions,
} from "@/api/handlers/chat/tools/external-mcp-tool-definitions";
import { normalizeExternalMcpToolsForChat } from "@/api/handlers/chat/tools/external-mcp-tools-normalization";
import { captureError } from "@/api/lib/analytics";
import type { SafeId } from "@/api/lib/branded-types";
import {
  createMcpClientForConnection,
  loadActiveMcpConnectionsForUser,
} from "@/api/lib/mcp-upstream/connections";
import type { LoadedMcpConnection } from "@/api/lib/mcp-upstream/connections";
import type { NullUnionStrategy } from "@/api/lib/provider-safe-json-schema";

export type LoadedExternalMcpTools = {
  close: () => Promise<void> | void;
  connectors: LoadedExternalMcpConnector[];
  source: StellaMcpToolSource;
  tools: ChatToolMap;
};

export type StellaMcpToolSource = MCPToolSource;

export type LoadedExternalMcpConnector = {
  description: string;
  displayName: string;
  slug: string;
  toolNames: string[];
};

export const loadExternalMcpToolsForUser = async ({
  nullUnionStrategy,
  organizationId,
  safeDb,
  userId,
}: {
  nullUnionStrategy: NullUnionStrategy;
  organizationId: SafeId<"organization">;
  safeDb: SafeDb;
  userId: SafeId<"user">;
}): Promise<LoadedExternalMcpTools> => {
  const clients: MCPClient[] = [];
  const connectors: LoadedExternalMcpConnector[] = [];
  const sourceTools: Record<string, ServerTool | undefined> = {};
  const loadedTools: ChatToolMap = {};

  const rows = await loadActiveMcpConnectionsForUser({
    organizationId,
    safeDb,
    userId,
  });

  for (const row of rows) {
    // oxlint-disable-next-line no-await-in-loop -- sequential per-connector load; mutates shared clients/connectors/loadedTools and avoids fanning out concurrent external MCP connections
    await loadConnectorTools({
      clients,
      connectors,
      loadedTools,
      nullUnionStrategy,
      organizationId,
      row,
      safeDb,
      sourceTools,
      userId,
    });
  }

  const closeClients = async (): Promise<void> => {
    const closeTasks: Promise<void>[] = [];
    for (const client of clients) {
      closeTasks.push(client.close());
    }
    await Promise.allSettled(closeTasks);
  };

  const source = createStellaMcpToolSource({ closeClients, sourceTools });

  return { close: closeClients, connectors, source, tools: loadedTools };
};

export const createStellaMcpToolSource = ({
  closeClients,
  sourceTools,
}: {
  closeClients: () => Promise<void>;
  sourceTools: Readonly<Record<string, ServerTool | undefined>>;
}): StellaMcpToolSource => ({
  close: closeClients,
  tools: async ({ lazy = true }: { lazy?: boolean } = {}) => {
    const discoveredTools = Object.values(sourceTools).filter(
      (tool): tool is ServerTool => tool !== undefined,
    );
    if (lazy) {
      return await Promise.resolve(discoveredTools);
    }

    return await Promise.resolve(discoveredTools.map(stripLazyToolFlag));
  },
});

const stripLazyToolFlag = (tool: ServerTool): ServerTool => {
  const eagerTool = { ...tool };
  delete eagerTool.lazy;
  return eagerTool;
};

const copyServerTools = ({
  sourceTools,
  tools,
}: {
  sourceTools: Record<string, ServerTool | undefined>;
  tools: ChatToolMap;
}): void => {
  for (const [name, tool] of Object.entries(tools)) {
    if (isServerTool(tool)) {
      sourceTools[name] = tool;
    }
  }
};

const isServerTool = (tool: ChatTool | undefined): tool is ServerTool =>
  tool !== undefined && "__toolSide" in tool && tool.__toolSide === "server";

const loadConnectorTools = async ({
  clients,
  connectors,
  loadedTools,
  nullUnionStrategy,
  organizationId,
  row,
  safeDb,
  sourceTools,
  userId,
}: {
  clients: MCPClient[];
  connectors: LoadedExternalMcpConnector[];
  loadedTools: ChatToolMap;
  nullUnionStrategy: NullUnionStrategy;
  organizationId: SafeId<"organization">;
  row: LoadedMcpConnection;
  safeDb: SafeDb;
  sourceTools: Record<string, ServerTool | undefined>;
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

    const tools = await loadMcpConnectorTools({ client, row });
    const normalized = normalizeExternalMcpToolsForChat({
      allowedTools: row.allowedTools,
      connectorSlug: row.slug,
      nullUnionStrategy,
      tools,
    });
    Object.assign(loadedTools, normalized.tools);
    copyServerTools({ sourceTools, tools: normalized.tools });

    connectors.push({
      description: row.description,
      displayName: row.displayName,
      slug: row.slug,
      toolNames: normalized.toolNames,
    });
  } catch (error) {
    captureError(error, {
      source: "external-mcp-tools",
      connectorSlug: row.slug,
    });
  }
};

export const loadMcpConnectorTools = async ({
  client,
  row,
}: {
  client: MCPClient;
  row: LoadedMcpConnection;
}): Promise<ServerTool[]> => {
  const definitions = getExternalMcpToolDefinitionsForConnector(row);
  if (definitions === null) {
    return await client.tools();
  }

  const allowedDefinitions = selectAllowedExternalMcpToolDefinitions({
    allowedTools: row.allowedTools,
    definitions,
  });
  if (allowedDefinitions.length === 0) {
    return [];
  }

  return await client.tools(allowedDefinitions);
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
