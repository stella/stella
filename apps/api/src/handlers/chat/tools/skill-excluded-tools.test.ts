import { describe, expect, test } from "bun:test";

import { listSkillMetadata, readExcludedChatTools } from "@stll/skills";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import {
  buildGlobalPrompt,
  SUBAGENT_DELEGATION_SECTION,
} from "@/api/handlers/chat/chat-prompt";
import { areSubagentToolsAvailableForTurn } from "@/api/handlers/chat/send-message";
import { resolveToolWorkspaceIds } from "@/api/handlers/chat/tools/authorized-workspace-ids";
import {
  areSubagentToolsRegistered,
  EXCLUDABLE_CHAT_TOOL_NAMES,
  getChatTools,
  getChatValidationTools,
} from "@/api/handlers/chat/tools/chat-tools";
import { PAST_CHAT_SCOPE_TYPE } from "@/api/handlers/chat/tools/past-chat-tools";
import { SPAWN_SUBAGENTS_TOOL_NAME } from "@/api/handlers/chat/tools/subagent-tool-shared";
import { resolveActiveChatSkillContext } from "@/api/lib/agent-skills/skills";
import type { ActiveChatSkillContext } from "@/api/lib/agent-skills/skills";
import { toSafeId } from "@/api/lib/branded-types";
import { BUSINESS_REGISTRY_DISPATCH } from "@/api/lib/business-registries/dispatch";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
import { createChatToolDefectMemo } from "@/api/lib/chat/tool-defect-memo";

const PLAYBOOK_BUILDER = "playbook-builder";

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

type RunToolsProps = Parameters<typeof getChatTools>[0];

/** A top-level turn with nothing else gating `spawn_subagents` out. */
const turnProps = (
  activeSkillContext: ActiveChatSkillContext | null,
): RunToolsProps => ({
  activeSkillContext,
  docxSuggestionSurface: "file-overlay",
  editApplyMode: "manual",
  hasActiveDocxEditClient: false,
  hasActiveDocxFileClient: false,
  memberRole: "owner",
  memoryEnabled: false,
  organizationId,
  orgAIConfig: null,
  pinServerValidatedWorkspaceId: () => true,
  refRegistry: createChatRefRegistry(),
  registryDispatch: BUSINESS_REGISTRY_DISPATCH,
  requestWorkspaceId: workspaceId,
  resolveMemorySourceWorkspaceIds: () => [],
  safeDb: unusedSafeDb,
  scopedDb: unusedScopedDb,
  thirdPartyBoundary: { type: "raw" },
  threadId,
  toolDefectMemo: createChatToolDefectMemo(),
  toolWorkspaceIds: resolveToolWorkspaceIds({
    pinnedIds: [],
    accessibleWorkspaceIds: [workspaceId],
  }),
  userId,
  webSearchEnabled: false,
  webSearchProviders: { webSearchProvider: null, urlFetcher: null },
  workspaceId,
  workspaceStatusById: new Map([[workspaceId, "active"]]),
  pastChatScope: { type: PAST_CHAT_SCOPE_TYPE.allChats },
});

const registeredToolNames = (tools: ReturnType<typeof getChatTools>) =>
  Object.entries(tools).flatMap(([name, tool]) =>
    tool === undefined ? [] : [name],
  );

/** The shipped skill through the production built-in resolution path. */
const resolveBuiltInSkill = async (
  skillName: string,
): Promise<ActiveChatSkillContext> => {
  const resolved = await resolveActiveChatSkillContext({
    activeSkill: { skillName },
    memberRole: { role: "member" },
    organizationId,
    safeDb: unusedSafeDb,
    userId,
  });
  if (resolved.isErr() || resolved.value === null) {
    throw new Error(`${skillName} did not resolve as a built-in skill`);
  }
  return resolved.value;
};

describe("skill-declared chat tool exclusions", () => {
  test("every built-in skill excludes only names the gate honours", () => {
    const excludable = new Set<string>(EXCLUDABLE_CHAT_TOOL_NAMES);
    for (const skill of listSkillMetadata()) {
      for (const name of readExcludedChatTools(skill.metadata)) {
        expect(excludable, `${skill.name} excludes ${name}`).toContain(name);
      }
    }
  });

  test("every excludable name is a tool a top-level turn registers", () => {
    const registered = registeredToolNames(getChatTools(turnProps(null)));
    for (const name of EXCLUDABLE_CHAT_TOOL_NAMES) {
      expect(registered).toContain(name);
    }
  });

  test("the playbook-builder skill excludes spawn_subagents", async () => {
    const skill = await resolveBuiltInSkill(PLAYBOOK_BUILDER);
    expect(skill.excludedChatTools).toEqual([SPAWN_SUBAGENTS_TOOL_NAME]);
  });

  test("an excluded spawn_subagents leaves the streaming set but not the validation set", async () => {
    const skill = await resolveBuiltInSkill(PLAYBOOK_BUILDER);
    const {
      docxSuggestionSurface: _surface,
      hasActiveDocxEditClient: _editClient,
      hasActiveDocxFileClient: _fileClient,
      thirdPartyBoundary: _boundary,
      ...validationInputs
    } = turnProps(skill);

    expect(registeredToolNames(getChatTools(turnProps(skill)))).not.toContain(
      SPAWN_SUBAGENTS_TOOL_NAME,
    );
    expect(
      registeredToolNames(getChatValidationTools(validationInputs)),
    ).toContain(SPAWN_SUBAGENTS_TOOL_NAME);
    expect(
      registeredToolNames(
        getChatTools(turnProps({ ...skill, excludedChatTools: [] })),
      ),
    ).toContain(SPAWN_SUBAGENTS_TOOL_NAME);
  });

  test("the exclusion never re-opens the delegation depth cap", () => {
    expect(
      areSubagentToolsRegistered({ delegationDepth: 0, excludedChatTools: [] }),
    ).toBe(true);
    expect(
      areSubagentToolsRegistered({
        delegationDepth: 0,
        excludedChatTools: [SPAWN_SUBAGENTS_TOOL_NAME],
      }),
    ).toBe(false);
    expect(
      areSubagentToolsRegistered({ delegationDepth: 1, excludedChatTools: [] }),
    ).toBe(false);
  });

  test("the assembled prompt drops the delegation section with the skill active", async () => {
    const skill = await resolveBuiltInSkill(PLAYBOOK_BUILDER);
    const promptFor = (activeSkillContext: ActiveChatSkillContext | null) =>
      buildGlobalPrompt({
        skillMetadata: [],
        toolAvailability: {
          docxEditMode: null,
          templateAuthoring: false,
          webResearch: false,
          folioAgentDocTools: false,
          subagents: areSubagentToolsAvailableForTurn({
            activeSkillContext,
            toolScope: undefined,
          }),
        },
        userContext: null,
      });

    expect(promptFor(null)).toContain(SUBAGENT_DELEGATION_SECTION);
    expect(promptFor(skill)).not.toContain(SUBAGENT_DELEGATION_SECTION);
  });
});
