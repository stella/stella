import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { SafeDb } from "@/api/db/safe-db";
import type { ActiveChatSkillContext } from "@/api/handlers/chat/active-skill-context";
import { buildChatSystemPromptParts } from "@/api/handlers/chat/chat-prompt";
import {
  projectLoadedSkillHistory,
  SKILL_HISTORY_PROJECTION_BY_TOOL,
  SKILL_HISTORY_UNAVAILABLE,
} from "@/api/handlers/chat/skill-history-binding";
import type { ChatMessage } from "@/api/handlers/chat/types";
import {
  NO_SKILL_BINDING_SCOPE,
  resolveSkillBindingScope,
  skillBindingAllows,
} from "@/api/lib/agent-skills/binding";
import { SKILL_CONTENT_TOOL_NAMES } from "@/api/lib/agent-skills/skill-content-tools";
import { CHAT_SKILL_SOURCE } from "@/api/lib/agent-skills/skills";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const THREAD_ID = toSafeId<"chatThread">(
  "00000000-0000-4000-8000-000000000002",
);
const MATTER_A = toSafeId<"workspace">("00000000-0000-4000-8000-0000000000aa");
const MATTER_B = toSafeId<"workspace">("00000000-0000-4000-8000-0000000000ab");
const CLIENT_A = toSafeId<"contact">("00000000-0000-4000-8000-0000000000ba");
const CLIENT_B = toSafeId<"contact">("00000000-0000-4000-8000-0000000000bb");
const SKILL_ID = toSafeId<"agentSkill">("00000000-0000-4000-8000-0000000000dd");
const OTHER_SKILL_ID = toSafeId<"agentSkill">(
  "00000000-0000-4000-8000-0000000000de",
);
const CONTENT_HASH = "a".repeat(64);

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

const loadedSkillMessage = (): ChatMessage => ({
  id: toSafeId<"chatMessage">("00000000-0000-4000-8000-0000000000cc"),
  role: "assistant",
  parts: [
    {
      arguments: JSON.stringify({ skillName: "matter-playbook" }),
      id: "load-1",
      input: { skillName: "matter-playbook" },
      name: "load-skill",
      output: {
        contentHash: CONTENT_HASH,
        description: "One matter only",
        instructions: "PRIVATE MATTER METHOD",
        name: "matter-playbook",
        resources: [],
        skillId: SKILL_ID,
        version: null,
      },
      state: "complete",
      type: "tool-call",
    },
    {
      content: JSON.stringify({
        instructions: "PRIVATE MATTER METHOD",
        name: "matter-playbook",
      }),
      state: "complete",
      toolCallId: "load-1",
      type: "tool-result",
    },
  ],
});

const resourceMessage = (): ChatMessage => ({
  id: toSafeId<"chatMessage">("00000000-0000-4000-8000-0000000000cd"),
  role: "assistant",
  parts: [
    {
      arguments: JSON.stringify({
        path: "references/private.md",
        skillName: "matter-playbook",
      }),
      id: "resource-1",
      input: {
        path: "references/private.md",
        skillName: "matter-playbook",
      },
      name: "read-skill-resource",
      output: {
        content: "PRIVATE RESOURCE METHOD",
        contentHash: CONTENT_HASH,
        mimeType: "text/markdown",
        path: "references/private.md",
        skillId: SKILL_ID,
        skillName: "matter-playbook",
      },
      state: "complete",
      type: "tool-call",
    },
    {
      content: JSON.stringify({ content: "PRIVATE RESOURCE METHOD" }),
      state: "complete",
      toolCallId: "resource-1",
      type: "tool-result",
    },
  ],
});

const readableBinding = (boundWorkspaceId: SafeId<"workspace"> | null) => ({
  boundClientId: null,
  boundWorkspaceId,
  contentHash: CONTENT_HASH,
});

const scopeFor = async (
  matters: {
    clientId: SafeId<"contact"> | null;
    id: SafeId<"workspace">;
  }[],
  otherWorkspaceIds: SafeId<"workspace">[],
) => {
  const result = await resolveSkillBindingScope({
    homeWorkspaceId: MATTER_A,
    otherWorkspaceIds,
    safeDb: asTestRaw<SafeDb>(async (run: (tx: unknown) => Promise<unknown>) =>
      Result.ok(
        await run({
          select: () => ({
            from: () => ({ where: () => ({ limit: async () => matters }) }),
          }),
        }),
      ),
    ),
  });
  if (Result.isError(result)) {
    throw result.error;
  }
  return result.value;
};

describe("loaded skill bodies in chat history", () => {
  test("withholds a matter-bound body after another client's matter is added", async () => {
    const history = [loadedSkillMessage()];
    const binding = readableBinding(MATTER_A);
    const firstTurnScope = await scopeFor(
      [{ clientId: CLIENT_A, id: MATTER_A }],
      [],
    );
    const firstTurn = projectLoadedSkillHistory({
      bindings: new Map([[SKILL_ID, binding]]),
      messages: history,
      scope: firstTurnScope,
    });
    expect(JSON.stringify(firstTurn)).toContain("PRIVATE MATTER METHOD");

    const secondTurnScope = await scopeFor(
      [
        { clientId: CLIENT_A, id: MATTER_A },
        { clientId: CLIENT_B, id: MATTER_B },
      ],
      [MATTER_B],
    );
    const secondTurn = projectLoadedSkillHistory({
      bindings: new Map([[SKILL_ID, binding]]),
      messages: history,
      scope: secondTurnScope,
    });
    expect(JSON.stringify(secondTurn)).not.toContain("PRIVATE MATTER METHOD");
    expect(JSON.stringify(secondTurn)).toContain(
      SKILL_HISTORY_UNAVAILABLE.status,
    );
    expect(skillBindingAllows(secondTurnScope, binding)).toBe(false);
    expect(history).toEqual([loadedSkillMessage()]);
  });

  test("keeps a loaded skill body while its binding remains in scope", async () => {
    const scope = await scopeFor([{ clientId: CLIENT_A, id: MATTER_A }], []);
    const projected = projectLoadedSkillHistory({
      bindings: new Map([[SKILL_ID, readableBinding(MATTER_A)]]),
      messages: [loadedSkillMessage()],
      scope,
    });

    expect(JSON.stringify(projected)).toContain("PRIVATE MATTER METHOD");
    expect(JSON.stringify(projected)).not.toContain("skill-unavailable");
  });

  test("withholds a bound body when its stable identity is no longer readable", async () => {
    const projected = projectLoadedSkillHistory({
      bindings: new Map(),
      messages: [loadedSkillMessage()],
      scope: await scopeFor([{ clientId: CLIENT_A, id: MATTER_A }], []),
    });

    expect(JSON.stringify(projected)).not.toContain("PRIVATE MATTER METHOD");
    expect(JSON.stringify(projected)).toContain("skill-unavailable");
  });

  test("does not upgrade a missing bound skill to an unbound skill with the same slug", async () => {
    const projected = projectLoadedSkillHistory({
      bindings: new Map([[OTHER_SKILL_ID, readableBinding(null)]]),
      messages: [loadedSkillMessage()],
      scope: await scopeFor([{ clientId: CLIENT_A, id: MATTER_A }], []),
    });

    expect(JSON.stringify(projected)).not.toContain("PRIVATE MATTER METHOD");
    expect(JSON.stringify(projected)).toContain("skill-unavailable");
  });

  test("withholds a resource and its paired result after scope changes", async () => {
    const projected = projectLoadedSkillHistory({
      bindings: new Map([[SKILL_ID, readableBinding(MATTER_A)]]),
      messages: [resourceMessage()],
      scope: await scopeFor(
        [
          { clientId: CLIENT_A, id: MATTER_A },
          { clientId: CLIENT_B, id: MATTER_B },
        ],
        [MATTER_B],
      ),
    });

    expect(JSON.stringify(projected)).not.toContain("PRIVATE RESOURCE METHOD");
    expect(JSON.stringify(projected)).toContain("skill-unavailable");
  });

  test("keeps skill resources while their binding remains in scope", async () => {
    const projected = projectLoadedSkillHistory({
      bindings: new Map([[SKILL_ID, readableBinding(MATTER_A)]]),
      messages: [resourceMessage()],
      scope: await scopeFor([{ clientId: CLIENT_A, id: MATTER_A }], []),
    });

    expect(JSON.stringify(projected)).toContain("PRIVATE RESOURCE METHOD");
    expect(JSON.stringify(projected)).not.toContain("skill-unavailable");
  });

  test("enumerates every skill-content tool in the history projection", () => {
    expect(Object.keys(SKILL_HISTORY_PROJECTION_BY_TOOL).toSorted()).toEqual(
      [...SKILL_CONTENT_TOOL_NAMES].toSorted(),
    );
  });
});
