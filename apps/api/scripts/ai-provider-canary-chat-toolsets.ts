import { toolDefinition } from "@tanstack/ai";
import type { AnyClientTool } from "@tanstack/ai";
import { panic } from "better-result";

import {
  BROWSER_CONTROL_PROTOCOL_VERSION,
  BUSINESS_REGISTRY_SLUGS,
  BUILT_IN_CHAT_TOOL_POLICY_KINDS,
  CHAT_EDIT_APPLY_MODE,
} from "@stll/api-contract";
import type { ChatEditApplyMode } from "@stll/api-contract";
import {
  DOCX_SUGGESTION_SURFACE,
  type DocxSuggestionSurface,
} from "@stll/api-contract/chat-docx-suggestions";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { resolveToolWorkspaceIds } from "@/api/handlers/chat/tools/authorized-workspace-ids";
import { getChatTools } from "@/api/handlers/chat/tools/chat-tools";
import { PAST_CHAT_SCOPE_TYPE } from "@/api/handlers/chat/tools/past-chat-tools";
import type { ActiveChatSkillContext } from "@/api/lib/agent-skills/skills";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import { BUSINESS_REGISTRY_DISPATCH } from "@/api/lib/business-registries/dispatch";
import { chatToolMapToArray } from "@/api/lib/chat/chat-tool-types";
import { projectChatToolSchemasForProvider } from "@/api/lib/chat/provider-tool-projection";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
import { createChatToolDefectMemo } from "@/api/lib/chat/tool-defect-memo";
import type { UrlFetcher, WebSearchProvider } from "@/api/lib/web-search/types";

import type { CanaryProvider } from "./ai-provider-canary-config";

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
const currentVersionId = toSafeId<"entityVersion">(
  "77777777-7777-4777-8777-777777777777",
);
const fileFieldId = toSafeId<"field">("88888888-8888-4888-8888-888888888888");

const inertScopedDb: ScopedDb = async () =>
  await Promise.reject(
    new TypeError("The provider canary must not execute database tools."),
  );

const inertSafeDb: SafeDb = async () =>
  await Promise.reject(
    new TypeError("The provider canary must not execute database tools."),
  );

const inertAuditRecorder: AuditRecorder = async () => await Promise.resolve();

const inertWebSearchProvider: WebSearchProvider = {
  name: "tavily",
  search: async () =>
    await Promise.reject(
      new TypeError("The provider canary must not execute web search."),
    ),
};

const inertUrlFetcher: UrlFetcher = {
  name: "jina",
  fetch: async () =>
    await Promise.reject(
      new TypeError("The provider canary must not fetch URLs."),
    ),
};

const activeSkillContext: ActiveChatSkillContext = {
  body: "# Synthetic canary skill\nDo not execute tools.",
  description: "Synthetic provider schema canary.",
  displayName: "Provider Schema Canary",
  editable: true,
  id: skillId,
  origin: "authored",
  resources: [{ kind: "knowledge", path: "knowledge/canary.md" }],
  toolName: "provider-schema-canary",
  version: null,
};

const canaryRegistryDispatch = { ...BUSINESS_REGISTRY_DISPATCH };
for (const slug of BUSINESS_REGISTRY_SLUGS) {
  canaryRegistryDispatch[slug] = {
    ...BUSINESS_REGISTRY_DISPATCH[slug],
    isDeployAvailable: () => true,
  };
}

const TOOLSET_DISPOSITION = {
  [CHAT_EDIT_APPLY_MODE.manual]: {
    [DOCX_SUGGESTION_SURFACE.fileOverlay]: "probe",
    [DOCX_SUGGESTION_SURFACE.templateStudio]: "probe",
  },
  [CHAT_EDIT_APPLY_MODE.auto]: {
    [DOCX_SUGGESTION_SURFACE.fileOverlay]: "probe",
    // Template Studio has no entity-backed active file. Its send path pins
    // manual mode, so this pair cannot be assembled by production.
    [DOCX_SUGGESTION_SURFACE.templateStudio]: "unavailable",
  },
} as const satisfies Record<
  ChatEditApplyMode,
  Record<DocxSuggestionSurface, "probe" | "unavailable">
>;

type ChatToolsetScenario = {
  editApplyMode: ChatEditApplyMode;
  id: `${ChatEditApplyMode}:${DocxSuggestionSurface}`;
  surface: DocxSuggestionSurface;
};

export const chatToolsetScenarios = (): ChatToolsetScenario[] => {
  const scenarios: ChatToolsetScenario[] = [];
  for (const editApplyMode of Object.values(CHAT_EDIT_APPLY_MODE)) {
    for (const surface of Object.values(DOCX_SUGGESTION_SURFACE)) {
      if (TOOLSET_DISPOSITION[editApplyMode][surface] === "unavailable") {
        continue;
      }
      scenarios.push({
        editApplyMode,
        id: `${editApplyMode}:${surface}`,
        surface,
      });
    }
  }
  return scenarios;
};

const buildChatToolsForScenario = ({
  orgAIConfig,
  scenario: { editApplyMode, surface },
}: {
  orgAIConfig: OrgAIConfig;
  scenario: ChatToolsetScenario;
}) => {
  const hasActiveDocxFileClient =
    surface === DOCX_SUGGESTION_SURFACE.fileOverlay;
  const activeFile =
    hasActiveDocxFileClient || editApplyMode === CHAT_EDIT_APPLY_MODE.auto
      ? {
          entityId,
          currentVersionId,
          fileFieldId,
          supportsDocxEdits: true,
        }
      : undefined;

  return getChatTools({
    activeFile,
    activeSkillContext,
    // A live extension registers the client-executed browser tool, so its
    // schema also runs through the provider matrix.
    browserClient: { protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION },
    docxSuggestionSurface: surface,
    editApplyMode,
    hasActiveDocxEditClient: true,
    hasActiveDocxFileClient,
    memberRole: "owner",
    memoryEnabled: true,
    organizationId,
    orgAIConfig,
    // A matters scope registers both past-chat tools, so the approval-gated
    // wider search also runs through the provider matrix.
    pastChatScope: {
      type: PAST_CHAT_SCOPE_TYPE.matters,
      workspaceIds: [workspaceId],
    },
    pinServerValidatedWorkspaceId: () => true,
    recordAuditEvent: inertAuditRecorder,
    refRegistry: createChatRefRegistry(),
    registryDispatch: canaryRegistryDispatch,
    requestWorkspaceId: workspaceId,
    resolveMemorySourceWorkspaceIds: () => [workspaceId],
    safeDb: inertSafeDb,
    scopedDb: inertScopedDb,
    skillMetadata: [
      {
        description: activeSkillContext.description,
        name: activeSkillContext.toolName,
        version: activeSkillContext.version,
      },
    ],
    thirdPartyBoundary: { type: "raw" },
    threadId,
    toolDefectMemo: createChatToolDefectMemo(),
    toolWorkspaceIds: resolveToolWorkspaceIds({
      accessibleWorkspaceIds: [workspaceId],
      pinnedIds: [],
    }),
    userId,
    webSearchEnabled: true,
    webSearchProviders: {
      urlFetcher: inertUrlFetcher,
      webSearchProvider: inertWebSearchProvider,
    },
    workspaceId,
    workspaceStatusById: new Map([[workspaceId, "active"]]),
  });
};

type ChatToolset = {
  id: ChatToolsetScenario["id"];
  tools: ReturnType<typeof chatToolMapToArray>;
};

export const buildCanaryChatToolsets = (
  orgAIConfig: OrgAIConfig,
): ChatToolset[] => {
  const toolsets = chatToolsetScenarios().map((scenario) => ({
    id: scenario.id,
    tools: chatToolMapToArray(
      buildChatToolsForScenario({ orgAIConfig, scenario }),
    ),
  }));
  const registeredNames = new Set(
    toolsets.flatMap(({ tools }) => tools.map(({ name }) => name)),
  );
  const catalogNames = Object.keys(BUILT_IN_CHAT_TOOL_POLICY_KINDS);
  const missing = catalogNames.filter((name) => !registeredNames.has(name));
  const uncatalogued = [...registeredNames].filter(
    (name) => !Object.hasOwn(BUILT_IN_CHAT_TOOL_POLICY_KINDS, name),
  );
  if (missing.length > 0 || uncatalogued.length > 0) {
    return panic(
      `Canary chat toolset census drifted (missing: ${missing.join(", ") || "none"}; uncatalogued: ${uncatalogued.join(", ") || "none"}).`,
    );
  }
  return toolsets;
};

export const projectCanaryChatToolset = ({
  provider,
  toolset,
}: {
  provider: CanaryProvider;
  toolset: ChatToolset;
}): AnyClientTool[] =>
  projectChatToolSchemasForProvider({
    modelTools: toolset.tools,
    provider,
  }).map((tool) =>
    toolDefinition({
      description: tool.description,
      inputSchema: tool.inputSchema,
      name: tool.name,
      outputSchema: tool.outputSchema,
    }).client(),
  );
