import type { MCPToolSource, ServerTool } from "@tanstack/ai";
import type { MCPClient } from "@tanstack/ai-mcp";

import type { SafeDb } from "@/api/db/safe-db";
import type {
  ChatTool,
  ChatToolMap,
} from "@/api/handlers/chat/tools/chat-tool-types";
import {
  getExternalMcpToolDefinitionsForConnector,
  selectAllowedExternalMcpToolDefinitions,
} from "@/api/handlers/chat/tools/external-mcp-tool-definitions";
import { normalizeExternalMcpToolsForChat } from "@/api/handlers/chat/tools/external-mcp-tools-normalization";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import {
  createMcpClientForConnection,
  loadActiveMcpConnectionsForUser,
} from "@/api/lib/mcp-upstream/connections";
import type { LoadedMcpConnection } from "@/api/lib/mcp-upstream/connections";
import type { NullUnionStrategy } from "@/api/lib/provider-safe-json-schema";
import { withTimeout } from "@/api/lib/with-timeout";

// A single connector call can legitimately chain several sequential
// upstream HTTP round trips (OAuth authorization-server discovery, token
// refresh, then the MCP `tools()` call itself), each already bounded by
// its own ~10s per-call timeout inside `mcp-upstream/connections.ts`. This
// is the aggregate ceiling for one connector's whole discovery — client
// creation through tool listing — so a connector stuck in an unbounded
// step (e.g. a hung DB/KMS call with no timeout of its own) cannot stall
// discovery past a bounded budget, regardless of how many connectors the
// user has configured.
const EXTERNAL_MCP_DISCOVERY_TIMEOUT_MS = 20_000;

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
  const rows = await loadActiveMcpConnectionsForUser({
    organizationId,
    safeDb,
    userId,
  });

  // Connectors are independent per-user integrations — separate client,
  // separate auth, separate tool set — so loading them concurrently is
  // safe; there is no ordering dependency between them (each row carries
  // its own resolved credentials). Each call is individually bounded by
  // `EXTERNAL_MCP_DISCOVERY_TIMEOUT_MS`, so one slow or unresponsive
  // upstream server no longer multiplies latency by connector count the
  // way a sequential loop would. A per-connector failure — including a
  // timeout — degrades to "no tools from that connector" rather than
  // failing the whole load; see `loadConnectorTools`.
  const results = await Promise.all(
    rows.map((row) =>
      loadConnectorTools({
        nullUnionStrategy,
        organizationId,
        row,
        safeDb,
        userId,
      }),
    ),
  );

  const clients: MCPClient[] = [];
  const connectors: LoadedExternalMcpConnector[] = [];
  const sourceTools: Record<string, ServerTool | undefined> = {};
  const loadedTools: ChatToolMap = {};

  // Merge sequentially, after every connector has settled, instead of
  // mutating these shared collections from inside the concurrent loop
  // above — keeps connector order and any tool-name collision resolution
  // deterministic (row order) regardless of which connector's promise
  // resolves first.
  for (const result of results) {
    if (result === null) {
      continue;
    }
    clients.push(result.client);
    connectors.push(result.connector);
    Object.assign(loadedTools, result.tools);
    copyServerTools({ sourceTools, tools: result.tools });
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

type LoadedExternalMcpConnectorResult = {
  client: MCPClient;
  connector: LoadedExternalMcpConnector;
  tools: ChatToolMap;
};

const loadConnectorTools = async ({
  nullUnionStrategy,
  organizationId,
  row,
  safeDb,
  userId,
}: {
  nullUnionStrategy: NullUnionStrategy;
  organizationId: SafeId<"organization">;
  row: LoadedMcpConnection;
  safeDb: SafeDb;
  userId: SafeId<"user">;
}): Promise<LoadedExternalMcpConnectorResult | null> => {
  try {
    return await withTimeout(
      async () => {
        const client = await createMcpClientForConnection({
          organizationId,
          row,
          safeDb,
          userId,
        });
        if (!client) {
          return null;
        }

        const tools = await loadMcpConnectorTools({ client, row });
        const normalized = normalizeExternalMcpToolsForChat({
          allowedTools: row.allowedTools,
          connectorSlug: row.slug,
          nullUnionStrategy,
          tools,
        });

        return {
          client,
          connector: {
            description: row.description,
            displayName: row.displayName,
            slug: row.slug,
            toolNames: normalized.toolNames,
          },
          tools: normalized.tools,
        };
      },
      {
        label: `external-mcp-tools:${row.slug}`,
        timeoutMs: EXTERNAL_MCP_DISCOVERY_TIMEOUT_MS,
      },
    );
  } catch (error) {
    captureError(error, {
      source: "external-mcp-tools",
      connectorSlug: row.slug,
    });
    return null;
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
