import {
  convertSchemaToJsonSchema,
  EventType,
  parseWithStandardSchema,
  toolDefinition,
  type StreamChunk,
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
import { createOpenRouterText } from "@tanstack/ai-openrouter";
import {
  DuplicateToolNameError,
  resolveDebugOption,
} from "@tanstack/ai/adapter-internals";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import type { ChatThirdPartyBoundary } from "@/api/handlers/chat/third-party-boundary";
import { resolveToolWorkspaceIds } from "@/api/handlers/chat/tools/authorized-workspace-ids";
import {
  EXPAND_CHAT_HISTORY_TOOL_NAME,
  SEARCH_CHAT_HISTORY_TOOL_NAME,
} from "@/api/handlers/chat/tools/chat-history-tools";
import { getChatTools as getChatToolsWithPin } from "@/api/handlers/chat/tools/chat-tools";
import { CREATE_MATTER_DOCUMENT_TOOL_NAME } from "@/api/handlers/chat/tools/create-workspace-document-tools";
import { REVIEW_FOLDER_CONSISTENCY_TOOL_NAME } from "@/api/handlers/chat/tools/folder-consistency-review-tool";
import {
  ADD_COMMENT_TOOL_NAME,
  FIND_TEXT_TOOL_NAME,
  GET_DOCUMENT_OUTLINE_TOOL_NAME,
  LIST_STORIES_TOOL_NAME,
  READ_CHANGES_TOOL_NAME,
  READ_COMMENTS_TOOL_NAME,
  READ_DOCUMENT_TOOL_NAME,
  READ_SECTION_TOOL_NAME,
  READ_STORY_TOOL_NAME,
  REPLY_COMMENT_TOOL_NAME,
  RESOLVE_COMMENT_TOOL_NAME,
  SHOW_IN_DOCUMENT_TOOL_NAME,
  SUGGEST_CHANGES_TOOL_NAME,
} from "@/api/handlers/chat/tools/folio-agent-tools";
import { WRITE_TOOL_REF_FIELD_MAP } from "@/api/handlers/chat/tools/registry-adapter/ref-field-map";
import { REMEMBER_TOOL_NAME } from "@/api/handlers/chat/tools/remember-tool";
import { getChatToolPolicy } from "@/api/handlers/chat/tools/tool-policy";
import { COMPARE_VERSIONS_TOOL_NAME } from "@/api/handlers/chat/tools/version-compare-tools";
import { createSkillTools } from "@/api/lib/agent-skills/skill-tools";
import {
  ACTIVE_SKILL_BODY_PROMPT_MAX_CHARS,
  type ActiveChatSkillContext,
} from "@/api/lib/agent-skills/skills";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
import { createChatToolDefectMemo } from "@/api/lib/chat/tool-defect-memo";
import {
  PROVIDER_SAFE_JSON_SCHEMA_KEYWORDS,
  providerSafeJsonSchemaOptionsForTanStackProvider,
} from "@/api/lib/provider-safe-json-schema";
import { projectSchemaInputJsonSchema } from "@/api/lib/tanstack-ai-schema";
import type { UrlFetcher, WebSearchProvider } from "@/api/lib/web-search/types";
import { DEFAULT_MCP_TOOL_DEFINITIONS } from "@/api/mcp/static-tool-definitions";
import { TEMPLATE_FIELD_REFERENCE_URI } from "@/api/mcp/template-field-reference";
import { TEMPLATE_MARKER_REFERENCE_URI } from "@/api/mcp/template-marker-reference";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import { createOrgTools } from "./org-tools";
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
const rawThirdPartyBoundary = {
  type: "raw",
} as const satisfies ChatThirdPartyBoundary;

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
    memoryEnabled: props.memoryEnabled ?? true,
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

/** The per-surface `type` enum a registered `suggest_changes` tool exposes. */
const suggestChangesOperationTypeEnum = (
  tool:
    | { inputSchema?: Parameters<typeof convertSchemaToJsonSchema>[0] }
    | undefined,
): unknown[] => {
  if (!tool) {
    throw new Error("Expected suggest_changes to be registered");
  }
  const jsonSchema = requireRecord(
    convertSchemaToJsonSchema(tool.inputSchema),
    "suggest_changes input schema",
  );
  const operations = requireRecord(
    requireRecord(jsonSchema["properties"], "input schema properties")[
      "operations"
    ],
    "operations schema",
  );
  const items = requireRecord(operations["items"], "operations.items schema");
  const type = requireRecord(
    requireRecord(items["properties"], "operations.items.properties")["type"],
    "operations.items.properties.type",
  );
  return requireArray(type["enum"], "operations.items.properties.type.enum");
};

// Construct args so every conditional tool group registers: owner role
// (template use + create, and entity create for create_matter_document),
// an active (non-archived) workspace status for that same reason, active
// docx edit client, web search enabled with a resolved provider, and an
// editable active skill context. BOE, infosoud, and business-registry tools
// register by default (no disabled slugs).
const buildFullCoverageChatTools = (
  thirdPartyBoundary: ChatThirdPartyBoundary = rawThirdPartyBoundary,
) => {
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
    thirdPartyBoundary,
    refRegistry: createChatRefRegistry(),
    toolDefectMemo: createChatToolDefectMemo(),
    safeDb: unusedSafeDb,
    scopedDb: unusedScopedDb,
    threadId,
    workspaceId: null,
    userId,
    toolWorkspaceIds: resolveToolWorkspaceIds({
      pinnedIds: [],
      accessibleWorkspaceIds: [workspaceId],
    }),
    hasActiveDocxEditClient: true,
    hasActiveDocxFileClient: true,
    docxSuggestionSurface: "file-overlay",
    // Explicit "manual": DEFAULT_CHAT_EDIT_APPLY_MODE is now "auto", which
    // would suppress suggest_changes here (this call sets no
    // activeFile, so the auto tool never registers either) and drop it out
    // of full coverage. Pin "manual" so this helper keeps exercising both
    // the manual tool's schema and its own dedicated authorization tests
    // below, independent of the production default.
    editApplyMode: "manual",
    webSearchEnabled: true,
    webSearchProviders: { webSearchProvider, urlFetcher },
    activeSkillContext: editableActiveSkillContext,
    recordAuditEvent: noopAuditRecorder,
    workspaceStatusById: new Map([[workspaceId, "active"]]),
    resolveMemorySourceWorkspaceIds: () => [],
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
      const adapter = createOpenRouterText("openai/gpt-5.2", "test-key");
      let request: unknown;
      Reflect.set(adapter, "orClient", {
        chat: {
          send: (payload: unknown) => {
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
      return requireRecord(request, "OpenRouter SDK request");
    },
    toolsFromRequest: (request) => {
      const chatRequest = requireRecord(
        request["chatRequest"],
        "OpenRouter chat request",
      );
      return requireArray(chatRequest["tools"], "OpenRouter request tools");
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
        refRegistry: createChatRefRegistry(),
        scopedDb: unusedScopedDb,
      }),
    ).not.toThrow();
  });

  test("workspace tool schemas enumerate matter refs, never workspace UUIDs", () => {
    const registry = createChatRefRegistry();
    const tools = createWorkspaceTools({
      allowedWorkspaceIds: [workspaceId],
      refRegistry: registry,
      scopedDb: unusedScopedDb,
    });
    const serialized = JSON.stringify(
      Object.values(tools).map((tool) => ({
        description: tool.description,
        inputSchema: convertSchemaToJsonSchema(tool.inputSchema),
      })),
    );
    // The tool catalog is provider-visible every turn: enumerating raw
    // workspace ids here is exactly how the model once learned (and used)
    // a tenant UUID as a matter_id.
    expect(serialized).toContain(registry.toMatterRef(workspaceId));
    expect(serialized).not.toContain(workspaceId);
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

  test("does not offer skill lookup when the catalog is empty", () => {
    const tools = createSkillTools({
      organizationId,
      safeDb: unusedSafeDb,
      skills: [],
      userId,
    });

    expect(tools["load-skill"]).toBeUndefined();
    expect(tools["read-skill-resource"]).toBeUndefined();
  });

  test("constrains public skill calls to the available catalog", () => {
    const tools = createSkillTools({
      organizationId,
      safeDb: unusedSafeDb,
      skills: [
        {
          description: "Run a public legal workflow.",
          name: "public-legal-workflow",
          version: "1.0",
        },
      ],
      userId,
    });
    const loadSkill = tools["load-skill"];
    if (!loadSkill?.inputSchema) {
      throw new TypeError("Expected load-skill input schema");
    }

    const schema = convertSchemaToJsonSchema(loadSkill.inputSchema);
    expect(schema?.properties?.["skillName"]?.enum).toEqual([
      "public-legal-workflow",
    ]);
  });

  test("keeps installed skill names out of tool schema descriptions", () => {
    const tools = createSkillTools({
      organizationId,
      safeDb: unusedSafeDb,
      skills: [
        {
          description: "Private matter-specific workflow.",
          name: "acme-closing-strategy",
          source: "installed",
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
      toolDefectMemo: createChatToolDefectMemo(),
      safeDb: unusedSafeDb,
      scopedDb: unusedScopedDb,
      threadId,
      workspaceId: null,
      userId,
      toolWorkspaceIds: resolveToolWorkspaceIds({
        pinnedIds: [],
        accessibleWorkspaceIds: [workspaceId],
      }),
      hasActiveDocxEditClient: false,
      hasActiveDocxFileClient: false,
      docxSuggestionSurface: "template-studio",
      webSearchEnabled: false,
      webSearchProviders: { webSearchProvider: null, urlFetcher: null },
      recordAuditEvent: noopAuditRecorder,
      resolveMemorySourceWorkspaceIds: () => [],
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
    expect(tools).toHaveProperty(REMEMBER_TOOL_NAME);
    const remember = tools[REMEMBER_TOOL_NAME];
    expect(remember?.needsApproval).toBe(true);
    expect(remember ? getChatToolPolicy(remember) : null).toEqual({
      kind: "mutation",
      needsApproval: true,
      requiresAnonymization: false,
    });
    expect(tools).toHaveProperty("update-entity-fields");
    expect(tools).not.toHaveProperty("search-across-matters");
    expect(tools).not.toHaveProperty("read-content-across-matters");
    expect(tools).not.toHaveProperty("read-contact");
    // No live editor surface on this turn (`hasActiveDocxEditClient: false`):
    // the folio-agents doc tools must stay unregistered, same precondition
    // as `suggest_changes`.
    expect(tools).not.toHaveProperty(READ_DOCUMENT_TOOL_NAME);
    expect(tools).not.toHaveProperty(FIND_TEXT_TOOL_NAME);
  });

  test("keeps historical remember calls schema-valid while memory is disabled", () => {
    const baseArgs = {
      orgAIConfig: null,
      memberRole: "owner" as const,
      organizationId,
      requestWorkspaceId: workspaceId,
      thirdPartyBoundary: { type: "raw" as const },
      refRegistry: createChatRefRegistry(),
      toolDefectMemo: createChatToolDefectMemo(),
      safeDb: unusedSafeDb,
      scopedDb: unusedScopedDb,
      threadId,
      workspaceId,
      userId,
      toolWorkspaceIds: resolveToolWorkspaceIds({
        pinnedIds: [],
        accessibleWorkspaceIds: [workspaceId],
      }),
      hasActiveDocxEditClient: false,
      hasActiveDocxFileClient: false,
      docxSuggestionSurface: "template-studio" as const,
      webSearchEnabled: false,
      webSearchProviders: { webSearchProvider: null, urlFetcher: null },
      recordAuditEvent: noopAuditRecorder,
      resolveMemorySourceWorkspaceIds: () => [],
      memoryEnabled: false,
    };

    expect(getChatTools(baseArgs)).not.toHaveProperty(REMEMBER_TOOL_NAME);
    expect(
      getChatTools({
        ...baseArgs,
        includeRememberToolForValidation: true,
      }),
    ).toHaveProperty(REMEMBER_TOOL_NAME);
  });

  test("registers the folio-agents read_document/find_text tools only when the file-overlay docx client is active", () => {
    const baseArgs = {
      orgAIConfig: null,
      memberRole: "owner",
      organizationId,
      requestWorkspaceId: workspaceId,
      thirdPartyBoundary: { type: "raw" },
      refRegistry: createChatRefRegistry(),
      toolDefectMemo: createChatToolDefectMemo(),
      safeDb: unusedSafeDb,
      scopedDb: unusedScopedDb,
      threadId,
      workspaceId: null,
      userId,
      toolWorkspaceIds: resolveToolWorkspaceIds({
        pinnedIds: [],
        accessibleWorkspaceIds: [workspaceId],
      }),
      webSearchEnabled: false,
      webSearchProviders: { webSearchProvider: null, urlFetcher: null },
      // Explicit "manual": Template Studio has no entity-backed
      // `activeFile` (it uses `activeTemplate`), so the "auto" default
      // could never register the server-executed apply variant there
      // anyway; pin "manual" so this test keeps exercising the queue
      // variant's registration independent of the production default,
      // matching this test's actual subject (the folio-agents read tools'
      // own narrower gate).
      editApplyMode: "manual",
    } as const;

    const withoutClient = getChatTools({
      ...baseArgs,
      hasActiveDocxEditClient: false,
      hasActiveDocxFileClient: false,
      docxSuggestionSurface: "template-studio",
    });
    expect(withoutClient).not.toHaveProperty(READ_DOCUMENT_TOOL_NAME);
    expect(withoutClient).not.toHaveProperty(FIND_TEXT_TOOL_NAME);

    // Template Studio: `suggest_changes` is on (the combined
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
      docxSuggestionSurface: "template-studio",
    });
    expect(templateOnly).toHaveProperty(SUGGEST_CHANGES_TOOL_NAME);
    // No file-overlay client: `suggest_changes` gets the narrower
    // Template Studio operation-type list, not the file overlay's.
    expect(
      suggestChangesOperationTypeEnum(templateOnly[SUGGEST_CHANGES_TOOL_NAME]),
    ).toEqual(["replaceInBlock", "replaceBlock", "deleteBlock"]);
    expect(templateOnly).not.toHaveProperty(READ_DOCUMENT_TOOL_NAME);
    expect(templateOnly).not.toHaveProperty(FIND_TEXT_TOOL_NAME);

    expect(templateOnly).not.toHaveProperty(GET_DOCUMENT_OUTLINE_TOOL_NAME);
    expect(templateOnly).not.toHaveProperty(READ_SECTION_TOOL_NAME);
    expect(templateOnly).not.toHaveProperty(LIST_STORIES_TOOL_NAME);
    expect(templateOnly).not.toHaveProperty(READ_STORY_TOOL_NAME);
    expect(templateOnly).not.toHaveProperty(SHOW_IN_DOCUMENT_TOOL_NAME);
    expect(templateOnly).not.toHaveProperty(READ_CHANGES_TOOL_NAME);
    expect(templateOnly).not.toHaveProperty(READ_COMMENTS_TOOL_NAME);
    expect(templateOnly).not.toHaveProperty(ADD_COMMENT_TOOL_NAME);
    expect(templateOnly).not.toHaveProperty(REPLY_COMMENT_TOOL_NAME);
    expect(templateOnly).not.toHaveProperty(RESOLVE_COMMENT_TOOL_NAME);

    const withClient = getChatTools({
      ...baseArgs,
      hasActiveDocxEditClient: true,
      hasActiveDocxFileClient: true,
      docxSuggestionSurface: "file-overlay",
    });
    const readDocument = withClient[READ_DOCUMENT_TOOL_NAME];
    const findText = withClient[FIND_TEXT_TOOL_NAME];
    expect(readDocument).toBeDefined();
    expect(findText).toBeDefined();
    if (!readDocument || !findText) {
      throw new Error("Expected folio-agents doc tools to be registered");
    }

    // A live file-overlay client: `suggest_changes` gets the full file
    // overlay operation-type list (no `formatRange`), unlike Template
    // Studio's narrower list above.
    expect(
      suggestChangesOperationTypeEnum(withClient[SUGGEST_CHANGES_TOOL_NAME]),
    ).toEqual([
      "replaceInBlock",
      "replaceRange",
      "commentOnRange",
      "insertAfterBlock",
      "insertBeforeBlock",
      "replaceBlock",
      "deleteBlock",
      "commentOnBlock",
      "insertSignatureTable",
      "insertTableRow",
      "deleteTableRow",
      "insertTableColumn",
      "deleteTableColumn",
      "mergeTableCells",
      "splitTableCell",
    ]);

    // Client-executed, read-only: no approval gate.
    expect(readDocument.needsApproval).toBeUndefined();
    expect(findText.needsApproval).toBeUndefined();
    expect(getChatToolPolicy(readDocument)).toEqual({
      kind: "internal",
      needsApproval: false,
      requiresAnonymization: false,
    });

    // The rest of the folio-agents read tools share the same file-client
    // gate and are auto-run (no approval).
    for (const name of [
      GET_DOCUMENT_OUTLINE_TOOL_NAME,
      READ_SECTION_TOOL_NAME,
      LIST_STORIES_TOOL_NAME,
      READ_STORY_TOOL_NAME,
      SHOW_IN_DOCUMENT_TOOL_NAME,
      READ_CHANGES_TOOL_NAME,
      READ_COMMENTS_TOOL_NAME,
    ]) {
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
      toolDefectMemo: createChatToolDefectMemo(),
      safeDb: unusedSafeDb,
      scopedDb: unusedScopedDb,
      threadId,
      workspaceId: null,
      userId,
      webSearchEnabled: false,
      webSearchProviders: { webSearchProvider: null, urlFetcher: null },
      hasActiveDocxEditClient: false,
      hasActiveDocxFileClient: false,
      docxSuggestionSurface: "template-studio",
    } as const;
    const activeFile = {
      entityId: toSafeId<"entity">("33333333-3333-4333-8333-333333333333"),
      currentVersionId: toSafeId<"entityVersion">(
        "55555555-5555-4555-8555-555555555556",
      ),
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
      toolDefectMemo: createChatToolDefectMemo(),
      safeDb: unusedSafeDb,
      scopedDb: unusedScopedDb,
      threadId,
      workspaceId: null,
      userId,
      webSearchEnabled: false,
      webSearchProviders: { webSearchProvider: null, urlFetcher: null },
      hasActiveDocxEditClient: false,
      hasActiveDocxFileClient: false,
      docxSuggestionSurface: "template-studio",
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
      toolDefectMemo: createChatToolDefectMemo(),
      safeDb: unusedSafeDb,
      scopedDb: unusedScopedDb,
      threadId,
      workspaceId: null,
      userId,
      webSearchEnabled: false,
      webSearchProviders: { webSearchProvider: null, urlFetcher: null },
      hasActiveDocxEditClient: false,
      hasActiveDocxFileClient: false,
      docxSuggestionSurface: "template-studio",
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
      toolDefectMemo: createChatToolDefectMemo(),
      safeDb: unusedSafeDb,
      scopedDb: unusedScopedDb,
      threadId,
      workspaceId: null,
      userId,
      toolWorkspaceIds: resolveToolWorkspaceIds({
        pinnedIds: [],
        accessibleWorkspaceIds: [workspaceId],
      }),
      hasActiveDocxEditClient: false,
      hasActiveDocxFileClient: false,
      docxSuggestionSurface: "template-studio",
      webSearchEnabled: false,
      webSearchProviders: { webSearchProvider: null, urlFetcher: null },
      activeSkillContext: editableActiveSkillContext,
      recordAuditEvent: noopAuditRecorder,
      resolveMemorySourceWorkspaceIds: () => [],
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
      toolDefectMemo: createChatToolDefectMemo(),
      safeDb: unusedSafeDb,
      scopedDb: unusedScopedDb,
      threadId,
      workspaceId: null,
      userId,
      toolWorkspaceIds: resolveToolWorkspaceIds({
        pinnedIds: [],
        accessibleWorkspaceIds: [workspaceId],
      }),
      hasActiveDocxEditClient: false,
      hasActiveDocxFileClient: false,
      docxSuggestionSurface: "template-studio",
      webSearchEnabled: false,
      webSearchProviders: { webSearchProvider: null, urlFetcher: null },
      activeSkillContext: {
        ...editableActiveSkillContext,
        body: "a".repeat(ACTIVE_SKILL_BODY_PROMPT_MAX_CHARS + 1),
      },
      recordAuditEvent: noopAuditRecorder,
      resolveMemorySourceWorkspaceIds: () => [],
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
      toolDefectMemo: createChatToolDefectMemo(),
      safeDb: unusedSafeDb,
      scopedDb: unusedScopedDb,
      threadId,
      workspaceId: null,
      userId,
      toolWorkspaceIds: resolveToolWorkspaceIds({
        pinnedIds: [],
        accessibleWorkspaceIds: [workspaceId],
      }),
      hasActiveDocxEditClient: false,
      hasActiveDocxFileClient: false,
      docxSuggestionSurface: "template-studio",
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
    expect(createDocument.description).toContain(
      "INLINE MARKDOWN: body text is GFM markdown",
    );
    expect(createDocument.description).toContain(
      "use @clause or @subclause for headings instead",
    );
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

  test("does not expose raw folder review in anonymized mode", () => {
    const tools = buildFullCoverageChatTools(
      asTestRaw<ChatThirdPartyBoundary>({ type: "anonymized" }),
    );

    expect(tools).not.toHaveProperty(REVIEW_FOLDER_CONSISTENCY_TOOL_NAME);
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

  test("the installed OpenAI adapter restores omitted optional tool inputs", async () => {
    const adapter = createOpenaiChat("gpt-5.2", "test-key");
    const argumentsJson =
      '{"question":"Which one?","options":null,"nullableNote":null}';
    Reflect.set(adapter, "client", {
      responses: {
        create: () =>
          (async function* () {
            yield {
              type: "response.created",
              response: {
                id: "response-1",
                model: "gpt-5.2",
                status: "in_progress",
              },
            };
            yield {
              type: "response.output_item.added",
              output_index: 0,
              item: {
                type: "function_call",
                id: "call-1",
                name: "ask_user",
              },
            };
            yield {
              type: "response.function_call_arguments.delta",
              item_id: "call-1",
              delta: argumentsJson,
            };
            yield {
              type: "response.function_call_arguments.done",
              item_id: "call-1",
              arguments: argumentsJson,
            };
            yield {
              type: "response.completed",
              response: {
                id: "response-1",
                model: "gpt-5.2",
                status: "completed",
                output: [
                  {
                    type: "function_call",
                    id: "call-1",
                    name: "ask_user",
                    arguments: argumentsJson,
                  },
                ],
                usage: {
                  input_tokens: 1,
                  output_tokens: 1,
                  total_tokens: 2,
                },
              },
            };
          })(),
      },
    });
    const chunks: StreamChunk[] = [];
    const tool = {
      name: "ask_user",
      description: "Ask a question.",
      inputSchema: {
        type: "object",
        properties: {
          question: { type: "string" },
          options: { type: "array", items: { type: "string" } },
          nullableNote: { type: ["string", "null"] },
        },
        required: ["question", "nullableNote"],
      },
    } satisfies Tool;

    for await (const chunk of adapter.chatStream({
      ...commonProviderOptions([tool]),
      model: adapter.model,
    })) {
      chunks.push(chunk);
    }

    expect(
      chunks.find((chunk) => chunk.type === EventType.TOOL_CALL_END),
    ).toHaveProperty("input", {
      question: "Which one?",
      nullableNote: null,
    });
  });

  test("the installed Mistral adapter restores omitted optional tool inputs", async () => {
    const adapter = createMistralText("mistral-large-latest", "test-key");
    const argumentsJson =
      '{"question":"Which one?","mode":null,"nullableNote":null,"emptyEnumMarker":null,"acceptAnything":null,"rejectAnything":null,"typeless":null}';
    let request: unknown;
    Reflect.set(adapter, "fetchRawMistralStream", (payload: unknown) => {
      request = payload;
      return (async function* () {
        yield {
          id: "response-1",
          model: "mistral-large-latest",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call-1",
                    type: "function",
                    function: {
                      name: "ask_user",
                      arguments: argumentsJson,
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        };
        yield {
          id: "response-1",
          model: "mistral-large-latest",
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "tool_calls",
            },
          ],
          usage: {
            prompt_tokens: 1,
            completion_tokens: 1,
            total_tokens: 2,
          },
        };
      })();
    });
    const chunks: StreamChunk[] = [];
    const projectedInputSchema = projectSchemaInputJsonSchema(
      toTanStackToolSchema(
        v.strictObject({
          question: v.string(),
          mode: v.optional(v.literal("must-not-be-sent")),
          nullableNote: v.nullable(v.string()),
        }),
      ),
      providerSafeJsonSchemaOptionsForTanStackProvider("mistral", "tool"),
    );
    const inputSchema = convertSchemaToJsonSchema(projectedInputSchema);
    if (!inputSchema?.properties) {
      throw new TypeError(
        "Expected projected Mistral input schema properties.",
      );
    }
    // Boolean schemas are valid JSON Schema even though TanStack's public
    // JSONSchema type currently models only object schemas.
    Reflect.set(inputSchema.properties, "acceptAnything", true);
    Reflect.set(inputSchema.properties, "rejectAnything", false);
    Reflect.set(inputSchema.properties, "emptyEnumMarker", {
      type: "string",
      enum: [],
    });
    Reflect.set(inputSchema.properties, "typeless", {
      description: "An optional typeless value.",
    });
    const tool = {
      name: "ask_user",
      description: "Ask a question.",
      inputSchema,
    } satisfies Tool;

    for await (const chunk of adapter.chatStream({
      ...commonProviderOptions([tool]),
      model: adapter.model,
    })) {
      chunks.push(chunk);
    }

    expect(request).toMatchObject({
      tools: [
        {
          function: {
            parameters: {
              properties: {
                mode: {
                  type: ["string", "null"],
                  enum: ["must-not-be-sent", null],
                },
                emptyEnumMarker: {
                  type: ["string", "null"],
                  enum: [null],
                },
                acceptAnything: true,
                rejectAnything: {
                  anyOf: [false, { type: "null" }],
                },
                typeless: {
                  description: "An optional typeless value.",
                },
              },
              required: expect.arrayContaining([
                "question",
                "mode",
                "nullableNote",
                "emptyEnumMarker",
                "acceptAnything",
                "rejectAnything",
                "typeless",
              ]),
            },
          },
        },
      ],
    });
    expect(
      chunks.find((chunk) => chunk.type === EventType.TOOL_CALL_END),
    ).toHaveProperty("input", {
      question: "Which one?",
      nullableNote: null,
      acceptAnything: null,
      typeless: null,
    });
  });

  test("the installed Mistral adapter preserves composed schemas under non-strict fallback", async () => {
    const adapter = createMistralText("mistral-large-latest", "test-key");
    let request: unknown;
    Reflect.set(adapter, "fetchRawMistralStream", (payload: unknown) => {
      request = payload;
      return emptyProviderStream();
    });
    const inputSchema = {
      type: "object",
      properties: {
        value: {
          oneOf: [{ type: "string" }, { type: "number" }],
        },
      },
      required: [],
    };

    await consumeProviderStream(
      adapter.chatStream({
        ...commonProviderOptions([
          {
            name: "store_value",
            description: "Store a value.",
            inputSchema,
          },
        ]),
        model: adapter.model,
      }),
    );

    expect(request).toMatchObject({
      tools: [
        {
          function: {
            parameters: inputSchema,
            strict: false,
          },
        },
      ],
    });
  });

  test("the installed OpenRouter adapter projects a complete tool-call round trip", async () => {
    const adapter = createOpenRouterText("openai/gpt-5.2", "test-key");
    const requests: unknown[] = [];
    let invocationCount = 0;
    Reflect.set(adapter, "orClient", {
      chat: {
        send: (request: unknown) => {
          requests.push(request);
          invocationCount += 1;
          if (invocationCount === 1) {
            return (async function* () {
              yield {
                id: "completion-1",
                model: adapter.model,
                choices: [
                  {
                    delta: {
                      toolCalls: [
                        {
                          index: 0,
                          id: "call-round-trip",
                          type: "function",
                          function: {
                            name: "round_trip",
                            arguments: '{"value":"stella"}',
                          },
                        },
                      ],
                    },
                    finishReason: null,
                  },
                ],
              };
              yield {
                id: "completion-1",
                model: adapter.model,
                choices: [{ delta: {}, finishReason: "tool_calls" }],
                usage: {
                  promptTokens: 5,
                  completionTokens: 3,
                  totalTokens: 8,
                },
              };
            })();
          }

          return (async function* () {
            yield {
              id: "completion-2",
              model: adapter.model,
              choices: [
                {
                  delta: { content: "round-trip-complete" },
                  finishReason: null,
                },
              ],
            };
            yield {
              id: "completion-2",
              model: adapter.model,
              choices: [{ delta: {}, finishReason: "stop" }],
              usage: {
                promptTokens: 8,
                completionTokens: 2,
                totalTokens: 10,
              },
            };
          })();
        },
      },
    });
    const executedValues: string[] = [];
    const roundTripTool = toolDefinition({
      name: "round_trip",
      description: "Return a confirmation value.",
      inputSchema: toTanStackToolSchema(v.strictObject({ value: v.string() })),
    }).server(({ value }) => {
      executedValues.push(value);
      return { confirmation: "round-trip-complete" };
    });
    const modelOptions = {
      maxCompletionTokens: 64,
    };
    Reflect.set(modelOptions, "serviceTier", "flex");
    const chunks: StreamChunk[] = [];

    for await (const chunk of adapter.chatStream({
      logger: resolveDebugOption(false),
      messages: [{ role: "user", content: "Run the round-trip tool." }],
      model: adapter.model,
      modelOptions,
      tools: [roundTripTool],
    })) {
      chunks.push(chunk);
    }

    expect(
      chunks.find((chunk) => chunk.type === EventType.TOOL_CALL_END),
    ).toMatchObject({
      toolCallId: "call-round-trip",
      toolCallName: "round_trip",
      input: { value: "stella" },
    });
    const toolResult = await roundTripTool.execute?.(
      { value: "stella" },
      { emitCustomEvent: () => undefined },
    );
    if (toolResult === undefined) {
      throw new TypeError("Expected the round-trip tool to return a result.");
    }

    for await (const chunk of adapter.chatStream({
      logger: resolveDebugOption(false),
      messages: [
        { role: "user", content: "Run the round-trip tool." },
        {
          role: "assistant",
          content: null,
          toolCalls: [
            {
              id: "call-round-trip",
              type: "function",
              function: {
                name: "round_trip",
                arguments: '{"value":"stella"}',
              },
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "call-round-trip",
          content: JSON.stringify(toolResult),
        },
      ],
      model: adapter.model,
      modelOptions,
      tools: [roundTripTool],
    })) {
      chunks.push(chunk);
    }

    expect(executedValues).toEqual(["stella"]);
    expect(requests).toHaveLength(2);
    expect(
      chunks.filter((chunk) => chunk.type === EventType.TEXT_MESSAGE_CONTENT),
    ).toEqual([
      expect.objectContaining({
        delta: "round-trip-complete",
        content: "round-trip-complete",
      }),
    ]);

    const secondRequest = requireRecord(requests.at(1), "second SDK request");
    const chatRequest = requireRecord(
      secondRequest["chatRequest"],
      "second OpenRouter chat request",
    );
    expect(chatRequest).toMatchObject({
      maxCompletionTokens: 64,
      serviceTier: "flex",
    });
    expect(chatRequest["messages"]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: null,
          toolCalls: [
            expect.objectContaining({
              id: "call-round-trip",
              function: {
                name: "round_trip",
                arguments: '{"value":"stella"}',
              },
            }),
          ],
        }),
        expect.objectContaining({
          role: "tool",
          toolCallId: "call-round-trip",
          content: '{"confirmation":"round-trip-complete"}',
        }),
      ]),
    );
  });

  test("Anthropic rejects a custom tool that collides with its native web-search tool", () => {
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

    expect(() =>
      convertAnthropicTools([ordinaryWebSearch, nativeWebSearch]),
    ).toThrow(DuplicateToolNameError);
    expect(() =>
      convertAnthropicTools([ordinaryWebSearch, nativeWebSearch]),
    ).toThrow(
      'Cannot pass two tools named "web_search" in the same chat() call.',
    );
  });

  // OpenAI rejects the entire request (400) when any tool is sent with
  // `strict: true` but a schema outside the strict Structured Outputs subset.
  // This test runs the real adapter conversion over every registered chat tool
  // offline, so a schema that would 400 in production fails here first, even
  // under USE_MOCK_AI. It also fails if an upstream adapter change regresses
  // the non-strict fallback after a version bump.
  test("OpenAI falls back from strict mode when an anyOf variant needs null widening", () => {
    const inputSchema = {
      type: "object",
      properties: {
        value: {
          anyOf: [
            {
              type: "object",
              properties: {
                kind: { const: "optional" },
                note: { type: "string" },
              },
              required: ["kind"],
            },
            {
              type: "object",
              properties: {
                kind: { const: "nullable" },
                note: { type: ["string", "null"] },
              },
              required: ["kind", "note"],
            },
          ],
        },
      },
      required: ["value"],
    };

    const converted = convertFunctionToolToAdapterFormat({
      name: "store_variant",
      description: "Store a union variant.",
      inputSchema,
    });

    expect(converted.strict).toBe(false);
    expect(converted.parameters).toEqual(inputSchema);
  });

  test("every strict registered chat tool has OpenAI-legal parameters", () => {
    const tools = buildFullCoverageChatTools();

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
        continue;
      }
      collectStrictViolations(converted.parameters, "root", name);
    }

    expect(violations).toEqual([]);
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

  // Regression coverage for the security finding: this tool calls
  // `createEntityFromBuffer` directly (bypassing the MCP `save_document` /
  // REST `create-from-legal-source` dispatch), so it must mirror those
  // paths' own `entity: ["create"]` permission check and active-matter
  // status gate rather than relying on `toolWorkspaceIds` alone (which
  // includes archived matters).
  describe("create_matter_document authorization", () => {
    const baseArgs = {
      orgAIConfig: null,
      organizationId,
      requestWorkspaceId: workspaceId,
      thirdPartyBoundary: { type: "raw" },
      refRegistry: createChatRefRegistry(),
      toolDefectMemo: createChatToolDefectMemo(),
      safeDb: unusedSafeDb,
      scopedDb: unusedScopedDb,
      threadId,
      userId,
      webSearchEnabled: false,
      webSearchProviders: { webSearchProvider: null, urlFetcher: null },
      hasActiveDocxEditClient: false,
      hasActiveDocxFileClient: false,
      docxSuggestionSurface: "template-studio",
      recordAuditEvent: noopAuditRecorder,
      workspaceId: null,
      toolWorkspaceIds: resolveToolWorkspaceIds({
        pinnedIds: [],
        accessibleWorkspaceIds: [workspaceId],
      }),
    } as const;

    test("registers create_matter_document for a role with entity:create in an active matter", () => {
      const tools = getChatTools({
        ...baseArgs,
        memberRole: "owner",
        workspaceStatusById: new Map([[workspaceId, "active"]]),
      });
      expect(tools).toHaveProperty(CREATE_MATTER_DOCUMENT_TOOL_NAME);
    });

    // `intern` has `chat: ["create", "update", "delete"]` but `entity: []` —
    // chat-capable, but not entitled to create documents. Without the
    // permission gate this role could create workspace documents through
    // chat alone, bypassing `entity:create`.
    test("does not register create_matter_document for a role without entity:create", () => {
      const tools = getChatTools({
        ...baseArgs,
        memberRole: "intern",
        workspaceStatusById: new Map([[workspaceId, "active"]]),
      });
      expect(tools).not.toHaveProperty(CREATE_MATTER_DOCUMENT_TOOL_NAME);
    });

    // `toolWorkspaceIds` includes archived matters (only "deleting" is
    // filtered out upstream), so the id-set check alone would let an
    // archived matter stay writable through this tool.
    test("does not register create_matter_document for an archived matter", () => {
      const tools = getChatTools({
        ...baseArgs,
        memberRole: "owner",
        workspaceStatusById: new Map([[workspaceId, "archived"]]),
      });
      expect(tools).not.toHaveProperty(CREATE_MATTER_DOCUMENT_TOOL_NAME);
    });

    test("does not register create_matter_document when no workspace status is known", () => {
      const tools = getChatTools({
        ...baseArgs,
        memberRole: "owner",
      });
      expect(tools).not.toHaveProperty(CREATE_MATTER_DOCUMENT_TOOL_NAME);
    });
  });

  // Regression coverage mirroring `create_matter_document authorization`
  // above: in `auto` mode `suggest_changes` is server-executed and writes a
  // new entity version directly (no client review panel in the loop), so it
  // must mirror the same class of explicit authorization mirror -- here
  // `entity: ["update"]` (an edit to an EXISTING document) rather than
  // `entity: ["create"]` -- plus the active-matter status gate, PLUS a
  // review-mode gate (`editApplyMode === "auto"`) that has no analogue on
  // the create tool: the apply variant and the manual, client-executed
  // queue variant are mutually exclusive review-mode surfaces, never both
  // registered for the same turn.
  //
  // Both variants carry the SAME tool name, so presence alone proves
  // nothing. They are told apart by their registration shape: the apply
  // variant is server-executed and approval-gated (`execute` defined,
  // `needsApproval === true`, policy kind "mutation"); the queue variant is
  // client-executed with no chat-level approval (no `execute`, no
  // `needsApproval`, policy kind "internal").
  describe("suggest_changes automatic apply registration", () => {
    const activeFile = {
      entityId: toSafeId<"entity">("77777777-7777-4777-8777-777777777777"),
      currentVersionId: toSafeId<"entityVersion">(
        "99999999-9999-4999-8999-999999999998",
      ),
      fileFieldId: toSafeId<"field">("88888888-8888-4888-8888-888888888888"),
      supportsDocxEdits: true,
    } as const;

    const baseArgs = {
      orgAIConfig: null,
      organizationId,
      requestWorkspaceId: workspaceId,
      thirdPartyBoundary: { type: "raw" },
      refRegistry: createChatRefRegistry(),
      toolDefectMemo: createChatToolDefectMemo(),
      safeDb: unusedSafeDb,
      scopedDb: unusedScopedDb,
      threadId,
      userId,
      webSearchEnabled: false,
      webSearchProviders: { webSearchProvider: null, urlFetcher: null },
      hasActiveDocxEditClient: false,
      hasActiveDocxFileClient: false,
      docxSuggestionSurface: "template-studio",
      recordAuditEvent: noopAuditRecorder,
      activeFile,
      workspaceId: null,
      toolWorkspaceIds: resolveToolWorkspaceIds({
        pinnedIds: [],
        accessibleWorkspaceIds: [workspaceId],
      }),
    } as const;

    const expectApplyVariant = (tools: ReturnType<typeof getChatTools>) => {
      const tool = tools[SUGGEST_CHANGES_TOOL_NAME];
      if (!tool) {
        throw new Error("Expected the apply variant to be registered");
      }
      expect(tool.execute).toBeDefined();
      expect(tool.needsApproval).toBe(true);
      expect(getChatToolPolicy(tool).kind).toBe("mutation");
    };

    const expectQueueVariant = (tools: ReturnType<typeof getChatTools>) => {
      const tool = tools[SUGGEST_CHANGES_TOOL_NAME];
      if (!tool) {
        throw new Error("Expected the queue variant to be registered");
      }
      expect(tool.execute).toBeUndefined();
      expect(tool.needsApproval).toBeUndefined();
      expect(getChatToolPolicy(tool).kind).toBe("internal");
    };

    test("registers the apply variant for an updater on an active matter with an editable active file", () => {
      expectApplyVariant(
        getChatTools({
          ...baseArgs,
          memberRole: "owner",
          editApplyMode: "auto",
          workspaceStatusById: new Map([[workspaceId, "active"]]),
        }),
      );
    });

    // `intern` has `chat: [...]` but `entity: []` -- chat-capable, but not
    // entitled to edit documents. Without this gate, the tool would let an
    // entity-update-less role overwrite documents through chat alone.
    test("does not register suggest_changes for a role without entity:update", () => {
      const tools = getChatTools({
        ...baseArgs,
        memberRole: "intern",
        editApplyMode: "auto",
        workspaceStatusById: new Map([[workspaceId, "active"]]),
      });
      expect(tools).not.toHaveProperty(SUGGEST_CHANGES_TOOL_NAME);
    });

    test("does not register suggest_changes for an archived matter", () => {
      const tools = getChatTools({
        ...baseArgs,
        memberRole: "owner",
        editApplyMode: "auto",
        workspaceStatusById: new Map([[workspaceId, "archived"]]),
      });
      expect(tools).not.toHaveProperty(SUGGEST_CHANGES_TOOL_NAME);
    });

    // Fail-closed: an unknown workspace status must NOT default to "active".
    test("does not register suggest_changes when no workspace status is known", () => {
      const tools = getChatTools({
        ...baseArgs,
        memberRole: "owner",
        editApplyMode: "auto",
      });
      expect(tools).not.toHaveProperty(SUGGEST_CHANGES_TOOL_NAME);
    });

    test("does not register suggest_changes without an editable active DOCX file", () => {
      const tools = getChatTools({
        ...baseArgs,
        activeFile: { entityId: activeFile.entityId },
        memberRole: "owner",
        editApplyMode: "auto",
        workspaceStatusById: new Map([[workspaceId, "active"]]),
      });
      expect(tools).not.toHaveProperty(SUGGEST_CHANGES_TOOL_NAME);
    });

    test("does not register suggest_changes without the exact active file field", () => {
      const tools = getChatTools({
        ...baseArgs,
        activeFile: {
          entityId: activeFile.entityId,
          supportsDocxEdits: true,
        },
        memberRole: "owner",
        editApplyMode: "auto",
        workspaceStatusById: new Map([[workspaceId, "active"]]),
      });
      expect(tools).not.toHaveProperty(SUGGEST_CHANGES_TOOL_NAME);
    });

    // The two review modes are mutually exclusive tool surfaces: the model
    // is never handed both the headless writer and the client-executed
    // queue-for-review registration on the same turn.
    describe("mutual exclusion between the apply and queue variants", () => {
      const mutualExclusionArgs = {
        ...baseArgs,
        memberRole: "owner" as const,
        hasActiveDocxEditClient: true,
        workspaceStatusById: new Map([[workspaceId, "active" as const]]),
      };

      test("auto mode registers the apply variant", () => {
        expectApplyVariant(
          getChatTools({ ...mutualExclusionArgs, editApplyMode: "auto" }),
        );
      });

      test("manual mode registers the queue variant", () => {
        expectQueueVariant(
          getChatTools({ ...mutualExclusionArgs, editApplyMode: "manual" }),
        );
      });

      // DEFAULT_CHAT_EDIT_APPLY_MODE is "auto": AI edits auto-apply as
      // tracked changes by default, writing a new version directly; the
      // user switches to manual (queued) review via the mode selector.
      test("defaults to auto when editApplyMode is omitted", () => {
        expectApplyVariant(getChatTools(mutualExclusionArgs));
      });

      // Validation widening replays a persisted call whose mode may have
      // changed since. The queue variant's raw JSON Schema input and absent
      // output schema admit a persisted call of either variant, so with a
      // live edit client it is the one registered in BOTH modes.
      test("validation registers the queue variant in both modes while an edit client is live", () => {
        for (const editApplyMode of ["auto", "manual"] as const) {
          expectQueueVariant(
            getChatTools({
              ...mutualExclusionArgs,
              editApplyMode,
              includeAllDocxEditToolsForValidation: true,
            }),
          );
        }
      });

      // Without a live edit client there is no queue variant to widen to,
      // so auto mode keeps the apply variant it would register anyway.
      test("validation keeps the apply variant when no edit client is live", () => {
        expectApplyVariant(
          getChatTools({
            ...mutualExclusionArgs,
            hasActiveDocxEditClient: false,
            editApplyMode: "auto",
            includeAllDocxEditToolsForValidation: true,
          }),
        );
      });
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
      toolDefectMemo: createChatToolDefectMemo(),
      safeDb: unusedSafeDb,
      scopedDb: unusedScopedDb,
      threadId,
      workspaceId: null,
      userId,
      toolWorkspaceIds: resolveToolWorkspaceIds({
        pinnedIds: [],
        accessibleWorkspaceIds: [workspaceId],
      }),
      hasActiveDocxEditClient: false,
      hasActiveDocxFileClient: false,
      docxSuggestionSurface: "template-studio",
      webSearchEnabled: false,
      webSearchProviders: { webSearchProvider: null, urlFetcher: null },
      recordAuditEvent: noopAuditRecorder,
      resolveMemorySourceWorkspaceIds: () => [],
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

  test("save_template exposes its executable inline and configure modes, not host files", () => {
    const tool = buildToolsWithWorkspace()["save_template"];
    if (!tool?.inputSchema) {
      throw new Error("Expected save_template to be registered");
    }
    const schema = requireRecord(
      convertSchemaToJsonSchema(tool.inputSchema),
      "save_template input schema",
    );
    const properties = requireRecord(
      schema["properties"],
      "save_template input properties",
    );

    expect(properties["file"]).toBeUndefined();
    expect(properties["docx_base64"]).toBeDefined();
    expect(properties["template_id"]).toBeDefined();
    expect(tool.description).toContain("docx_base64");
    expect(tool.description).toContain("template_id");
    expect(tool.description).toContain(TEMPLATE_MARKER_REFERENCE_URI);
    expect(tool.description).toContain(TEMPLATE_FIELD_REFERENCE_URI);
    expect(tool.description).not.toContain("host file");
  });

  test("no write tools are registered when the workspace set is empty", () => {
    const tools = getChatTools({
      orgAIConfig: null,
      memberRole: "owner",
      organizationId,
      requestWorkspaceId: workspaceId,
      thirdPartyBoundary: { type: "raw" },
      refRegistry: createChatRefRegistry(),
      toolDefectMemo: createChatToolDefectMemo(),
      safeDb: unusedSafeDb,
      scopedDb: unusedScopedDb,
      threadId,
      workspaceId: null,
      userId,
      toolWorkspaceIds: resolveToolWorkspaceIds({
        pinnedIds: [],
        accessibleWorkspaceIds: [],
      }),
      hasActiveDocxEditClient: false,
      hasActiveDocxFileClient: false,
      docxSuggestionSurface: "template-studio",
      webSearchEnabled: false,
      webSearchProviders: { webSearchProvider: null, urlFetcher: null },
      recordAuditEvent: noopAuditRecorder,
      resolveMemorySourceWorkspaceIds: () => [],
    });

    for (const name of projectedWriteNames) {
      expect(tools, name).not.toHaveProperty(name);
    }
  });
});
