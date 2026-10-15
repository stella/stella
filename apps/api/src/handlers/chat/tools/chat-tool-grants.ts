import { panic } from "better-result";
import { and, eq, or } from "drizzle-orm";

import {
  isGrantableChatTool,
  type ChatToolGrantScope,
} from "@stll/api-contract/chat-tool-grants";

import type { SafeDb } from "@/api/db/safe-db";
import { chatToolGrants, mcpConnectors } from "@/api/db/schema";
import type { LoadedExternalMcpConnector } from "@/api/handlers/chat/tools/external-mcp-tools";
import {
  copyChatToolPolicy,
  getChatToolPolicy,
} from "@/api/handlers/chat/tools/tool-policy";
import type { SafeId } from "@/api/lib/branded-types";
import type { ChatTool, ChatToolMap } from "@/api/lib/chat/chat-tool-types";
import {
  dynamicToolNamespacePrefix,
  sanitizeToolNamePart,
} from "@/api/lib/mcp-upstream/namespace";

/** Upper bound on grants one user can hold in one organization. */
export const CHAT_TOOL_GRANTS_MAX = 500;

export type StoredChatToolGrant = {
  id: SafeId<"chatToolGrant">;
  scope: ChatToolGrantScope;
  chatThreadId: SafeId<"chatThread"> | null;
  toolName: string | null;
  mcpConnectorId: SafeId<"mcpConnector"> | null;
  /** Sanitized connector slug its tool names carry; null for a tool grant. */
  mcpConnectorToolNamespace: string | null;
};

/** The user's `always` grants plus the grants given in this conversation. */
export const loadChatToolGrants = async ({
  chatThreadId,
  organizationId,
  safeDb,
  userId,
}: {
  chatThreadId: SafeId<"chatThread">;
  organizationId: SafeId<"organization">;
  safeDb: SafeDb;
  userId: SafeId<"user">;
}) =>
  await safeDb(async (tx): Promise<StoredChatToolGrant[]> => {
    const rows = await tx
      .select({
        id: chatToolGrants.id,
        scope: chatToolGrants.scope,
        chatThreadId: chatToolGrants.chatThreadId,
        toolName: chatToolGrants.toolName,
        mcpConnectorId: chatToolGrants.mcpConnectorId,
        mcpConnectorSlug: mcpConnectors.slug,
      })
      .from(chatToolGrants)
      .leftJoin(
        mcpConnectors,
        eq(mcpConnectors.id, chatToolGrants.mcpConnectorId),
      )
      .where(
        and(
          eq(chatToolGrants.organizationId, organizationId),
          eq(chatToolGrants.userId, userId),
          or(
            eq(chatToolGrants.scope, "always"),
            eq(chatToolGrants.chatThreadId, chatThreadId),
          ),
        ),
      )
      .limit(CHAT_TOOL_GRANTS_MAX);
    return rows.map(({ mcpConnectorSlug, ...grant }) => ({
      ...grant,
      mcpConnectorToolNamespace:
        mcpConnectorSlug === null
          ? null
          : sanitizeToolNamePart(mcpConnectorSlug),
    }));
  });

export type ChatToolGrantSubjectResolution =
  | { type: "tool"; toolName: string }
  | { type: "mcp-connector"; connectorId: SafeId<"mcpConnector"> }
  | { type: "not-grantable" };

/**
 * What a grant for `toolName` covers. A tool of a loaded external connector
 * is covered through its connector, never by name; any other tool by name.
 * Tools whose grant policy is not grantable resolve to `not-grantable`.
 */
export const resolveChatToolGrantSubject = ({
  externalConnectors,
  toolName,
}: {
  externalConnectors: readonly LoadedExternalMcpConnector[];
  toolName: string;
}): ChatToolGrantSubjectResolution => {
  if (!isGrantableChatTool(toolName)) {
    return { type: "not-grantable" };
  }
  const connector = externalConnectors.find((candidate) =>
    candidate.toolNames.includes(toolName),
  );
  return connector === undefined
    ? { type: "tool", toolName }
    : { type: "mcp-connector", connectorId: connector.connectorId };
};

/**
 * The installed connector an external tool name belongs to, for storing a
 * grant outside a turn (where no connector tools are loaded). Names carry the
 * sanitized connector slug as their second segment; a name that matches no
 * connector, or more than one, resolves to null and stays per-call.
 */
export const resolveExternalMcpGrantConnectorId = ({
  connectors,
  toolName,
}: {
  connectors: readonly { id: SafeId<"mcpConnector">; slug: string }[];
  toolName: string;
}): SafeId<"mcpConnector"> | null => {
  const matches = connectors.filter((connector) =>
    toolName.startsWith(
      `${dynamicToolNamespacePrefix("external_mcp")}${sanitizeToolNamePart(connector.slug)}__`,
    ),
  );
  return matches.length === 1 ? (matches[0]?.id ?? null) : null;
};

const isCoveredByGrant = ({
  grants,
  subject,
}: {
  grants: readonly StoredChatToolGrant[];
  subject: ChatToolGrantSubjectResolution;
}): boolean => {
  switch (subject.type) {
    case "not-grantable":
      return false;
    case "tool":
      return grants.some((grant) => grant.toolName === subject.toolName);
    case "mcp-connector":
      return grants.some(
        (grant) => grant.mcpConnectorId === subject.connectorId,
      );
    default:
      subject satisfies never;
      return panic("Unhandled chat tool grant subject");
  }
};

const withoutApprovalGate = (toolDefinition: ChatTool): ChatTool => {
  const clone = { ...toolDefinition };
  delete clone.needsApproval;
  // The clone keeps the registered policy, so anonymization and subagent
  // projection still treat it as the approval-gated kind it is.
  copyChatToolPolicy(toolDefinition, clone);
  return clone;
};

/**
 * The approval decision for this turn: an approval-gated tool runs without a
 * prompt only when a stored grant covers it and its grant policy allows a
 * grant. Everything else keeps the gate it was registered with.
 *
 * Built-in tools are replaced by ungated clones so a shared definition is
 * never changed. External connector tools are created for this request and
 * are the same objects the connector source executes, so their gate is
 * removed in place; a clone would leave the executing object gated.
 */
export const applyChatToolGrants = ({
  externalConnectors,
  grants,
  tools,
}: {
  externalConnectors: readonly LoadedExternalMcpConnector[];
  grants: readonly StoredChatToolGrant[];
  tools: ChatToolMap;
}): ChatToolMap => {
  if (grants.length === 0) {
    return tools;
  }
  return Object.fromEntries(
    Object.entries(tools).map(([name, toolDefinition]) => [
      name,
      toolDefinition === undefined
        ? toolDefinition
        : withGrantDecision({
            externalConnectors,
            grants,
            name,
            toolDefinition,
          }),
    ]),
  );
};

const withGrantDecision = ({
  externalConnectors,
  grants,
  name,
  toolDefinition,
}: {
  externalConnectors: readonly LoadedExternalMcpConnector[];
  grants: readonly StoredChatToolGrant[];
  name: string;
  toolDefinition: ChatTool;
}): ChatTool => {
  const subject = resolveChatToolGrantSubject({
    externalConnectors,
    toolName: name,
  });
  if (
    !getChatToolPolicy(toolDefinition).needsApproval ||
    !isCoveredByGrant({ grants, subject })
  ) {
    return toolDefinition;
  }
  if (subject.type === "mcp-connector") {
    delete toolDefinition.needsApproval;
    return toolDefinition;
  }
  return withoutApprovalGate(toolDefinition);
};
