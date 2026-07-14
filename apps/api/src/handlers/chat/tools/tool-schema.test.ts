import {
  convertSchemaToJsonSchema,
  parseWithStandardSchema,
  toolDefinition,
  type Tool,
} from "@tanstack/ai";
import {
  convertToolsToProviderFormat as convertAnthropicTools,
  createAnthropicChat,
} from "@tanstack/ai-anthropic";
import { webSearchTool as anthropicWebSearchTool } from "@tanstack/ai-anthropic/tools";
import { bedrockText } from "@tanstack/ai-bedrock";
import { createGeminiChat } from "@tanstack/ai-gemini";
import { createMistralText } from "@tanstack/ai-mistral";
import { createOpenaiChat } from "@tanstack/ai-openai";
import { convertFunctionToolToAdapterFormat } from "@tanstack/ai-openai/tools";
import { createOpenRouterResponsesText } from "@tanstack/ai-openrouter";
import { resolveDebugOption } from "@tanstack/ai/adapter-internals";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import {
  ACTIVE_SKILL_BODY_PROMPT_MAX_CHARS,
  type ActiveChatSkillContext,
} from "@/api/handlers/chat/skills";
import { APPLY_ACTIVE_DOCX_EDITS_TOOL_NAME } from "@/api/handlers/chat/tools/active-docx-edit-tool";
import { resolveToolWorkspaceIds } from "@/api/handlers/chat/tools/authorized-workspace-ids";
import {
  EXPAND_CHAT_HISTORY_TOOL_NAME,
  SEARCH_CHAT_HISTORY_TOOL_NAME,
} from "@/api/handlers/chat/tools/chat-history-tools";
import { getChatTools as getChatToolsWithPin } from "@/api/handlers/chat/tools/chat-tools";
import { createChatRefRegistry } from "@/api/handlers/chat/tools/execute/ref-registry";
import {
  ADD_COMMENT_TOOL_NAME,
  FIND_TEXT_TOOL_NAME,
  READ_CHANGES_TOOL_NAME,
  READ_COMMENTS_TOOL_NAME,
  READ_DOCUMENT_TOOL_NAME,
  REPLY_COMMENT_TOOL_NAME,
  RESOLVE_COMMENT_TOOL_NAME,
} from "@/api/handlers/chat/tools/folio-agent-tools";
import { WRITE_TOOL_REF_FIELD_MAP } from "@/api/handlers/chat/tools/registry-adapter/ref-field-map";
import { getChatToolPolicy } from "@/api/handlers/chat/tools/tool-policy";
import { COMPARE_VERSIONS_TOOL_NAME } from "@/api/handlers/chat/tools/version-compare-tools";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import { PROVIDER_SAFE_JSON_SCHEMA_KEYWORDS } from "@/api/lib/provider-safe-json-schema";
import type { UrlFetcher, WebSearchProvider } from "@/api/lib/web-search/types";
import { DEFAULT_MCP_TOOL_DEFINITIONS } from "@/api/mcp/static-tool-definitions";

import { createOrgTools } from "./org-tools";
import { createSkillTools } from "./skill-tools";
import { toTanStackToolSchema } from "./tanstack-tool-schema";
import {
  buildCreatedDocumentToolOutput,
  createWorkspaceTools,
} from "./workspace-tools";

const organizationId = toSafeId<"organization">(
  "11111111-1111-4111-8111-111111111111",
);
const userId = toSafeId<"user">("22222222-2222-4222-8222-222222222222");
const workspaceId = toSafeId<"workspace">(
  "33333333-3333-4333-8333-333333333333",
);
const entityId = toSafeId<"entity">("44444444-4444-4444-8444-444444444444");
const threadId = toSafeId<"chatThread">("55555555-5555-4555-8555-555555555555");
const skillId = toSafeId<"agentSkill">("66666666-6666-4666-8666-666666666666");

const unusedScopedDb: ScopedDb = async () => {
  throw new Error("This test only constructs tool schemas.");
};

const unusedSafeDb: SafeDb = async () => {
  throw new Error("This test only constructs tool schemas.");
};

const noopAuditRecorder: AuditRecorder = async () => undefined;

const getChatTools = (
  props: Omit<
    Parameters<typeof getChatToolsWithPin>[0],
    "pinServerValidatedWorkspaceId"
  >,
) =>
  getChatToolsWithPin({
    ...props,
    pinServerValidatedWorkspaceId: () => true,
  });

const editableActiveSkillContext: ActiveChatSkillContext = {
  body: "# Instructions\nUse the checklist.",
  description: "Review closing files.",
  displayName: "Closing Review",
  editable: true,
  id: skillId,
  origin: "authored",
  resources: [{ kind: "knowledge", path: "knowledge/checklist.md" }],
  source: "installed",
  toolName: "closing-review",
  version: null,
};

const isSchemaObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const emptyProviderStream = async function* () {
  // The contract probes only need the adapter to issue its SDK request.
};

const consumeProviderStream = async (
  stream: AsyncIterable<unknown>,
): Promise<void> => {
  for await (const _chunk of stream) {
    // Consume the fake provider stream so request mapping runs to completion.
  }
};

const requireRecord = (
  value: unknown,
  description: string,
): Record<string, unknown> => {
  if (!isSchemaObject(value)) {
    throw new TypeError(`Expected ${description} to be an object.`);
  }
  return value;
};

const requireArray = (value: unknown, description: string): unknown[] => {
  if (!Array.isArray(value)) {
    throw new TypeError(`Expected ${description} to be an array.`);
  }
  return value;
};

// Construct args so every conditional tool group registers: owner role
// (template use + create), active docx edit client, web search enabled with
// a resolved provider, and an editable active skill context. BOE, infosoud,
// and business-registry tools register by default (no disabled slugs).
const buildFullCoverageChatTools = () => {
  const webSearchProvider: WebSearchProvider = {
    name: "tavily",
    search: async () => ({ results: [] }),
  };
  const urlFetcher: UrlFetcher = {
    name: "jina",
    fetch: async () => ({
      url: "",
      content: "",
      truncated: false,
      provider: "jina",
    }),
  };

  return getChatTools({
    orgAIConfig: null,
    memberRole: "owner",
    organizationId,
    requestWorkspaceId: workspaceId,
    thirdPartyBoundary: { type: "raw" },
    refRegistry: createChatRefRegistry(),
    safeDb: unusedSafeDb,
    scopedDb: unusedScopedDb,
    threadId,
    userId,
    toolWorkspaceIds: resolveToolWorkspaceIds({
      pinnedIds: [],
      accessibleWorkspaceIds: [workspaceId],
    }),
    hasActiveDocxEditClient: true,
    hasActiveDocxFileClient: true,
    webSearchEnabled: true,
    webSearchProviders: { webSearchProvider, urlFetcher },
    activeSkillContext: editableActiveSkillContext,
    recordAuditEvent: noopAuditRecorder,
    skillMetadata: [
      {
        description: editableActiveSkillContext.description,
        name: editableActiveSkillContext.toolName,
        version: editableActiveSkillContext.version,
      },
    ],
  });
};

const serializeFullCoverageChatTools = (): Tool[] =>
  Object.entries(buildFullCoverageChatTools()).map(([name, tool]) => {
    if (!tool?.inputSchema) {
      throw new TypeError(`Registered tool "${name}" has no input schema.`);
    }
    const inputSchema = convertSchemaToJsonSchema(tool.inputSchema);
    if (!inputSchema) {
      throw new TypeError(`Registered tool "${name}" did not serialize.`);
    }
    return { name, description: tool.description, inputSchema };
  });

const commonProviderOptions = (tools: Tool[]) => ({
  logger: resolveDebugOption(false),
  messages: [{ role: "user" as const, content: "Contract probe." }],
  tools,
});

type ProviderRequestProbe = {
  provider:
    | "anthropic"
    | "bedrock"
    | "google"
    | "mistral"
    | "openai"
    | "openrouter";
  capture: (tools: Tool[]) => Promise<Record<string, unknown>>;
  toolsFromRequest: (request: Record<string, unknown>) => unknown[];
};

const providerRequestProbes: ProviderRequestProbe[] = [
  {
    provider: "openai",
    capture: async (tools) => {
      const adapter = createOpenaiChat("gpt-5.2", "test-key");
      let request: unknown;
      Reflect.set(adapter, "client", {
        responses: {
          create: (payload: unknown) => {
            request = payload;
            return emptyProviderStream();
          },
        },
      });
      await consumeProviderStream(
        adapter.chatStream({
          ...commonProviderOptions(tools),
          model: adapter.model,
        }),
      );
      return requireRecord(request, "OpenAI request");
    },
    toolsFromRequest: (request) =>
      requireArray(request["tools"], "OpenAI request tools"),
  },
  {
    provider: "google",
    capture: async (tools) => {
      const adapter = createGeminiChat("gemini-3.5-flash", "test-key");
      let request: unknown;
      Reflect.set(adapter, "client", {
        models: {
          generateContentStream: (payload: unknown) => {
            request = payload;
            return emptyProviderStream();
          },
        },
      });
      await consumeProviderStream(
        adapter.chatStream({
          ...commonProviderOptions(tools),
          model: adapter.model,
        }),
      );
      return requireRecord(request, "Gemini request");
    },
    toolsFromRequest: (request) => {
      const config = requireRecord(request["config"], "Gemini request config");
      const groups = requireArray(config["tools"], "Gemini request tools");
      return groups.flatMap((group) => {
        const record = requireRecord(group, "Gemini tool group");
        return Array.isArray(record["functionDeclarations"])
          ? record["functionDeclarations"]
          : [record];
      });
    },
  },
  {
    provider: "anthropic",
    capture: async (tools) => {
      const adapter = createAnthropicChat("claude-opus-4-6", "test-key");
      let request: unknown;
      Reflect.set(adapter, "client", {
        beta: {
          messages: {
            create: (payload: unknown) => {
              request = payload;
              return emptyProviderStream();
            },
          },
        },
      });
      await consumeProviderStream(
        adapter.chatStream({
          ...commonProviderOptions(tools),
          model: adapter.model,
        }),
      );
      if (request === undefined) {
        throw new TypeError("Anthropic adapter did not issue its SDK request.");
      }
      return requireRecord(request, "Anthropic request");
    },
    toolsFromRequest: (request) =>
      requireArray(request["tools"], "Anthropic request tools"),
  },
  {
    provider: "bedrock",
    capture: async (tools) => {
      const adapter = bedrockText("us.amazon.nova-micro-v1:0", {
        apiKey: "test-key",
      });
      let request: unknown;
      Reflect.set(adapter, "sendStream", async (payload: unknown) => {
        request = payload;
        return emptyProviderStream();
      });
      await consumeProviderStream(
        adapter.chatStream({
          ...commonProviderOptions(tools),
          model: adapter.model,
        }),
      );
      return requireRecord(request, "Bedrock Converse request");
    },
    toolsFromRequest: (request) => {
      const toolConfig = requireRecord(
        request["toolConfig"],
        "Bedrock tool config",
      );
      return requireArray(toolConfig["tools"], "Bedrock request tools");
    },
  },
  {
    provider: "openrouter",
    capture: async (tools) => {
      const adapter = createOpenRouterResponsesText(
        "openai/gpt-5.2",
        "test-key",
      );
      let request: unknown;
      Reflect.set(adapter, "orClient", {
        beta: {
          responses: {
            send: (payload: unknown) => {
              request = payload;
              return emptyProviderStream();
            },
          },
        },
      });
      await consumeProviderStream(
        adapter.chatStream({
          ...commonProviderOptions(tools),
          model: adapter.model,
        }),
      );
      return requireRecord(request, "OpenRouter SDK request");
    },
    toolsFromRequest: (request) => {
      const responsesRequest = requireRecord(
        request["responsesRequest"],
        "OpenRouter responses request",
      );
      return requireArray(
        responsesRequest["tools"],
        "OpenRouter request tools",
      );
    },
  },
  {
    provider: "mistral",
    capture: async (tools) => {
      const adapter = createMistralText("mistral-large-latest", "test-key");
      let request: unknown;
      Reflect.set(adapter, "fetchRawMistralStream", (payload: unknown) => {
        request = payload;
        return emptyProviderStream();
      });
      await consumeProviderStream(
        adapter.chatStream({
          ...commonProviderOptions(tools),
          model: adapter.model,
        }),
      );
      return requireRecord(request, "Mistral request");
    },
    toolsFromRequest: (request) =>
      requireArray(request["tools"], "Mistral request tools"),
  },
];

describe("chat tool schemas", () => {
  test("construct org-level tools as JSON-schema-compatible AI tools", () => {
    expect(() =>
      createOrgTools({
        accessibleWorkspaceIds: [workspaceId],
        organizationId,
        scopedDb: unusedScopedDb,
      }),
    ).not.toThrow();
  });

  test("wraps Valibot schemas as TanStack Standard JSON Schema", async () => {
    const tools = createOrgTools({
      accessibleWorkspaceIds: [workspaceId],
      organizationId,
      scopedDb: unusedScopedDb,
    });
    const askUser = tools["ask-user"];

    const jsonSchema = convertSchemaToJsonSchema(askUser.inputSchema);
    expect(jsonSchema?.type).toBe("object");
    expect(jsonSchema?.properties).toHaveProperty("questions");

    const value = parseWithStandardSchema(askUser.inputSchema, {
      analysis: "Need scope.",
      questions: [{ question: "Which law?", reason: "Jurisdiction matters." }],
    });
    expect(value).toEqual({
      analysis: "Need scope.",
      questions: [{ question: "Which law?", reason: "Jurisdiction matters." }],
    });
  });

  test("preserves TanStack custom tool events in tool context", async () => {
    const events: { name: string; value: Record<string, unknown> }[] = [];
    const tool = toolDefinition({
      name: "emit-progress",
      description: "Emit progress.",
      inputSchema: toTanStackToolSchema(v.strictObject({})),
    }).server((_input, context) => {
      if (!context) {
        throw new Error("Expected TanStack tool execution context");
      }
      context.emitCustomEvent("progress", { current: 1 });
      return { ok: true };
    });

    await tool.execute?.(
      {},
      {
        emitCustomEvent: (name, value) => {
          events.push({ name, value });
        },
      },
    );

    expect(events).toEqual([{ name: "progress", value: { current: 1 } }]);
  });

  test("construct workspace tools as JSON-schema-compatible AI tools", () => {
    expect(() =>
      createWorkspaceTools({
        allowedWorkspaceIds: [workspaceId],
        scopedDb: unusedScopedDb,
      }),
    ).not.toThrow();
  });

  test("construct skill tools as JSON-schema-compatible AI tools", () => {
    expect(() =>
      createSkillTools({
        organizationId,
        safeDb: unusedSafeDb,
        skills: [
          {
            description: "Run a custom legal workflow.",
            name: "custom-legal-workflow",
            version: "1.0",
          },
        ],
        userId,
      }),
    ).not.toThrow();
  });

  test("keeps installed skill names out of tool schema descriptions", () => {
    const tools = createSkillTools({
      organizationId,
      safeDb: unusedSafeDb,
      skills: [
        {
          description: "Private matter-specific workflow.",
          name: "acme-closing-strategy",
          version: "1.0",
        },
      ],
      userId,
    });

    expect(JSON.stringify(tools)).not.toContain("acme-closing-strategy");
  });

  test("chat tools expose readonly data through the stella API", () => {
    const tools = getChatTools({
      orgAIConfig: null,
      memberRole: "owner",
      organizationId,
      requestWorkspaceId: workspaceId,
      thirdPartyBoundary: { type: "raw" },
      refRegistry: createChatRefRegistry(),
      safeDb: unusedSafeDb,
      scopedDb: unusedScopedDb,
      threadId,
      userId,
      toolWorkspaceIds: resolveToolWorkspaceIds({
        pinnedIds: [],
        accessibleWorkspaceIds: [workspaceId],
      }),
      hasActiveDocxEditClient: false,
      hasActiveDocxFileClient: false,
      webSearchEnabled: false,
      webSearchProviders: { webSearchProvider: null, urlFetcher: null },
    });

    expect(tools).toHaveProperty("ask-user");
    expect(tools).not.toHaveProperty("create-current-skill-resource");
    expect(tools).not.toHaveProperty("update-current-skill-body");
    expect(tools).not.toHaveProperty("update-current-skill-resource");
    expect(tools).toHaveProperty(SEARCH_CHAT_HISTORY_TOOL_NAME);
    expect(tools).toHaveProperty(EXPAND_CHAT_HISTORY_TOOL_NAME);
    expect(tools).toHaveProperty("execute_typescript");
    expect(tools).toHaveProperty("discover_tools");
    expect(tools).toHaveProperty("create-document");
    expect(tools).toHaveProperty("update-entity-fields");
    expect(tools).not.toHaveProperty("search-across-matters");
    expect(tools).not.toHaveProperty("read-content-across-matters");
    expect(tools).not.toHaveProperty("read-contact");
    // No live editor surface on this turn (`hasActiveDocxEditClient: false`):
    // the folio-agents doc tools must stay unregistered, same precondition
    // as `apply-active-docx-edits`.
    expect(tools).not.toHaveProperty(READ_DOCUMENT_TOOL_NAME);
    expect(tools).not.toHaveProperty(FIND_TEXT_TOOL_NAME);
  });

  test("registers the folio-agents read_document/find_text tools only when the file-overlay docx client is active", () => {
    const baseArgs = {
      orgAIConfig: null,
      memberRole: "owner",
      organizationId,
      requestWorkspaceId: workspaceId,
      thirdPartyBoundary: { type: "raw" },
      refRegistry: createChatRefRegistry(),
      safeDb: unusedSafeDb,
      scopedDb: unusedScopedDb,
      threadId,
      userId,
      toolWorkspaceIds: resolveToolWorkspaceIds({
        pinnedIds: [],
        accessibleWorkspaceIds: [workspaceId],
      }),
      webSearchEnabled: false,
      webSearchProviders: { webSearchProvider: null, urlFetcher: null },
    } as const;

    const withoutClient = getChatTools({
      ...baseArgs,
      hasActiveDocxEditClient: false,
      hasActiveDocxFileClient: false,
    });
    expect(withoutClient).not.toHaveProperty(READ_DOCUMENT_TOOL_NAME);
    expect(withoutClient).not.toHaveProperty(FIND_TEXT_TOOL_NAME);

    // Template Studio: `apply-active-docx-edits` is on (the combined
    // flag), but there is no client watcher that resolves
    // read_document/find_text there, so the narrower
    // `hasActiveDocxFileClient` flag must stay false and these tools
    // must NOT be registered — registering them would hang the turn
    // waiting for a client result that never arrives (regression guard
    // for the Template Studio hang).
    const templateOnly = getChatTools({
      ...baseArgs,
      hasActiveDocxEditClient: true,
      hasActiveDocxFileClient: false,
    });
    expect(templateOnly).toHaveProperty(APPLY_ACTIVE_DOCX_EDITS_TOOL_NAME);
    expect(templateOnly).not.toHaveProperty(READ_DOCUMENT_TOOL_NAME);
    expect(templateOnly).not.toHaveProperty(FIND_TEXT_TOOL_NAME);

    expect(templateOnly).not.toHaveProperty(READ_CHANGES_TOOL_NAME);
    expect(templateOnly).not.toHaveProperty(READ_COMMENTS_TOOL_NAME);
    expect(templateOnly).not.toHaveProperty(ADD_COMMENT_TOOL_NAME);
    expect(templateOnly).not.toHaveProperty(REPLY_COMMENT_TOOL_NAME);
    expect(templateOnly).not.toHaveProperty(RESOLVE_COMMENT_TOOL_NAME);

    const withClient = getChatTools({
      ...baseArgs,
      hasActiveDocxEditClient: true,
      hasActiveDocxFileClient: true,
    });
    const readDocument = withClient[READ_DOCUMENT_TOOL_NAME];
    const findText = withClient[FIND_TEXT_TOOL_NAME];
    expect(readDocument).toBeDefined();
    expect(findText).toBeDefined();
    if (!readDocument || !findText) {
      throw new Error("Expected folio-agents doc tools to be registered");
    }

    // Client-executed, read-only: no approval gate.
    expect(readDocument.needsApproval).toBeUndefined();
    expect(findText.needsApproval).toBeUndefined();
    expect(getChatToolPolicy(readDocument)).toEqual({
      kind: "internal",
      needsApproval: false,
      requiresAnonymization: false,
    });

    // The live-editor comment/changes tools share the same file-client gate.
    for (const name of [READ_CHANGES_TOOL_NAME, READ_COMMENTS_TOOL_NAME]) {
      const tool = withClient[name];
      if (!tool) {
        throw new Error(`Expected ${name} to be registered`);
      }
      expect(tool.needsApproval).toBeUndefined();
      expect(getChatToolPolicy(tool)).toEqual({
        kind: "internal",
        needsApproval: false,
        requiresAnonymization: false,
      });
    }
    for (const name of [
      ADD_COMMENT_TOOL_NAME,
      REPLY_COMMENT_TOOL_NAME,
      RESOLVE_COMMENT_TOOL_NAME,
    ]) {
      const tool = withClient[name];
      if (!tool) {
        throw new Error(`Expected ${name} to be registered`);
      }
      // Comment mutations are approval-gated, resolved client-side.
      expect(tool.needsApproval).toBe(true);
      expect(getChatToolPolicy(tool)).toEqual({
        kind: "mutation",
        needsApproval: true,
        requiresAnonymization: false,
      });
    }
  });

  test("registers the server-executed compare_versions tool when an active file field is available", () => {
    const baseArgs = {
      orgAIConfig: null,
      memberRole: "owner",
      organizationId,
      requestWorkspaceId: workspaceId,
      thirdPartyBoundary: { type: "raw" },
      refRegistry: createChatRefRegistry(),
      safeDb: unusedSafeDb,
      scopedDb: unusedScopedDb,
      threadId,
      userId,
      webSearchEnabled: false,
      webSearchProviders: { webSearchProvider: null, urlFetcher: null },
      hasActiveDocxEditClient: false,
      hasActiveDocxFileClient: false,
    } as const;
    const activeFile = {
      entityId: toSafeId<"entity">("33333333-3333-4333-8333-333333333333"),
      fileFieldId: toSafeId<"field">("44444444-4444-4444-8444-444444444444"),
      supportsDocxEdits: true,
    } as const;

    const withWorkspace = getChatTools({
      ...baseArgs,
      activeFile,
      toolWorkspaceIds: resolveToolWorkspaceIds({
        pinnedIds: [],
        accessibleWorkspaceIds: [workspaceId],
      }),
    });
    const compareVersions = withWorkspace[COMPARE_VERSIONS_TOOL_NAME];
    if (!compareVersions) {
      throw new Error("Expected compare_versions to be registered");
    }
    // Server-executed, read-only: no approval gate.
    expect(compareVersions.needsApproval).toBeUndefined();
    expect(getChatToolPolicy(compareVersions)).toEqual({
      kind: "internal",
      needsApproval: false,
      requiresAnonymization: false,
    });

    const withoutWorkspace = getChatTools({
      ...baseArgs,
      activeFile,
      toolWorkspaceIds: resolveToolWorkspaceIds({
        pinnedIds: [],
        accessibleWorkspaceIds: [],
      }),
    });
    expect(withoutWorkspace).not.toHaveProperty(COMPARE_VERSIONS_TOOL_NAME);
  });

  test("does not register compare_versions without an active file field", () => {
    const tools = getChatTools({
      orgAIConfig: null,
      memberRole: "owner",
      organizationId,
      requestWorkspaceId: workspaceId,
      thirdPartyBoundary: { type: "raw" },
      refRegistry: createChatRefRegistry(),
      safeDb: unusedSafeDb,
      scopedDb: unusedScopedDb,
      threadId,
      userId,
      webSearchEnabled: false,
      webSearchProviders: { webSearchProvider: null, urlFetcher: null },
      hasActiveDocxEditClient: false,
      hasActiveDocxFileClient: false,
      toolWorkspaceIds: resolveToolWorkspaceIds({
        pinnedIds: [],
        accessibleWorkspaceIds: [workspaceId],
      }),
    });
    expect(tools).not.toHaveProperty(COMPARE_VERSIONS_TOOL_NAME);
  });

  test("does not register compare_versions for non-DOCX active files", () => {
    const tools = getChatTools({
      orgAIConfig: null,
      memberRole: "owner",
      organizationId,
      requestWorkspaceId: workspaceId,
      thirdPartyBoundary: { type: "raw" },
      refRegistry: createChatRefRegistry(),
      safeDb: unusedSafeDb,
      scopedDb: unusedScopedDb,
      threadId,
      userId,
      webSearchEnabled: false,
      webSearchProviders: { webSearchProvider: null, urlFetcher: null },
      hasActiveDocxEditClient: false,
      hasActiveDocxFileClient: false,
      activeFile: {
        entityId: toSafeId<"entity">("33333333-3333-4333-8333-333333333333"),
        fileFieldId: toSafeId<"field">("44444444-4444-4444-8444-444444444444"),
      },
      toolWorkspaceIds: resolveToolWorkspaceIds({
        pinnedIds: [],
        accessibleWorkspaceIds: [workspaceId],
      }),
    });
    expect(tools).not.toHaveProperty(COMPARE_VERSIONS_TOOL_NAME);
  });

  test("only exposes current skill edit tools for editable active skill chats", () => {
    const tools = getChatTools({
      orgAIConfig: null,
      memberRole: "owner",
      organizationId,
      requestWorkspaceId: workspaceId,
      thirdPartyBoundary: { type: "raw" },
      refRegistry: createChatRefRegistry(),
      safeDb: unusedSafeDb,
      scopedDb: unusedScopedDb,
      threadId,
      userId,
      toolWorkspaceIds: resolveToolWorkspaceIds({
        pinnedIds: [],
        accessibleWorkspaceIds: [workspaceId],
      }),
      hasActiveDocxEditClient: false,
      hasActiveDocxFileClient: false,
      webSearchEnabled: false,
      webSearchProviders: { webSearchProvider: null, urlFetcher: null },
      activeSkillContext: editableActiveSkillContext,
      recordAuditEvent: noopAuditRecorder,
      skillMetadata: [
        {
          description: editableActiveSkillContext.description,
          name: editableActiveSkillContext.toolName,
          version: editableActiveSkillContext.version,
        },
      ],
    });

    const createResource = tools["create-current-skill-resource"];
    const updateBody = tools["update-current-skill-body"];
    const updateResource = tools["update-current-skill-resource"];

    expect(createResource).toBeDefined();
    expect(updateBody).toBeDefined();
    expect(updateResource).toBeDefined();

    if (!createResource || !updateBody || !updateResource) {
      throw new Error("Expected current skill edit tools to be registered");
    }

    for (const editTool of [createResource, updateBody, updateResource]) {
      expect(editTool.needsApproval).toBe(true);
      expect(getChatToolPolicy(editTool)).toEqual({
        kind: "mutation",
        needsApproval: true,
        requiresAnonymization: false,
      });
    }
  });

  test("does not expose full body replacement for truncated active skill bodies", () => {
    const tools = getChatTools({
      orgAIConfig: null,
      memberRole: "owner",
      organizationId,
      requestWorkspaceId: workspaceId,
      thirdPartyBoundary: { type: "raw" },
      refRegistry: createChatRefRegistry(),
      safeDb: unusedSafeDb,
      scopedDb: unusedScopedDb,
      threadId,
      userId,
      toolWorkspaceIds: resolveToolWorkspaceIds({
        pinnedIds: [],
        accessibleWorkspaceIds: [workspaceId],
      }),
      hasActiveDocxEditClient: false,
      hasActiveDocxFileClient: false,
      webSearchEnabled: false,
      webSearchProviders: { webSearchProvider: null, urlFetcher: null },
      activeSkillContext: {
        ...editableActiveSkillContext,
        body: "a".repeat(ACTIVE_SKILL_BODY_PROMPT_MAX_CHARS + 1),
      },
      recordAuditEvent: noopAuditRecorder,
      skillMetadata: [
        {
          description: editableActiveSkillContext.description,
          name: editableActiveSkillContext.toolName,
          version: editableActiveSkillContext.version,
        },
      ],
    });

    expect(tools).toHaveProperty("create-current-skill-resource");
    expect(tools).not.toHaveProperty("update-current-skill-body");
    expect(tools).toHaveProperty("update-current-skill-resource");
  });

  test("applies approval and anonymization policies by tool risk", () => {
    const tools = getChatTools({
      orgAIConfig: null,
      memberRole: "owner",
      organizationId,
      requestWorkspaceId: workspaceId,
      thirdPartyBoundary: { type: "raw" },
      refRegistry: createChatRefRegistry(),
      safeDb: unusedSafeDb,
      scopedDb: unusedScopedDb,
      threadId,
      userId,
      toolWorkspaceIds: resolveToolWorkspaceIds({
        pinnedIds: [],
        accessibleWorkspaceIds: [workspaceId],
      }),
      hasActiveDocxEditClient: false,
      hasActiveDocxFileClient: false,
      webSearchEnabled: false,
      webSearchProviders: { webSearchProvider: null, urlFetcher: null },
    });

    const businessRegistryLookup = tools["business_registry_lookup"];
    const updateEntityFields = tools["update-entity-fields"];
    const createDocument = tools["create-document"];
    const executeTypescript = tools["execute_typescript"];
    const searchChatHistory = tools[SEARCH_CHAT_HISTORY_TOOL_NAME];

    expect(businessRegistryLookup).toBeDefined();
    expect(updateEntityFields).toBeDefined();
    expect(createDocument).toBeDefined();
    expect(executeTypescript).toBeDefined();
    expect(searchChatHistory).toBeDefined();

    if (
      !businessRegistryLookup ||
      !updateEntityFields ||
      !createDocument ||
      !searchChatHistory
    ) {
      throw new Error("Expected chat tools to be registered");
    }

    expect(businessRegistryLookup.needsApproval).toBeUndefined();
    expect(getChatToolPolicy(businessRegistryLookup)).toEqual({
      kind: "public_official",
      needsApproval: false,
      requiresAnonymization: false,
    });
    expect(updateEntityFields.needsApproval).toBe(true);
    expect(getChatToolPolicy(updateEntityFields)).toEqual({
      kind: "mutation",
      needsApproval: true,
      requiresAnonymization: false,
    });
    expect(createDocument.needsApproval).toBeUndefined();
    expect(getChatToolPolicy(createDocument)).toEqual({
      kind: "internal",
      needsApproval: false,
      requiresAnonymization: false,
    });
    expect(executeTypescript?.needsApproval).toBeUndefined();
    expect(getChatToolPolicy(searchChatHistory)).toEqual({
      kind: "internal",
      needsApproval: false,
      requiresAnonymization: false,
    });
  });

  test("every registered chat tool serializes to a provider-safe JSON schema", () => {
    const tools = buildFullCoverageChatTools();

    // Sanity: the groups we depend on for coverage are actually present.
    for (const requiredTool of [
      "fill_template",
      "suggest_template_fields",
      "business_registry_lookup",
      "web_search",
      "create-document",
      READ_DOCUMENT_TOOL_NAME,
      FIND_TEXT_TOOL_NAME,
    ]) {
      expect(tools).toHaveProperty(requiredTool);
    }

    const allowedKeywords = new Set<string>(PROVIDER_SAFE_JSON_SCHEMA_KEYWORDS);
    const violations: string[] = [];
    const assertProviderSafe = (
      node: unknown,
      path: string,
      toolName: string,
    ): void => {
      if (!isSchemaObject(node)) {
        return;
      }

      for (const key of Object.keys(node)) {
        if (!allowedKeywords.has(key)) {
          violations.push(
            `tool "${toolName}" schema at "${path ? `${path}.${key}` : key}" carries non-provider-safe keyword "${key}"`,
          );
        }
      }

      const { properties, items, anyOf, additionalProperties } = node;
      if (isSchemaObject(properties)) {
        for (const [name, child] of Object.entries(properties)) {
          assertProviderSafe(
            child,
            `${path ? `${path}.` : ""}properties.${name}`,
            toolName,
          );
        }
      }
      if (Array.isArray(items)) {
        for (const [index, child] of items.entries()) {
          assertProviderSafe(child, `${path}.items[${index}]`, toolName);
        }
      } else if (isSchemaObject(items)) {
        assertProviderSafe(items, `${path}.items`, toolName);
      }
      if (Array.isArray(anyOf)) {
        for (const [index, child] of anyOf.entries()) {
          assertProviderSafe(child, `${path}.anyOf[${index}]`, toolName);
        }
      }
      if (isSchemaObject(additionalProperties)) {
        assertProviderSafe(
          additionalProperties,
          `${path}.additionalProperties`,
          toolName,
        );
      }
    };

    for (const [name, tool] of Object.entries(tools)) {
      const inputSchema = tool?.inputSchema;
      if (!inputSchema) {
        continue;
      }
      // Serialize through the exact conversion the runtime hands to providers.
      const serialized = convertSchemaToJsonSchema(inputSchema);
      assertProviderSafe(serialized, "", name);
    }

    expect(violations).toEqual([]);
  });

  for (const probe of providerRequestProbes) {
    test(`every registered chat tool reaches the final ${probe.provider} request`, async () => {
      const tools = serializeFullCoverageChatTools();
      const request = await probe.capture(tools);
      const providerTools = probe.toolsFromRequest(request);

      // This is deliberately an adapter/SDK-boundary invariant, matching the
      // provider suites in TanStack AI itself. Schema-only tests stop before
      // provider-specific conversion, which is where request-breaking fields
      // such as OpenAI strict mode and provider wire-name changes are added.
      expect(providerTools).toHaveLength(tools.length);
      for (const providerTool of providerTools) {
        expect(isSchemaObject(providerTool)).toBe(true);
      }
    });
  }

  test("Anthropic keeps an ordinary web_search function distinct from its native web-search tool", () => {
    const ordinaryWebSearch: Tool = {
      name: "web_search",
      description: "Search through stella's configured provider.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
    };
    const nativeWebSearch = anthropicWebSearchTool({
      name: "web_search",
      type: "web_search_20250305",
    });

    expect(convertAnthropicTools([ordinaryWebSearch, nativeWebSearch])).toEqual(
      [
        {
          name: "web_search",
          type: "custom",
          description: ordinaryWebSearch.description,
          input_schema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
          cache_control: null,
        },
        {
          name: "web_search",
          type: "web_search_20250305",
          cache_control: null,
        },
      ],
    );
  });

  // OpenAI rejects the entire request (400) when any tool is sent with
  // `strict: true` but a schema outside the strict Structured Outputs subset.
  // This test runs the real adapter conversion over every registered chat tool
  // offline, so a schema that would 400 in production fails here first, even
  // under USE_MOCK_AI. It also fails if the @tanstack/openai-base patch
  // (patches/) stops applying, e.g. after a version bump.
  test("every registered chat tool converts to strict-legal OpenAI parameters or the deliberate non-strict fallback", () => {
    const tools = buildFullCoverageChatTools();

    // Free-form map inputs (`v.record(...)`, `additionalProperties: true`)
    // cannot be expressed under strict mode, which requires every object node
    // closed with its keys enumerated; the adapter must send those tools with
    // `strict: false`. fill_template, save_clause and save_template degrade
    // for open maps; set_field_value for its deliberately typeless
    // `content.value` node. Growing this list is a deliberate trade: prefer
    // closed schemas so a tool keeps strict-mode adherence.
    const expectedNonStrictTools = [
      "fill_template",
      "save_clause",
      "save_template",
      "set_field_value",
    ];

    // A strict:true tool must satisfy OpenAI's strict subset: every object
    // node closed via `additionalProperties: false` with enumerated
    // `properties`, and no typeless schema nodes anywhere.
    const strictTypeIndicators = ["type", "enum", "const", "anyOf"];
    const violations: string[] = [];
    const collectStrictViolations = (
      node: unknown,
      path: string,
      toolName: string,
    ): void => {
      if (!isSchemaObject(node)) {
        return;
      }

      const { type, additionalProperties, properties, items, anyOf } = node;
      const isObjectNode =
        type === "object" || (Array.isArray(type) && type.includes("object"));
      if (isObjectNode) {
        if (additionalProperties !== false) {
          violations.push(
            `tool "${toolName}" at "${path}" sends strict: true with an object node not closed by additionalProperties: false`,
          );
        }
        if (!isSchemaObject(properties)) {
          violations.push(
            `tool "${toolName}" at "${path}" sends strict: true with an object node without enumerated properties`,
          );
        }
      }
      if (!strictTypeIndicators.some((key) => key in node)) {
        violations.push(
          `tool "${toolName}" at "${path}" sends strict: true with a typeless schema node`,
        );
      }
      if (isSchemaObject(properties)) {
        for (const [name, child] of Object.entries(properties)) {
          collectStrictViolations(
            child,
            `${path}.properties.${name}`,
            toolName,
          );
        }
      }
      if (Array.isArray(items)) {
        for (const [index, child] of items.entries()) {
          collectStrictViolations(child, `${path}.items[${index}]`, toolName);
        }
      } else if (isSchemaObject(items)) {
        collectStrictViolations(items, `${path}.items`, toolName);
      }
      if (Array.isArray(anyOf)) {
        for (const [index, child] of anyOf.entries()) {
          collectStrictViolations(child, `${path}.anyOf[${index}]`, toolName);
        }
      }
    };

    const nonStrictTools: string[] = [];
    for (const [name, tool] of Object.entries(tools)) {
      const inputSchema = tool?.inputSchema;
      if (!inputSchema) {
        continue;
      }
      // The exact pipeline the runtime runs: the ai layer serializes the
      // Standard Schema to JSON Schema, then the OpenAI adapter converts it
      // to a function tool and decides strict mode.
      const serialized = convertSchemaToJsonSchema(inputSchema);
      if (!serialized) {
        continue;
      }
      const converted = convertFunctionToolToAdapterFormat({
        name,
        description: tool.description,
        inputSchema: serialized,
      });
      if (converted.strict !== true) {
        nonStrictTools.push(name);
        continue;
      }
      collectStrictViolations(converted.parameters, "root", name);
    }

    expect(violations).toEqual([]);
    expect(nonStrictTools.toSorted()).toEqual(expectedNonStrictTools);
  });

  // The companion to the strict-mode test above, guarding the inbound leg.
  //
  // OpenAI strict Structured Outputs requires every property to appear in
  // `required`, so the adapter's `coerceStrictSchema` null-widens each optional
  // property (`type: ["array", "null"]`) and then marks it required. The model
  // is therefore *instructed* to send `null` for a field it wants to omit, and
  // it does. Those args are validated straight back against the tool's own
  // Valibot schema (`parseWithStandardSchema(tool.inputSchema, args)` in
  // TanStack's tool-calls.ts), so a field declared `v.optional(...)` — which
  // accepts `undefined` but not `null` — rejects the model's own legally
  // required output and kills the whole chat turn.
  //
  // The invariant: no validation issue may land on a null-widened path. We know
  // those paths from the converted schema, and we only ever place `null` there,
  // so an issue at one of them is the schema refusing a null OpenAI compelled.
  // Checking paths rather than whole-payload validity keeps coverage honest:
  // a tool whose `pattern` we cannot synthesize (a BOE law id, an ELI uri)
  // still gets its null dimension checked, because the resulting complaint
  // lands on the string's path, not on a null-widened one.
  //
  // Model-facing optional fields must use `v.nullish(...)`, not `v.optional(...)`.
  // (Output schemas are exempt: our own `execute()` produces those values, so
  // the adapter never null-widens them and `v.optional(...)` stays correct.)
  test("no registered chat tool rejects the nulls OpenAI strict mode forces for omitted fields", async () => {
    const tools = buildFullCoverageChatTools();

    const isNullWidened = (node: unknown): boolean => {
      if (!isSchemaObject(node)) {
        return false;
      }
      const { type, anyOf } = node;
      if (type === "null") {
        return true;
      }
      if (Array.isArray(type) && type.includes("null")) {
        return true;
      }
      return (
        Array.isArray(anyOf) &&
        anyOf.some((entry) => isSchemaObject(entry) && entry["type"] === "null")
      );
    };

    // Array indices are collapsed to `[]` so a schema path (`questions.items`)
    // and a runtime issue path (`questions.0`) compare equal.
    const joinPath = (parent: string, key: string): string =>
      parent ? `${parent}.${key}` : key;

    const nullWidenedPaths = (node: unknown, path = ""): string[] => {
      if (!isSchemaObject(node)) {
        return [];
      }
      const found: string[] = [];
      const { properties, items, anyOf } = node;
      if (isSchemaObject(properties)) {
        for (const [name, child] of Object.entries(properties)) {
          const childPath = joinPath(path, name);
          if (isNullWidened(child)) {
            found.push(childPath);
          }
          found.push(...nullWidenedPaths(child, childPath));
        }
      }
      if (isSchemaObject(items)) {
        found.push(...nullWidenedPaths(items, joinPath(path, "[]")));
      }
      if (Array.isArray(anyOf)) {
        for (const arm of anyOf) {
          found.push(...nullWidenedPaths(arm, path));
        }
      }
      return found;
    };

    const synthesizeString = (node: Record<string, unknown>): string => {
      const { format, minLength } = node;
      if (format === "uuid") {
        return "77777777-7777-4777-8777-777777777777";
      }
      if (format === "email") {
        return "probe@example.com";
      }
      if (format === "date-time") {
        return "2026-01-01T00:00:00.000Z";
      }
      if (format === "date") {
        return "2026-01-01";
      }
      if (format === "uri") {
        return "https://example.com";
      }
      return "x".repeat(
        typeof minLength === "number" ? Math.max(minLength, 1) : 1,
      );
    };

    // Strict mode forces every property at every level to be present, so a
    // faithful payload populates all of them. Two knobs sweep the space of
    // nulls the model may legally emit:
    //
    // - `branch` selects which arm of every `anyOf` (and which `enum` value) to
    //   take, so every arm of every union is visited across the sweep.
    // - `nullDepth` is the object depth at which optional fields flip from
    //   populated to null: depth 0 nulls the top-level optionals, depth 1
    //   populates those and nulls the optionals one level in, and so on. Without
    //   it, an optional nested inside another optional would never be reached.
    // `nulled` collects the paths this payload actually set to null. Only an
    // issue landing on one of those is evidence of a null rejection: at
    // `nullDepth` > 0 an optional field is populated instead, and a synthesized
    // value that trips the field's own `pattern` would otherwise raise an issue
    // at the very same path and read as a false positive.
    type SynthesizeOptions = {
      branch: number;
      nullDepth: number;
      nulled: Set<string>;
    };

    const synthesize = (
      node: unknown,
      options: SynthesizeOptions,
      depth = 0,
      path = "",
    ): unknown => {
      if (!isSchemaObject(node)) {
        return null;
      }

      const { type, anyOf, enum: enumValues, properties, items } = node;

      if (Array.isArray(anyOf) && anyOf.length > 0) {
        // Skip the `{ type: "null" }` arm the adapter appended: the caller
        // decides null-vs-value here, not the schema.
        const valueArms = anyOf.filter(
          (arm) => !(isSchemaObject(arm) && arm["type"] === "null"),
        );
        if (valueArms.length === 0) {
          return null;
        }
        const arm = valueArms.at(
          Math.min(options.branch, valueArms.length - 1),
        );
        return synthesize(arm, options, depth, path);
      }

      if (Array.isArray(enumValues) && enumValues.length > 0) {
        return enumValues.at(Math.min(options.branch, enumValues.length - 1));
      }

      const resolvedType = Array.isArray(type)
        ? type.find((entry) => entry !== "null")
        : type;

      if (resolvedType === "object") {
        const result: Record<string, unknown> = {};
        if (!isSchemaObject(properties)) {
          return result;
        }
        for (const [name, child] of Object.entries(properties)) {
          const childPath = joinPath(path, name);
          // A null-widened property is one the source schema declared optional.
          if (isNullWidened(child) && depth >= options.nullDepth) {
            options.nulled.add(childPath);
            result[name] = null;
            continue;
          }
          result[name] = synthesize(child, options, depth + 1, childPath);
        }
        return result;
      }

      if (resolvedType === "array") {
        const { minItems, maxItems } = node;
        const atLeast =
          typeof minItems === "number" ? Math.max(minItems, 1) : 1;
        const count =
          typeof maxItems === "number" ? Math.min(atLeast, maxItems) : atLeast;
        return Array.from({ length: count }, () =>
          synthesize(items, options, depth, joinPath(path, "[]")),
        );
      }

      if (resolvedType === "string") {
        return synthesizeString(node);
      }
      if (resolvedType === "integer" || resolvedType === "number") {
        const { minimum } = node;
        return typeof minimum === "number" ? minimum : 1;
      }
      if (resolvedType === "boolean") {
        return false;
      }
      return null;
    };

    // Sweep bounds are read off the schema, so a tool that grows a union arm or
    // another layer of optionals stays covered without edits here. Strict-mode
    // schemas carry no `$ref`, so the walk always terminates.
    const schemaBounds = (
      node: unknown,
      depth = 0,
    ): { branches: number; depth: number } => {
      if (!isSchemaObject(node)) {
        return { branches: 1, depth };
      }
      let branches = 1;
      let maxDepth = depth;
      const visit = (child: unknown, childDepth: number): void => {
        const bounds = schemaBounds(child, childDepth);
        branches = Math.max(branches, bounds.branches);
        maxDepth = Math.max(maxDepth, bounds.depth);
      };

      const { anyOf, enum: enumValues, properties, items } = node;
      if (Array.isArray(anyOf)) {
        branches = Math.max(branches, anyOf.length);
        for (const arm of anyOf) {
          visit(arm, depth);
        }
      }
      if (Array.isArray(enumValues)) {
        branches = Math.max(branches, enumValues.length);
      }
      if (isSchemaObject(properties)) {
        for (const child of Object.values(properties)) {
          visit(child, depth + 1);
        }
      }
      if (isSchemaObject(items)) {
        visit(items, depth);
      }
      return { branches, depth: maxDepth };
    };

    // The tool's own validator, which is what `parseWithStandardSchema` calls at
    // runtime. Awaited rather than routed through that helper because
    // `apply-active-docx-edits` wraps its schema in an async repairing
    // validator, and the helper is sync-only. Awaiting covers both kinds.
    type ValidationIssue = { readonly path?: readonly unknown[] };
    type StandardResult = { readonly issues?: readonly ValidationIssue[] };

    const validatorOf = (
      schema: unknown,
    ):
      | ((value: unknown) => StandardResult | Promise<StandardResult>)
      | null => {
      if (!isSchemaObject(schema)) {
        return null;
      }
      const standard = schema["~standard"];
      if (!isSchemaObject(standard)) {
        return null;
      }
      const validate: unknown = standard["validate"];
      if (typeof validate !== "function") {
        return null;
      }
      return (value: unknown) => validate(value);
    };

    const issuePathsFor = async (
      validate: (value: unknown) => StandardResult | Promise<StandardResult>,
      args: unknown,
    ): Promise<string[]> => {
      const result = await validate(args);
      return (result.issues ?? []).map((issue) =>
        (issue.path ?? [])
          .map((segment) => {
            const key =
              isSchemaObject(segment) && "key" in segment
                ? segment["key"]
                : segment;
            return typeof key === "number" ? "[]" : String(key);
          })
          .join("."),
      );
    };

    // Every (tool, payload) pair to check, built up front so the validations can
    // run together rather than serially inside the sweep.
    type NullProbe = {
      name: string;
      validate: (value: unknown) => StandardResult | Promise<StandardResult>;
      args: unknown;
      nulled: Set<string>;
    };

    const probes: NullProbe[] = [];
    // Tools actually swept. Asserted against below so that a tool dropping out
    // of coverage — a schema that stops being strict, stops exposing a Standard
    // Schema validator, or loses its optional fields — surfaces as a failure
    // rather than as silent green.
    const checked: string[] = [];

    for (const [name, tool] of Object.entries(tools)) {
      const inputSchema = tool?.inputSchema;
      if (!inputSchema) {
        continue;
      }
      const serialized = convertSchemaToJsonSchema(inputSchema);
      if (!serialized) {
        continue;
      }
      const converted = convertFunctionToolToAdapterFormat({
        name,
        description: tool.description,
        inputSchema: serialized,
      });
      // Non-strict tools are sent unmodified, so the adapter never null-widens
      // them and the model is never forced to emit a null.
      if (converted.strict !== true) {
        continue;
      }

      // No optional field: nothing for strict mode to null-widen.
      if (nullWidenedPaths(converted.parameters).length === 0) {
        continue;
      }

      // Tools declaring a raw JSON Schema rather than a Standard Schema (the
      // folio-agent tools) are never validated at runtime —
      // `parseWithStandardSchema` passes their args straight through — so they
      // cannot reject a null.
      const validate = validatorOf(inputSchema);
      if (!validate) {
        continue;
      }
      checked.push(name);

      const bounds = schemaBounds(converted.parameters);
      for (let branch = 0; branch < bounds.branches; branch++) {
        for (let nullDepth = 0; nullDepth <= bounds.depth; nullDepth++) {
          const nulled = new Set<string>();
          const args = synthesize(converted.parameters, {
            branch,
            nullDepth,
            nulled,
          });
          probes.push({ name, validate, args, nulled });
        }
      }
    }

    const rejections = await Promise.all(
      probes.map(async ({ name, validate, args, nulled }) => {
        const paths = await issuePathsFor(validate, args);
        return paths
          .filter((path) => nulled.has(path))
          .map((path) => `${name} ${path}`);
      }),
    );

    const violations = [...new Set(rejections.flat())]
      .toSorted()
      .map((entry) => {
        const [name, path] = entry.split(" ");
        return `tool "${name}" rejects the null OpenAI strict mode forces at "${path}": declare it v.nullish(...), not v.optional(...)`;
      });

    expect(violations).toEqual([]);
    // The tools known to carry optional model-facing inputs. If one drops off
    // this list it has silently left coverage, which is the failure mode this
    // test exists to prevent.
    for (const covered of [
      "ask-user",
      "web_search",
      "fetch_url",
      "boe_get_law",
      "boe_search_legislation",
      "business_registry_lookup",
      "search-chat-history",
      "expand-chat-history",
      "spawn_subagents",
      APPLY_ACTIVE_DOCX_EDITS_TOOL_NAME,
    ]) {
      expect(checked).toContain(covered);
    }
  });

  test("created document output includes the canonical entity mention", () => {
    const refRegistry = createChatRefRegistry();

    expect(
      buildCreatedDocumentToolOutput({
        entityId,
        fileName: "Mzuri_Umowa_Strona_1.docx",
        refRegistry,
        workspaceId,
      }),
    ).toEqual({
      success: true,
      fileName: "Mzuri_Umowa_Strona_1.docx",
      entityRef: "ent_1",
      matterRef: "mat_1",
      href: "#stella-entity-ref=ent_1",
      mention: "[Mzuri_Umowa_Strona_1.docx](#stella-entity-ref=ent_1)",
    });
  });
});

describe("registry write tool approval policy", () => {
  const projectedWriteNames = DEFAULT_MCP_TOOL_DEFINITIONS.filter(
    (definition) =>
      definition.access === "write" &&
      WRITE_TOOL_REF_FIELD_MAP[definition.name].chatProjectable,
  ).map((definition) => definition.name);

  const buildToolsWithWorkspace = () =>
    getChatTools({
      orgAIConfig: null,
      memberRole: "owner",
      organizationId,
      requestWorkspaceId: workspaceId,
      thirdPartyBoundary: { type: "raw" },
      refRegistry: createChatRefRegistry(),
      safeDb: unusedSafeDb,
      scopedDb: unusedScopedDb,
      threadId,
      userId,
      toolWorkspaceIds: resolveToolWorkspaceIds({
        pinnedIds: [],
        accessibleWorkspaceIds: [workspaceId],
      }),
      hasActiveDocxEditClient: false,
      hasActiveDocxFileClient: false,
      webSearchEnabled: false,
      webSearchProviders: { webSearchProvider: null, urlFetcher: null },
      recordAuditEvent: noopAuditRecorder,
    });

  test("every projected write tool needs approval and is classified mutation", () => {
    const tools = buildToolsWithWorkspace();
    expect(projectedWriteNames.length).toBeGreaterThan(0);

    for (const name of projectedWriteNames) {
      const tool = tools[name];
      if (!tool) {
        throw new Error(`Projected write tool ${name} was not registered`);
      }
      expect(tool.needsApproval, name).toBe(true);
      expect(getChatToolPolicy(tool).kind, name).toBe("mutation");
    }
  });

  test("no write tools are registered when the workspace set is empty", () => {
    const tools = getChatTools({
      orgAIConfig: null,
      memberRole: "owner",
      organizationId,
      requestWorkspaceId: workspaceId,
      thirdPartyBoundary: { type: "raw" },
      refRegistry: createChatRefRegistry(),
      safeDb: unusedSafeDb,
      scopedDb: unusedScopedDb,
      threadId,
      userId,
      toolWorkspaceIds: resolveToolWorkspaceIds({
        pinnedIds: [],
        accessibleWorkspaceIds: [],
      }),
      hasActiveDocxEditClient: false,
      hasActiveDocxFileClient: false,
      webSearchEnabled: false,
      webSearchProviders: { webSearchProvider: null, urlFetcher: null },
      recordAuditEvent: noopAuditRecorder,
    });

    for (const name of projectedWriteNames) {
      expect(tools, name).not.toHaveProperty(name);
    }
  });
});
