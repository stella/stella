import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { SafeDb } from "@/api/db/safe-db";
import {
  buildChatRevisionNoteSection,
  buildChatSystemPromptParts,
  CHAT_REVISION_NOTE_MAX_CHARS,
  estimateChatRevisionNoteTokens,
} from "@/api/handlers/chat/chat-prompt";
import type { ChatRevisionContextChange } from "@/api/handlers/chat/chat-revision-context";
import { computeThreadContextUsage } from "@/api/handlers/chat/compaction";
import { toSafeId } from "@/api/lib/branded-types";
import { estimateTextTokens } from "@/api/lib/chat/compaction-tokens";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const MESSAGE_ID = toSafeId<"chatMessage">(
  "00000000-0000-4000-8000-000000000001",
);
const THREAD_ID = toSafeId<"chatThread">(
  "00000000-0000-4000-8000-000000000002",
);

const change = (before: string, after: string): ChatRevisionContextChange => ({
  messageId: MESSAGE_ID,
  revision: 1,
  before,
  after,
});

// The global prompt with no active resources performs only the revision read.
const assemble = async (changes: ChatRevisionContextChange[]) =>
  buildChatSystemPromptParts({
    activeDecision: undefined,
    activeExternal: undefined,
    activeFile: undefined,
    activeSkillContext: null,
    activeStatute: undefined,
    contextMatterIds: [],
    hasReachableMatter: false,
    offeredToolNamesForSkills: () => new Set(),
    practiceJurisdictions: [],
    refRegistry: createChatRefRegistry(),
    safeDb: asTestRaw<SafeDb>(async () => Result.ok(changes)),
    messages: [{ id: MESSAGE_ID, role: "assistant" }],
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

describe("accepted answer edits in later-turn context", () => {
  test("attaches the changed range to the untrusted prompt and preserves the cached prefix", async () => {
    const edited = (
      await assemble([
        change("The deadline is Monday.", "The deadline is Friday."),
      ])
    ).unwrap();
    const unedited = (await assemble([])).unwrap();

    expect(edited.fullPrompt).toContain("user replaced «Monday» with «Friday»");
    expect(edited.untrustedSuffix).toContain(
      "user replaced «Monday» with «Friday»",
    );
    expect(edited.safePrompt).not.toContain("ACCEPTED ANSWER EDITS");
    expect(edited.cacheStablePrefix).toBe(unedited.cacheStablePrefix);
    expect(unedited.fullPrompt).not.toContain("ACCEPTED ANSWER EDITS");
  });

  test("caps the entire attached section and each changed excerpt", async () => {
    const changes = Array.from({ length: 32 }, (_value, index) => ({
      ...change("x".repeat(10_000), "y".repeat(10_000)),
      revision: index + 1,
    }));
    const section = buildChatRevisionNoteSection(changes);
    const prompt = (await assemble(changes)).unwrap();

    expect(section.length).toBeLessThanOrEqual(CHAT_REVISION_NOTE_MAX_CHARS);
    expect(section).toContain("Further accepted edits omitted.");
    expect(section).not.toContain("x".repeat(181));
    expect(prompt.untrustedSuffix).toContain(section);
  });

  test("counts the exact attached note in conversation context while retaining the cached-prefix floor", () => {
    const changes = [change("Monday", "Friday")];
    const noteTokens = estimateChatRevisionNoteTokens(changes);
    const baseline = computeThreadContextUsage({
      messages: [],
      summary: null,
      promptTokens: 100,
      toolTokens: 200,
    });
    const edited = computeThreadContextUsage({
      messages: [],
      summary: null,
      promptTokens: 100,
      toolTokens: 200,
      conversationContextTokens: noteTokens,
    });

    expect(noteTokens).toBe(
      estimateTextTokens(`\n\n${buildChatRevisionNoteSection(changes)}`),
    );
    expect(edited.estimatedTokens - baseline.estimatedTokens).toBe(noteTokens);
    expect(edited.breakdown.conversationTokens).toBe(noteTokens);
    expect(edited.cacheStableTokens).toBe(baseline.cacheStableTokens);
    expect(estimateChatRevisionNoteTokens([])).toBe(0);
  });

  test("summarizes insertions, deletions, formatting and reversions without repeating shared text", () => {
    for (const [before, after, expected] of [
      ["Notice.", "Written notice.", "replaced «Notice» with «Written notice»"],
      ["30 days", "3 days", "replaced «30» with «3»"],
      ["Notice", "**Notice**", "replaced «Notice» with «**Notice**»"],
      ["Friday", "Monday", "replaced «Friday» with «Monday»"],
    ] as const) {
      expect(buildChatRevisionNoteSection([change(before, after)])).toContain(
        expected,
      );
    }
    expect(buildChatRevisionNoteSection([change("same", "same")])).toBe("");
  });

  test("preserves supplementary characters at both diff boundaries", () => {
    expect(buildChatRevisionNoteSection([change("A😀Z", "A😁Z")])).toContain(
      "replaced «😀» with «😁»",
    );
    expect(
      buildChatRevisionNoteSection([change("A😀Z", "A🨀Z")]).isWellFormed(),
    ).toBe(true);
  });

  test("keeps multiline prose on one quoted line", () => {
    const section = buildChatRevisionNoteSection([
      change(
        "Earlier wording",
        "First line.\r\nSecond line.\rThird line.\nFinal sentence in prose.",
      ),
    ]);
    expect(section.split("\n")).toHaveLength(2);
    expect(section.split("\n").at(1)).toBe(
      `Answer ${MESSAGE_ID}, edit 1: user replaced «Earlier wording» with «First line.  Second line. Third line. Final sentence in prose.».`,
    );
  });
});
