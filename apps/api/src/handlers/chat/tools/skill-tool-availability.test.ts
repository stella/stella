import { describe, expect, test } from "bun:test";

import { CHAT_TOOL_SCOPE } from "@stll/api-contract";
import { DOCX_SUGGESTION_SURFACE } from "@stll/api-contract/chat-docx-suggestions";
import { SKILL_REQUIRED_TOOLS_METADATA_KEY } from "@stll/skills";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import type { ChatThirdPartyBoundary } from "@/api/handlers/chat/third-party-boundary";
import { resolveToolWorkspaceIds } from "@/api/handlers/chat/tools/authorized-workspace-ids";
import { COUNTERPARTY_CHECK_TOOL_NAME } from "@/api/handlers/chat/tools/counterparty-check-tools";
import { PAST_CHAT_SCOPE_TYPE } from "@/api/handlers/chat/tools/past-chat-tools";
import {
  chatToolNamesForSkills,
  type ChatSkillToolContext,
} from "@/api/handlers/chat/tools/skill-tool-availability";
import { resolveSkillToolAvailability } from "@/api/lib/agent-skills/required-tools";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import { BUSINESS_REGISTRY_DISPATCH } from "@/api/lib/business-registries/dispatch";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
import { createChatToolDefectMemo } from "@/api/lib/chat/tool-defect-memo";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const organizationId = toSafeId<"organization">(
  "11111111-1111-4111-8111-111111111111",
);
const userId = toSafeId<"user">("22222222-2222-4222-8222-222222222222");
const workspaceId = toSafeId<"workspace">(
  "33333333-3333-4333-8333-333333333333",
);

const unusedScopedDb: ScopedDb = async () => {
  throw new Error("This test only constructs tool sets.");
};
const unusedSafeDb: SafeDb = async () => {
  throw new Error("This test only constructs tool sets.");
};
const noopAuditRecorder: AuditRecorder = async () => undefined;

const chatContext = (
  overrides: Partial<ChatSkillToolContext> = {},
): ChatSkillToolContext => ({
  disabledNativeToolSlugs: [],
  docxSuggestionSurface: DOCX_SUGGESTION_SURFACE.fileOverlay,
  hasActiveDocxEditClient: false,
  hasActiveDocxFileClient: false,
  memberRole: "owner",
  organizationId,
  orgAIConfig: null,
  managedAIResidency: "eu" as const,
  pastChatScope: { type: PAST_CHAT_SCOPE_TYPE.allChats },
  pinServerValidatedWorkspaceId: () => true,
  recordAuditEvent: noopAuditRecorder,
  recordReadAuditEvent: noopAuditRecorder,
  refRegistry: createChatRefRegistry(),
  registryDispatch: BUSINESS_REGISTRY_DISPATCH,
  requestWorkspaceId: null,
  resolveMemorySourceWorkspaceIds: () => [],
  safeDb: unusedSafeDb,
  scopedDb: unusedScopedDb,
  thirdPartyBoundary: { type: "raw" },
  threadId: toSafeId<"chatThread">("55555555-5555-4555-8555-555555555555"),
  toolDefectMemo: createChatToolDefectMemo(),
  toolWorkspaceIds: resolveToolWorkspaceIds({
    accessibleWorkspaceIds: [workspaceId],
    pinnedIds: [],
  }),
  userId,
  userEmail: "standard@example.test",
  webSearchEnabled: false,
  webSearchProviders: { urlFetcher: null, webSearchProvider: null },
  workspaceId: null,
  workspaceStatusById: new Map([[workspaceId, "active"]]),
  ...overrides,
});

const availabilityIn = (
  required: string,
  overrides: Partial<ChatSkillToolContext> = {},
) =>
  resolveSkillToolAvailability({
    metadata: { [SKILL_REQUIRED_TOOLS_METADATA_KEY]: required },
    offeredToolNames: chatToolNamesForSkills(chatContext(overrides)),
  });

describe("chat skill availability", () => {
  test("a playbook skill is available where chat can save playbooks", () => {
    expect(availabilityIn("save_playbook list_playbooks")).toEqual({
      status: "available",
    });
  });

  test("a role without template access cannot fill templates", () => {
    expect(availabilityIn("fill_template")).toEqual({ status: "available" });
    expect(availabilityIn("fill_template", { memberRole: "external" })).toEqual(
      { status: "unavailable", missingTools: ["fill_template"] },
    );
  });

  test("anonymized mode drops the tools it cannot redact", () => {
    expect(availabilityIn(COUNTERPARTY_CHECK_TOOL_NAME)).toEqual({
      status: "available",
    });
    expect(
      availabilityIn(COUNTERPARTY_CHECK_TOOL_NAME, {
        thirdPartyBoundary: asTestRaw<ChatThirdPartyBoundary>({
          type: "anonymized",
        }),
      }),
    ).toEqual({
      status: "unavailable",
      missingTools: [COUNTERPARTY_CHECK_TOOL_NAME],
    });
  });

  test("a named tool scope narrows what a skill can use", () => {
    expect(
      availabilityIn("save_playbook", {
        toolScope: CHAT_TOOL_SCOPE.suggestTemplateFields,
      }),
    ).toEqual({ status: "unavailable", missingTools: ["save_playbook"] });
  });

  test("registry reads count through the code-mode runner", () => {
    expect(availabilityIn("list_playbooks ask-user")).toEqual({
      status: "available",
    });
  });
});
