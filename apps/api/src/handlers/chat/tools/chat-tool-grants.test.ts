import { toolDefinition } from "@tanstack/ai";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  applyChatToolGrants,
  resolveChatToolGrantSubject,
  resolveExternalMcpGrantConnectorId,
  type StoredChatToolGrant,
} from "@/api/handlers/chat/tools/chat-tool-grants";
import type { LoadedExternalMcpConnector } from "@/api/handlers/chat/tools/external-mcp-tools";
import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import {
  applyChatToolPolicy,
  CHAT_TOOL_POLICY_KIND,
  type ChatToolPolicyKind,
  getChatToolPolicy,
} from "@/api/handlers/chat/tools/tool-policy";
import { toSafeId } from "@/api/lib/branded-types";
import type { ChatTool, ChatToolMap } from "@/api/lib/chat/chat-tool-types";

const inputSchema = toTanStackToolSchema(v.strictObject({}));

const policyTool = (name: string, kind: ChatToolPolicyKind): ChatTool =>
  applyChatToolPolicy(
    toolDefinition({ name, description: name, inputSchema }).server(
      async () => ({}),
    ),
    kind,
  );

const connectorId = toSafeId<"mcpConnector">(
  "00000000-0000-4000-8000-000000000001",
);
const otherConnectorId = toSafeId<"mcpConnector">(
  "00000000-0000-4000-8000-000000000002",
);
const threadId = toSafeId<"chatThread">("00000000-0000-4000-8000-000000000010");

const connector = (
  id: typeof connectorId,
  exposedToolNames: string[],
  upstreamToolNames: string[] = [],
): LoadedExternalMcpConnector => ({
  connectorId: id,
  description: "",
  displayName: "Connector",
  slug: "connector",
  toolNames: upstreamToolNames,
  exposedToolNames,
});

let grantSequence = 0;
const grant = (
  subject: Pick<StoredChatToolGrant, "toolName" | "mcpConnectorId">,
): StoredChatToolGrant => {
  grantSequence += 1;
  return {
    id: toSafeId<"chatToolGrant">(
      `00000000-0000-4000-8000-${String(grantSequence).padStart(12, "0")}`,
    ),
    scope: "conversation",
    chatThreadId: threadId,
    mcpConnectorToolNamespace: null,
    ...subject,
  };
};

describe("applyChatToolGrants", () => {
  test("a granted built-in tool runs without a prompt, through a clone that keeps its policy", () => {
    const original = policyTool("web_search", CHAT_TOOL_POLICY_KIND.external);
    const tools: ChatToolMap = { web_search: original };

    const granted = applyChatToolGrants({
      answeredApprovalToolNames: new Set(),
      externalConnectors: [],
      grants: [grant({ toolName: "web_search", mcpConnectorId: null })],
      tools,
    });

    const result = granted["web_search"];
    expect(result).toBeDefined();
    expect(result).not.toBe(original);
    expect(result?.needsApproval).toBeUndefined();
    expect(original.needsApproval).toBe(true);
    if (result) {
      expect(getChatToolPolicy(result).kind).toBe(
        CHAT_TOOL_POLICY_KIND.external,
      );
    }
  });

  test("ungranted approval-gated tools keep their gate", () => {
    const tools: ChatToolMap = {
      fetch_url: policyTool("fetch_url", CHAT_TOOL_POLICY_KIND.external),
    };

    const granted = applyChatToolGrants({
      answeredApprovalToolNames: new Set(),
      externalConnectors: [],
      grants: [grant({ toolName: "web_search", mcpConnectorId: null })],
      tools,
    });

    expect(granted["fetch_url"]?.needsApproval).toBe(true);
  });

  test("a granted tool keeps its gate on the request that answers its approval", () => {
    const tools: ChatToolMap = {
      web_search: policyTool("web_search", CHAT_TOOL_POLICY_KIND.external),
      fetch_url: policyTool("fetch_url", CHAT_TOOL_POLICY_KIND.external),
    };
    const grants = [
      grant({ toolName: "web_search", mcpConnectorId: null }),
      grant({ toolName: "fetch_url", mcpConnectorId: null }),
    ];

    const answering = applyChatToolGrants({
      answeredApprovalToolNames: new Set(["web_search"]),
      externalConnectors: [],
      grants,
      tools,
    });
    const next = applyChatToolGrants({
      answeredApprovalToolNames: new Set(),
      externalConnectors: [],
      grants,
      tools,
    });

    expect({
      answering: {
        fetch_url: answering["fetch_url"]?.needsApproval,
        web_search: answering["web_search"]?.needsApproval,
      },
      next: { web_search: next["web_search"]?.needsApproval },
    }).toEqual({
      answering: { fetch_url: undefined, web_search: true },
      next: { web_search: undefined },
    });
  });

  test("a stored grant never covers a tool that asks on every call", () => {
    const tools: ChatToolMap = {
      use_connector_secret: policyTool(
        "use_connector_secret",
        CHAT_TOOL_POLICY_KIND.external,
      ),
      suggest_changes: policyTool(
        "suggest_changes",
        CHAT_TOOL_POLICY_KIND.mutation,
      ),
      "use-browser": policyTool("use-browser", CHAT_TOOL_POLICY_KIND.external),
    };

    const granted = applyChatToolGrants({
      answeredApprovalToolNames: new Set(),
      externalConnectors: [],
      grants: Object.keys(tools).map((toolName) =>
        grant({ toolName, mcpConnectorId: null }),
      ),
      tools,
    });

    for (const name of Object.keys(tools)) {
      expect(granted[name]?.needsApproval).toBe(true);
    }
  });

  test("a connector grant ungates that connector's tools in place and no others", () => {
    const covered = policyTool(
      "mcp__connector__search",
      CHAT_TOOL_POLICY_KIND.external,
    );
    const otherConnectorTool = policyTool(
      "mcp__other__search",
      CHAT_TOOL_POLICY_KIND.external,
    );
    const tools: ChatToolMap = {
      mcp__connector__search: covered,
      mcp__other__search: otherConnectorTool,
    };

    const granted = applyChatToolGrants({
      answeredApprovalToolNames: new Set(),
      externalConnectors: [
        connector(connectorId, ["mcp__connector__search"]),
        connector(otherConnectorId, ["mcp__other__search"]),
      ],
      grants: [grant({ toolName: null, mcpConnectorId: connectorId })],
      tools,
    });

    // The connector source executes these exact objects.
    expect(granted["mcp__connector__search"]).toBe(covered);
    expect(covered.needsApproval).toBeUndefined();
    expect(granted["mcp__other__search"]?.needsApproval).toBe(true);
  });

  test("a connector grant never covers a built-in tool, whatever the connector advertises", () => {
    const builtIn = policyTool("web_search", CHAT_TOOL_POLICY_KIND.external);

    const granted = applyChatToolGrants({
      answeredApprovalToolNames: new Set(),
      externalConnectors: [
        connector(connectorId, ["mcp__connector__web_search"], ["web_search"]),
      ],
      grants: [grant({ toolName: null, mcpConnectorId: connectorId })],
      tools: { web_search: builtIn },
    });

    expect(granted["web_search"]?.needsApproval).toBe(true);
  });

  test("tools without an approval gate pass through unchanged", () => {
    const internal = policyTool(
      "read_document",
      CHAT_TOOL_POLICY_KIND.internal,
    );

    const granted = applyChatToolGrants({
      answeredApprovalToolNames: new Set(),
      externalConnectors: [],
      grants: [grant({ toolName: "read_document", mcpConnectorId: null })],
      tools: { read_document: internal },
    });

    expect(granted["read_document"]).toBe(internal);
  });
});

describe("resolveChatToolGrantSubject", () => {
  test("resolves external tools to their connector and refuses per-call tools", () => {
    const externalConnectors = [
      connector(connectorId, ["mcp__connector__search"]),
    ];
    expect(
      resolveChatToolGrantSubject({
        externalConnectors,
        toolName: "mcp__connector__search",
      }),
    ).toEqual({ type: "mcp-connector", connectorId });
    expect(
      resolveChatToolGrantSubject({
        externalConnectors,
        toolName: "web_search",
      }),
    ).toEqual({ type: "tool", toolName: "web_search" });
    expect(
      resolveChatToolGrantSubject({
        externalConnectors,
        toolName: "use_connector_secret",
      }),
    ).toEqual({ type: "not-grantable" });
  });
});

describe("resolveExternalMcpGrantConnectorId", () => {
  test("matches the one connector whose sanitized slug prefixes the tool name", () => {
    expect(
      resolveExternalMcpGrantConnectorId({
        connectors: [
          { id: connectorId, slug: "Acme-Docs" },
          { id: otherConnectorId, slug: "acme" },
        ],
        toolName: "mcp__acme_docs__search",
      }),
    ).toBe(connectorId);
  });

  test("an ambiguous or unknown prefix stays per-call", () => {
    expect(
      resolveExternalMcpGrantConnectorId({
        connectors: [
          { id: connectorId, slug: "acme-docs" },
          { id: otherConnectorId, slug: "acme_docs" },
        ],
        toolName: "mcp__acme_docs__search",
      }),
    ).toBeNull();
    expect(
      resolveExternalMcpGrantConnectorId({
        connectors: [{ id: connectorId, slug: "acme" }],
        toolName: "mcp__other__search",
      }),
    ).toBeNull();
  });
});
