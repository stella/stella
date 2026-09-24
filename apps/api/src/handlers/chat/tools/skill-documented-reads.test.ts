import { describe, expect, test } from "bun:test";

import { listSkillMetadata, readDocumentedChatReads } from "@stll/skills";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import {
  buildGlobalPrompt,
  buildWorkspacePromptText,
} from "@/api/handlers/chat/chat-prompt";
import { resolveToolWorkspaceIds } from "@/api/handlers/chat/tools/authorized-workspace-ids";
import {
  getChatTools,
  getChatValidationTools,
} from "@/api/handlers/chat/tools/chat-tools";
import {
  CHAT_CODE_MODE_SYSTEM_PROMPT,
  chatCodeModeSystemPrompt,
  createChatCodeModeSurface,
} from "@/api/handlers/chat/tools/execute/chat-code-mode";
import {
  DOCUMENTABLE_CHAT_READ_NAMES,
  documentedChatReadsOf,
  MAX_DOCUMENTED_CHAT_READS,
  toDocumentedChatReads,
} from "@/api/handlers/chat/tools/execute/documented-chat-reads";
import { PAST_CHAT_SCOPE_TYPE } from "@/api/handlers/chat/tools/past-chat-tools";
import { resolveActiveChatSkillContext } from "@/api/lib/agent-skills/skills";
import type { ActiveChatSkillContext } from "@/api/lib/agent-skills/skills";
import { toSafeId } from "@/api/lib/branded-types";
import { BUSINESS_REGISTRY_DISPATCH } from "@/api/lib/business-registries/dispatch";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
import { createChatToolDefectMemo } from "@/api/lib/chat/tool-defect-memo";
import { installRecordingLogger } from "@/api/tests/helpers/recording-telemetry";

const PLAYBOOK_BUILDER = "playbook-builder";

/**
 * How much a built-in skill's documented reads may add to the code-mode
 * section, in characters, on that skill's turns only. A ratchet in the style
 * of `registry-quality.test.ts`: playbook-builder's three reads measured
 * 2_882 (base 6_100, variant 8_982), and the ceiling sits ~13% above so a
 * description edit fits but a fourth read is a reviewed bump.
 */
const DOCUMENTED_READS_PROMPT_CHAR_CEILING = 3250;

const organizationId = toSafeId<"organization">(
  "11111111-1111-4111-8111-111111111111",
);
const userId = toSafeId<"user">("22222222-2222-4222-8222-222222222222");
const workspaceId = toSafeId<"workspace">(
  "33333333-3333-4333-8333-333333333333",
);
const threadId = toSafeId<"chatThread">("55555555-5555-4555-8555-555555555555");

const unusedScopedDb: ScopedDb = async () => {
  throw new Error("This test only constructs tool sets and prompts.");
};
const unusedSafeDb: SafeDb = async () => {
  throw new Error("This test only constructs tool sets and prompts.");
};

type RunToolsProps = Parameters<typeof getChatTools>[0];

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

/** The full type stub code-mode emits for an eagerly documented read. */
const stubOf = (read: string) => `declare function external_${read}`;

/**
 * A "Discoverable APIs" line: lazy reads are listed as `- external_<name> …`
 * with no backticks, while an eager read's doc line is `` - `external_<name>(input)` ``.
 */
const discoveryLineOf = (read: string) =>
  new RegExp(`^- external_${read} `, "mu");

describe("skill-documented chat reads", () => {
  test("every built-in skill documents only reads chat can document", () => {
    for (const skill of listSkillMetadata()) {
      const { rejected } = toDocumentedChatReads(
        readDocumentedChatReads(skill.metadata),
      );
      expect(
        rejected,
        `${skill.name} documents ${JSON.stringify(rejected)}`,
      ).toEqual([]);
    }
  });

  test("the documentable set is the projectable reads the base prompt leaves lazy", () => {
    expect(DOCUMENTABLE_CHAT_READ_NAMES).not.toContain("list_matters");
    expect(DOCUMENTABLE_CHAT_READ_NAMES).toContain("list_documents");
    // `read_document` is projectable; `fetch` is not and never enters chat.
    expect(DOCUMENTABLE_CHAT_READ_NAMES).toContain("read_document");
    expect(DOCUMENTABLE_CHAT_READ_NAMES).not.toContain("fetch");
    for (const read of DOCUMENTABLE_CHAT_READ_NAMES) {
      expect(CHAT_CODE_MODE_SYSTEM_PROMPT).not.toContain(stubOf(read));
      expect(CHAT_CODE_MODE_SYSTEM_PROMPT).toMatch(discoveryLineOf(read));
    }
    // And nothing else is discoverable: the map-derived set and the
    // registry-ordered catalog code-mode renders agree in both directions.
    expect(CHAT_CODE_MODE_SYSTEM_PROMPT.match(/^- external_/gmu)?.length).toBe(
      DOCUMENTABLE_CHAT_READ_NAMES.length,
    );
  });

  test("a name outside the documentable set, or past the limit, is rejected with its reason", () => {
    const documentable = DOCUMENTABLE_CHAT_READ_NAMES.slice(
      0,
      MAX_DOCUMENTED_CHAT_READS + 1,
    );
    const overflow = documentable.at(-1);
    if (overflow === undefined) {
      throw new Error("the documentable set is smaller than the limit");
    }

    const { reads, rejected } = toDocumentedChatReads([
      "list_matters",
      "fetch",
      "not_a_tool",
      ...documentable,
    ]);

    expect(reads).toEqual(documentable.slice(0, MAX_DOCUMENTED_CHAT_READS));
    expect(rejected).toEqual([
      { name: "list_matters", reason: "not-documentable" },
      { name: "fetch", reason: "not-documentable" },
      { name: "not_a_tool", reason: "not-documentable" },
      { name: overflow, reason: "over-limit" },
    ]);
  });

  test("the playbook-builder skill documents the reads its flow needs", async () => {
    const skill = await resolveBuiltInSkill(PLAYBOOK_BUILDER);
    expect(documentedChatReadsOf(skill)).toEqual([
      "list_documents",
      "search_across_matters",
      "read_content_across_matters",
    ]);
  });

  test("every built-in skill's documented reads fit the prompt ceiling", async () => {
    for (const { name } of listSkillMetadata()) {
      const skill = await resolveBuiltInSkill(name);
      const added =
        chatCodeModeSystemPrompt(documentedChatReadsOf(skill)).length -
        CHAT_CODE_MODE_SYSTEM_PROMPT.length;
      expect(added, `${name} adds ${String(added)} chars`).toBeLessThanOrEqual(
        DOCUMENTED_READS_PROMPT_CHAR_CEILING,
      );
    }
  });

  test("no skill documents nothing; a built-in's rejected name panics; an installed skill's is dropped with a log", async () => {
    const [documented] = DOCUMENTABLE_CHAT_READ_NAMES;
    if (documented === undefined) {
      throw new Error("the documentable set is empty");
    }
    const builtIn = await resolveBuiltInSkill(PLAYBOOK_BUILDER);
    const installed: ActiveChatSkillContext = {
      ...builtIn,
      documentedChatReads: [documented, "list_matters", "nothing_here"],
      id: toSafeId<"agentSkill">("44444444-4444-4444-8444-444444444444"),
      origin: "authored",
      source: "installed",
    };
    const logs = installRecordingLogger();

    try {
      expect(documentedChatReadsOf(null)).toEqual([]);
      expect(() =>
        documentedChatReadsOf({
          ...builtIn,
          documentedChatReads: ["nothing_here"],
        }),
      ).toThrow(
        "documents chat reads it cannot: nothing_here (not-documentable)",
      );
      expect(logs.records).toEqual([]);

      expect(documentedChatReadsOf(installed)).toEqual([documented]);
      expect(logs.at("WARN")).toMatchObject([
        {
          message: "chat.skill.documented_reads_rejected",
          attributes: {
            "skill.id": installed.id,
            "skill.rejected_reads":
              "list_matters (not-documentable), nothing_here (not-documentable)",
          },
        },
      ]);
    } finally {
      logs.restore();
    }
  });

  test("the limit leaves discover_tools at least one read to document", () => {
    expect(MAX_DOCUMENTED_CHAT_READS).toBeLessThan(
      DOCUMENTABLE_CHAT_READ_NAMES.length,
    );
  });

  test("a documented read is stubbed in the code-mode prompt and leaves the discovery catalog", () => {
    const [documented, stillLazy] = DOCUMENTABLE_CHAT_READ_NAMES;
    if (documented === undefined || stillLazy === undefined) {
      throw new Error("the documentable set needs two reads");
    }
    const surface = createChatCodeModeSurface({
      concurrencyKey: "skill-documented-reads-test",
      documentedReads: [documented],
      runReadTool: async () => ({}),
    });

    expect(surface.systemPrompt).toContain(stubOf(documented));
    expect(surface.systemPrompt).not.toMatch(discoveryLineOf(documented));
    expect(surface.systemPrompt).not.toContain(stubOf(stillLazy));
    expect(surface.systemPrompt).toMatch(discoveryLineOf(stillLazy));
    expect(surface.discoveryTool?.description).not.toContain(
      `external_${documented}`,
    );
    expect(surface.discoveryTool?.description).toContain(
      `external_${stillLazy}`,
    );
  });

  test("the variant is one string per set, and the empty set is the base constant", () => {
    const [first, second] = DOCUMENTABLE_CHAT_READ_NAMES;
    if (first === undefined || second === undefined) {
      throw new Error("the documentable set needs two reads");
    }

    expect(chatCodeModeSystemPrompt([])).toBe(CHAT_CODE_MODE_SYSTEM_PROMPT);
    expect(chatCodeModeSystemPrompt([first, second])).toBe(
      chatCodeModeSystemPrompt([second, first, first]),
    );
    expect(chatCodeModeSystemPrompt([first])).not.toBe(
      CHAT_CODE_MODE_SYSTEM_PROMPT,
    );
  });

  test("the streaming set documents the skill's reads; the validation set keeps them discoverable", async () => {
    const [documented] = DOCUMENTABLE_CHAT_READ_NAMES;
    if (documented === undefined) {
      throw new Error("the documentable set is empty");
    }
    const skill: ActiveChatSkillContext = {
      ...(await resolveBuiltInSkill(PLAYBOOK_BUILDER)),
      documentedChatReads: [documented],
    };
    const {
      docxSuggestionSurface: _surface,
      hasActiveDocxEditClient: _editClient,
      hasActiveDocxFileClient: _fileClient,
      thirdPartyBoundary: _boundary,
      ...validationInputs
    } = turnProps(skill);

    const streaming = getChatTools(turnProps(skill));
    const validation = getChatValidationTools(validationInputs);
    const bare = getChatTools(turnProps(null));

    expect(streaming["discover_tools"]?.description).not.toContain(
      `external_${documented}`,
    );
    expect(validation["discover_tools"]?.description).toContain(
      `external_${documented}`,
    );
    expect(bare["discover_tools"]?.description).toContain(
      `external_${documented}`,
    );
  });

  test("the assembled prompt carries the skill's stubs and is the base prompt without a skill", () => {
    const [documented] = DOCUMENTABLE_CHAT_READ_NAMES;
    if (documented === undefined) {
      throw new Error("the documentable set is empty");
    }
    const documentedChatReads = toDocumentedChatReads([documented]).reads;
    const globalWith = buildGlobalPrompt({
      documentedChatReads,
      skillMetadata: [],
      userContext: null,
    });
    const globalWithout = buildGlobalPrompt({
      skillMetadata: [],
      userContext: null,
    });
    const workspaceWith = buildWorkspacePromptText({
      documentedChatReads,
      entityCount: 0,
      refRegistry: createChatRefRegistry(),
      skillMetadata: [],
      userContext: null,
      workspaceId,
      workspaceName: "Matter",
    });

    expect(globalWith).toContain(stubOf(documented));
    expect(globalWith).not.toMatch(discoveryLineOf(documented));
    expect(workspaceWith).toContain(stubOf(documented));
    expect(globalWithout).toContain(CHAT_CODE_MODE_SYSTEM_PROMPT);
    expect(globalWithout).not.toContain(stubOf(documented));
  });
});
