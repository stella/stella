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
import { resolveToolWorkspaceIds } from "@/api/handlers/chat/tools/authorized-workspace-ids";
import {
  EXPAND_CHAT_HISTORY_TOOL_NAME,
  SEARCH_CHAT_HISTORY_TOOL_NAME,
} from "@/api/handlers/chat/tools/chat-history-tools";
import { getChatTools } from "@/api/handlers/chat/tools/chat-tools";
import { createChatRefRegistry } from "@/api/handlers/chat/tools/execute/ref-registry";
import { getChatToolPolicy } from "@/api/handlers/chat/tools/tool-policy";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import { PROVIDER_SAFE_JSON_SCHEMA_KEYWORDS } from "@/api/lib/provider-safe-json-schema";
import type { UrlFetcher, WebSearchProvider } from "@/api/lib/web-search/types";

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
            description: "Analyze legal texts.",
            name: "legal-interpretation",
            version: "3.0",
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
      webSearchEnabled: false,
      webSearchProviders: { webSearchProvider: null, urlFetcher: null },
    });

    expect(tools).toHaveProperty("ask-user");
    expect(tools).not.toHaveProperty("create-current-skill-resource");
    expect(tools).not.toHaveProperty("update-current-skill-body");
    expect(tools).not.toHaveProperty("update-current-skill-resource");
    expect(tools).toHaveProperty(SEARCH_CHAT_HISTORY_TOOL_NAME);
    expect(tools).toHaveProperty(EXPAND_CHAT_HISTORY_TOOL_NAME);
    expect(tools).toHaveProperty("run-stella-query");
    expect(tools).toHaveProperty("create-document");
    expect(tools).toHaveProperty("update-entity-fields");
    expect(tools).not.toHaveProperty("search-across-matters");
    expect(tools).not.toHaveProperty("read-content-across-matters");
    expect(tools).not.toHaveProperty("read-contact");
  });

  test("only exposes current skill edit tools for editable active skill chats", () => {
    const tools = getChatTools({
      orgAIConfig: null,
      memberRole: "owner",
      organizationId,
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
      webSearchEnabled: false,
      webSearchProviders: { webSearchProvider: null, urlFetcher: null },
    });

    const businessRegistryLookup = tools["business_registry_lookup"];
    const updateEntityFields = tools["update-entity-fields"];
    const createDocument = tools["create-document"];
    const runStellaQuery = tools["run-stella-query"];
    const searchChatHistory = tools[SEARCH_CHAT_HISTORY_TOOL_NAME];

    expect(businessRegistryLookup).toBeDefined();
    expect(updateEntityFields).toBeDefined();
    expect(createDocument).toBeDefined();
    expect(runStellaQuery).toBeDefined();
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
    expect(runStellaQuery?.needsApproval).toBeUndefined();
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
