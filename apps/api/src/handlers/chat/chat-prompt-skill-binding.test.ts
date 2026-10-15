import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { SafeDb } from "@/api/db/safe-db";
import type { ActiveChatSkillContext } from "@/api/handlers/chat/active-skill-context";
import { buildChatSystemPromptParts } from "@/api/handlers/chat/chat-prompt";
import { NO_SKILL_BINDING_SCOPE } from "@/api/lib/agent-skills/binding";
import { CHAT_SKILL_SOURCE } from "@/api/lib/agent-skills/skills";
import { toSafeId } from "@/api/lib/branded-types";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const THREAD_ID = toSafeId<"chatThread">(
  "00000000-0000-4000-8000-000000000002",
);

const activeSkillBoundTo = (
  binding: ActiveChatSkillContext["binding"],
): ActiveChatSkillContext => ({
  binding,
  body: "# Matter playbook",
  description: "A playbook for one matter.",
  displayName: "Matter playbook",
  documentedChatReads: [],
  editable: false,
  excludedChatTools: [],
  id: toSafeId<"agentSkill">("00000000-0000-4000-8000-000000000003"),
  origin: "authored",
  requiredTools: [],
  resources: [],
  source: CHAT_SKILL_SOURCE.installed,
  toolName: "matter-playbook",
  version: null,
});

const build = async (activeSkillContext: ActiveChatSkillContext) =>
  await buildChatSystemPromptParts({
    activeDecision: undefined,
    activeExternal: undefined,
    activeFile: undefined,
    activeSkillContext,
    activeStatute: undefined,
    contextMatterIds: [],
    hasReachableMatter: false,
    offeredToolNamesForSkills: () => new Set(),
    practiceJurisdictions: [],
    refRegistry: createChatRefRegistry(),
    safeDb: asTestRaw<SafeDb>(async () => Result.ok([])),
    messages: [],
    requestedSkillNames: new Set(),
    skillBindingScope: NO_SKILL_BINDING_SCOPE,
    threadId: THREAD_ID,
    toolAvailability: {
      docxEditMode: null,
      templateAuthoring: false,
      webResearch: false,
      folioAgentDocTools: false,
      subagents: false,
    },
    userContext: undefined,
    workspaceId: null,
  });

describe("the active skill's binding in a chat turn", () => {
  test("a skill bound to a matter does not run outside it", async () => {
    const result = await build(
      activeSkillBoundTo({
        boundClientId: null,
        boundWorkspaceId: toSafeId<"workspace">(
          "00000000-0000-4000-8000-0000000000aa",
        ),
      }),
    );

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toBeInstanceOf(HandlerError);
      expect(
        result.error instanceof HandlerError ? result.error.status : null,
      ).toBe(403);
    }
  });

  test("a skill bound to a client does not run outside its matters", async () => {
    const result = await build(
      activeSkillBoundTo({
        boundClientId: toSafeId<"contact">(
          "00000000-0000-4000-8000-0000000000bb",
        ),
        boundWorkspaceId: null,
      }),
    );

    expect(Result.isError(result)).toBe(true);
  });
});
