import {
  convertSchemaToJsonSchema,
  parseWithStandardSchema,
  toolDefinition,
} from "@tanstack/ai";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import type { SafeDb, ScopedDb } from "@/api/db";
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
    // Construct args so every conditional tool group registers: owner role
    // (template use + create), active docx edit client, web search enabled with
    // a resolved provider, and an editable active skill context. BOE, infosoud,
    // and business-registry tools register by default (no disabled slugs).
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
    const isSchemaObject = (value: unknown): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value);

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
