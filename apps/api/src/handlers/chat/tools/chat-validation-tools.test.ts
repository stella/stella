import { describe, expect, test } from "bun:test";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import type { ChatThirdPartyBoundary } from "@/api/handlers/chat/third-party-boundary";
import { resolveToolWorkspaceIds } from "@/api/handlers/chat/tools/authorized-workspace-ids";
import { createBoeTools } from "@/api/handlers/chat/tools/boe-tools";
import {
  getChatTools,
  getChatValidationTools,
} from "@/api/handlers/chat/tools/chat-tools";
import { REVIEW_FOLDER_CONSISTENCY_TOOL_NAME } from "@/api/handlers/chat/tools/folder-consistency-review-tool";
import {
  READ_DOCUMENT_TOOL_NAME,
  SUGGEST_CHANGES_TOOL_NAME,
} from "@/api/handlers/chat/tools/folio-agent-tools";
import { createInfosoudTools } from "@/api/handlers/chat/tools/infosoud-tools";
import {
  PAST_CHAT_SCOPE_TYPE,
  SEARCH_ALL_PAST_CHATS_TOOL_NAME,
} from "@/api/handlers/chat/tools/past-chat-tools";
import type { PastChatScope } from "@/api/handlers/chat/tools/past-chat-tools";
import { REMEMBER_TOOL_NAME } from "@/api/handlers/chat/tools/remember-tool";
import { SPAWN_SUBAGENTS_TOOL_NAME } from "@/api/handlers/chat/tools/subagent-tool-shared";
import {
  FETCH_URL_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
} from "@/api/handlers/chat/tools/web-search-tools";
import type { ActiveChatSkillContext } from "@/api/lib/agent-skills/skills";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import { BUSINESS_REGISTRY_DISPATCH } from "@/api/lib/business-registries/dispatch";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
import { createChatToolDefectMemo } from "@/api/lib/chat/tool-defect-memo";
import type { UrlFetcher, WebSearchProvider } from "@/api/lib/web-search/types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

type RunToolsProps = Parameters<typeof getChatTools>[0];

const organizationId = toSafeId<"organization">(
  "11111111-1111-4111-8111-111111111111",
);
const userId = toSafeId<"user">("22222222-2222-4222-8222-222222222222");
const workspaceId = toSafeId<"workspace">(
  "33333333-3333-4333-8333-333333333333",
);
const threadId = toSafeId<"chatThread">("55555555-5555-4555-8555-555555555555");

const unusedScopedDb: ScopedDb = async () => {
  throw new Error("This test only constructs tool sets.");
};
const unusedSafeDb: SafeDb = async () => {
  throw new Error("This test only constructs tool sets.");
};
const noopAuditRecorder: AuditRecorder = async () => undefined;

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

const editableActiveSkillContext: ActiveChatSkillContext = {
  body: "# Instructions\nUse the checklist.",
  description: "Review closing files.",
  displayName: "Closing Review",
  editable: true,
  id: toSafeId<"agentSkill">("66666666-6666-4666-8666-666666666666"),
  origin: "authored",
  resources: [{ kind: "knowledge", path: "knowledge/checklist.md" }],
  toolName: "closing-review",
  version: null,
};

const activeDocxFile = {
  entityId: toSafeId<"entity">("77777777-7777-4777-8777-777777777777"),
  currentVersionId: toSafeId<"entityVersion">(
    "99999999-9999-4999-8999-999999999998",
  ),
  fileFieldId: toSafeId<"field">("88888888-8888-4888-8888-888888888888"),
  supportsDocxEdits: true,
} as const;

const SKILL_CATALOGS = {
  empty: [],
  installed: [
    {
      description: "Installed workflow.",
      name: "installed-workflow",
      version: "1.0",
    },
  ],
} as const;

const DOCX_SURFACES = {
  none: {
    docxSuggestionSurface: "file-overlay",
    hasActiveDocxEditClient: false,
    hasActiveDocxFileClient: false,
  },
  fileOverlay: {
    docxSuggestionSurface: "file-overlay",
    hasActiveDocxEditClient: true,
    hasActiveDocxFileClient: true,
  },
  templateStudio: {
    docxSuggestionSurface: "template-studio",
    hasActiveDocxEditClient: true,
    hasActiveDocxFileClient: false,
  },
} as const satisfies Record<
  string,
  Pick<
    RunToolsProps,
    | "docxSuggestionSurface"
    | "hasActiveDocxEditClient"
    | "hasActiveDocxFileClient"
  >
>;

const PAST_CHAT_SCOPES = [
  { type: PAST_CHAT_SCOPE_TYPE.allChats },
  { type: PAST_CHAT_SCOPE_TYPE.matters, workspaceIds: [workspaceId] },
] as const satisfies readonly PastChatScope[];

const THIRD_PARTY_BOUNDARIES = [
  { type: "raw" },
  asTestRaw<ChatThirdPartyBoundary>({ type: "anonymized" }),
] as const satisfies readonly ChatThirdPartyBoundary[];

/** Every option that gates a tool group out of a run, crossed exhaustively. */
const buildRunScenarios = (): RunToolsProps[] => {
  const scenarios: RunToolsProps[] = [];
  for (const skillMetadata of Object.values(SKILL_CATALOGS)) {
    for (const surface of Object.values(DOCX_SURFACES)) {
      for (const thirdPartyBoundary of THIRD_PARTY_BOUNDARIES) {
        for (const editApplyMode of ["auto", "manual"] as const) {
          for (const activeFile of [undefined, activeDocxFile]) {
            for (const webSearchEnabled of [true, false]) {
              for (const memoryEnabled of [true, false]) {
                for (const activeSkillContext of [
                  null,
                  editableActiveSkillContext,
                ]) {
                  for (const memberRole of ["owner", "intern"] as const) {
                    for (const pastChatScope of PAST_CHAT_SCOPES) {
                      scenarios.push({
                        ...surface,
                        activeFile,
                        activeSkillContext,
                        editApplyMode,
                        memberRole,
                        memoryEnabled,
                        organizationId,
                        orgAIConfig: null,
                        pinServerValidatedWorkspaceId: () => true,
                        recordAuditEvent: noopAuditRecorder,
                        refRegistry: createChatRefRegistry(),
                        registryDispatch: BUSINESS_REGISTRY_DISPATCH,
                        requestWorkspaceId: workspaceId,
                        resolveMemorySourceWorkspaceIds: () => [],
                        safeDb: unusedSafeDb,
                        scopedDb: unusedScopedDb,
                        skillMetadata,
                        thirdPartyBoundary,
                        threadId,
                        toolDefectMemo: createChatToolDefectMemo(),
                        toolWorkspaceIds: resolveToolWorkspaceIds({
                          pinnedIds: [],
                          accessibleWorkspaceIds: [workspaceId],
                        }),
                        userId,
                        webSearchEnabled,
                        webSearchProviders: { webSearchProvider, urlFetcher },
                        workspaceId,
                        workspaceStatusById: new Map([[workspaceId, "active"]]),
                        pastChatScope,
                      });
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  return scenarios;
};

/**
 * The validation set the request path would build beside this run: the same
 * request inputs, minus everything `getChatValidationTools` fixes itself.
 */
const validationToolsFor = ({
  docxSuggestionSurface: _docxSuggestionSurface,
  hasActiveDocxEditClient: _hasActiveDocxEditClient,
  hasActiveDocxFileClient: _hasActiveDocxFileClient,
  purpose: _purpose,
  skillMetadata: _skillMetadata,
  thirdPartyBoundary: _thirdPartyBoundary,
  ...requestInputs
}: RunToolsProps) => getChatValidationTools(requestInputs);

const registeredToolNames = (tools: ReturnType<typeof getChatTools>) =>
  Object.entries(tools).flatMap(([name, tool]) =>
    tool === undefined ? [] : [name],
  );

const toolNamesMissingFromValidation = (scenario: RunToolsProps) => {
  const validationNames = new Set(
    registeredToolNames(validationToolsFor(scenario)),
  );
  return registeredToolNames(getChatTools(scenario)).filter(
    (name) => !validationNames.has(name),
  );
};

describe("chat validation tool set", () => {
  test("contains every tool any run of the same request can expose", () => {
    const scenarios = buildRunScenarios();
    const exposedByRuns = new Set<string>();
    const missing = new Set<string>();
    for (const scenario of scenarios) {
      for (const name of registeredToolNames(getChatTools(scenario))) {
        exposedByRuns.add(name);
      }
      for (const name of toolNamesMissingFromValidation(scenario)) {
        missing.add(name);
      }
    }

    // The matrix must reach each gated group, or the superset holds vacuously.
    for (const gatedToolName of [
      "load-skill",
      "read-skill-resource",
      "update-current-skill-resource",
      FETCH_URL_TOOL_NAME,
      READ_DOCUMENT_TOOL_NAME,
      REMEMBER_TOOL_NAME,
      REVIEW_FOLDER_CONSISTENCY_TOOL_NAME,
      SEARCH_ALL_PAST_CHATS_TOOL_NAME,
      SPAWN_SUBAGENTS_TOOL_NAME,
      SUGGEST_CHANGES_TOOL_NAME,
      WEB_SEARCH_TOOL_NAME,
    ]) {
      expect(exposedByRuns, gatedToolName).toContain(gatedToolName);
    }
    expect([...missing]).toEqual([]);
  });

  // Known gaps, pinned so they can only shrink. These gates are read from
  // organization or thread state on every request, and the validation set
  // honors the current value: when one flips while a turn awaits an answer or
  // an approval, the continuation's persisted calls to the gated tools no
  // longer validate. Fixing a gate means deleting its entry here.
  test("loses only the tools of a gate that closed between two requests", () => {
    const run = buildRunScenarios().find(
      (scenario) =>
        scenario.webSearchEnabled && scenario.memberRole === "owner",
    );
    if (run === undefined) {
      throw new Error("Expected a web-search-enabled owner scenario");
    }
    const missingAfter = (laterRequest: Partial<RunToolsProps>) => {
      const validationNames = new Set(
        registeredToolNames(validationToolsFor({ ...run, ...laterRequest })),
      );
      return registeredToolNames(getChatTools(run))
        .filter((name) => !validationNames.has(name))
        .toSorted();
    };

    expect(missingAfter({ webSearchEnabled: false })).toEqual([
      FETCH_URL_TOOL_NAME,
      WEB_SEARCH_TOOL_NAME,
    ]);
    expect(
      missingAfter({
        webSearchProviders: { webSearchProvider: null, urlFetcher: null },
      }),
    ).toEqual([FETCH_URL_TOOL_NAME, WEB_SEARCH_TOOL_NAME]);
    expect(
      missingAfter({ disabledNativeToolSlugs: ["boe", "infosoud"] }),
    ).toEqual(
      [
        ...Object.keys(createBoeTools()),
        ...Object.keys(createInfosoudTools()),
      ].toSorted(),
    );
  });
});
