import { panic } from "better-result";
import { and, eq, or } from "drizzle-orm";

import {
  type ChatToolGrantScope,
  isGrantableChatTool,
} from "@stll/api-contract/chat-tool-grants";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import {
  chatToolGrants,
  mcpConnectors,
  mcpUserConnections,
} from "@/api/db/schema";
import { markChatToolExecutionGranted } from "@/api/handlers/chat/tools/chat-tool-execution-audit";
import type { LoadedExternalMcpConnector } from "@/api/handlers/chat/tools/external-mcp-tools";
import {
  copyChatToolPolicy,
  getChatToolPolicy,
} from "@/api/handlers/chat/tools/tool-policy";
import type { SafeId } from "@/api/lib/branded-types";
import type { ChatTool, ChatToolMap } from "@/api/lib/chat/chat-tool-types";
import { readBounded } from "@/api/lib/db/read-bounded";
import { LIMITS } from "@/api/lib/limits";
import {
  dynamicToolNamespacePrefix,
  isExternalMcpToolName,
  sanitizeToolNamePart,
} from "@/api/lib/mcp-upstream/namespace";

/**
 * Bound on the grants that apply in one conversation. Grants exist only for
 * approval-gated built-in tools and installed connectors, once per scope, so
 * the `always` grants plus one conversation's grants stay far below it.
 */
const CHAT_TOOL_GRANTS_MAX = 500;

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
    const read = await readBounded(
      tx
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
        ),
      CHAT_TOOL_GRANTS_MAX,
    );
    if (read.type === "overflow") {
      return panic(
        "Stored chat tool grants exceed their per-conversation bound",
      );
    }
    return read.rows.map(({ mcpConnectorSlug, ...grant }) => ({
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
 * The connector each exposed external tool name belongs to. A name two
 * connectors expose maps to null: it belongs to neither for a grant.
 */
const exposedToolConnectors = (
  externalConnectors: readonly LoadedExternalMcpConnector[],
): Map<string, SafeId<"mcpConnector"> | null> => {
  const owners = new Map<string, SafeId<"mcpConnector"> | null>();
  for (const connector of externalConnectors) {
    for (const exposedToolName of connector.exposedToolNames) {
      const owner = owners.get(exposedToolName);
      owners.set(
        exposedToolName,
        owner === undefined || owner === connector.connectorId
          ? connector.connectorId
          : null,
      );
    }
  }
  return owners;
};

/**
 * What a grant for `toolName` covers. Only a name in the external connector
 * namespace that exactly one loaded connector exposes is covered through that
 * connector; such a name is never covered by name. Any other tool is covered
 * by its name, and what a connector advertises upstream never matters. Tools
 * whose grant policy is not grantable resolve to `not-grantable`.
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
  if (!isExternalMcpToolName(toolName)) {
    return { type: "tool", toolName };
  }
  const connectorId = exposedToolConnectors(externalConnectors).get(toolName);
  return connectorId === undefined || connectorId === null
    ? { type: "not-grantable" }
    : { type: "mcp-connector", connectorId };
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

/** The stored grant that covers `subject`, if any. */
const coveringGrant = ({
  grants,
  subject,
}: {
  grants: readonly StoredChatToolGrant[];
  subject: ChatToolGrantSubjectResolution;
}): StoredChatToolGrant | undefined => {
  switch (subject.type) {
    case "not-grantable":
      return undefined;
    case "tool":
      return grants.find((grant) => grant.toolName === subject.toolName);
    case "mcp-connector":
      return grants.find(
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
 * The approval decision for this request: an approval-gated tool runs without
 * a prompt only when a stored grant covers it and its grant policy allows a
 * grant. Everything else keeps the gate it was registered with, and so does a
 * tool named in `answeredApprovalToolNames`: the engine resumes an answered
 * approval only for a tool that still asks, so a grant stored while its card
 * waited covers that tool's calls from the next request on.
 *
 * Built-in tools are replaced by ungated clones so a shared definition is
 * never changed. External connector tools are created for this request and
 * are the same objects the connector source executes, so their gate is
 * removed in place; a clone would leave the executing object gated.
 */
export const applyChatToolGrants = ({
  answeredApprovalToolNames,
  externalConnectors,
  grants,
  tools,
}: {
  /** Tools whose awaited approvals this request answers. */
  answeredApprovalToolNames: ReadonlySet<string>;
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
      toolDefinition === undefined || answeredApprovalToolNames.has(name)
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
  const grant = getChatToolPolicy(toolDefinition).needsApproval
    ? coveringGrant({ grants, subject })
    : undefined;
  if (grant === undefined) {
    return toolDefinition;
  }
  // The execution audit reads this to record the call as granted.
  markChatToolExecutionGranted(toolDefinition, grant.id);
  if (subject.type === "mcp-connector") {
    delete toolDefinition.needsApproval;
    return toolDefinition;
  }
  return withoutApprovalGate(toolDefinition);
};

/**
 * What a grant for `toolName` covers outside a turn, where no connector tools
 * are loaded: the tool itself, or the one enabled connector of this user whose
 * namespace the name carries. Null when the name cannot hold a grant.
 */
export const resolveStoredGrantSubject = async ({
  organizationId,
  toolName,
  tx,
  userId,
}: {
  organizationId: SafeId<"organization">;
  toolName: string;
  tx: Transaction;
  userId: SafeId<"user">;
}): Promise<
  | { type: "tool"; toolName: string }
  | { type: "mcp-connector"; connectorId: SafeId<"mcpConnector"> }
  | null
> => {
  if (!isGrantableChatTool(toolName)) {
    return null;
  }
  if (!isExternalMcpToolName(toolName)) {
    return { type: "tool", toolName };
  }
  const connectors = await readBounded(
    tx
      .select({ id: mcpConnectors.id, slug: mcpConnectors.slug })
      .from(mcpUserConnections)
      .innerJoin(
        mcpConnectors,
        eq(mcpConnectors.id, mcpUserConnections.connectorId),
      )
      .where(
        and(
          eq(mcpUserConnections.organizationId, organizationId),
          eq(mcpUserConnections.userId, userId),
          eq(mcpUserConnections.enabled, true),
        ),
      ),
    LIMITS.mcpGatewayConnectorsMax,
  );
  // A truncated list could name the wrong owner, so no grant is resolved.
  if (connectors.type === "overflow") {
    return null;
  }
  const connectorId = resolveExternalMcpGrantConnectorId({
    connectors: connectors.rows,
    toolName,
  });
  return connectorId === null ? null : { type: "mcp-connector", connectorId };
};
