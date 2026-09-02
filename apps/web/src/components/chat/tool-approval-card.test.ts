import { describe, expect, test } from "bun:test";

process.env["VITE_API_URL"] ??= "https://api.example.test";
const { describeSuggestChangesApplyOutcome, hasAutomaticApproval } =
  await import("@/components/chat/tool-approval-card.logic");
const { isSuggestChangesApplyOutput } =
  await import("@/components/chat/chat-ui-tools");

const noGrants = new Set<never>();

describe("automatic tool approval", () => {
  test("uses a matching conversation grant", () => {
    expect(
      hasAutomaticApproval({
        alwaysApprovedTools: noGrants,
        canAlwaysAllow: true,
        conversationApprovedTools: new Set(["mcp__connector__read"]),
        isPublicOfficialApproval: false,
        name: "mcp__connector__read",
      }),
    ).toBe(true);
  });

  test("never reuses a stored grant for delegation", () => {
    expect(
      hasAutomaticApproval({
        alwaysApprovedTools: new Set(["spawn_subagents"]),
        canAlwaysAllow: true,
        conversationApprovedTools: new Set(["spawn_subagents"]),
        isPublicOfficialApproval: false,
        name: "spawn_subagents",
      }),
    ).toBe(false);
  });
});

describe("isSuggestChangesApplyOutput", () => {
  test("tells the apply outcome from the queue envelope", () => {
    expect(
      isSuggestChangesApplyOutput({
        success: true,
        versionId: "v2",
        versionNumber: 2,
        fieldId: "f2",
        replacedFieldId: "f1",
        representation: "tracked-changes",
        applied: [],
        skipped: [],
        normalizations: [],
      }),
    ).toBe(true);
    expect(
      isSuggestChangesApplyOutput({ ok: false, error: "No document is open." }),
    ).toBe(false);
  });
});

describe("describeSuggestChangesApplyOutcome", () => {
  test("reports applied and skipped counts on success", () => {
    expect(
      describeSuggestChangesApplyOutcome({
        success: true,
        applied: [{ id: "a" }, { id: "b" }],
        representation: "tracked-changes",
        skipped: [{ id: "c" }],
      }),
    ).toEqual({
      kind: "applied",
      appliedCount: 2,
      representation: "tracked-changes",
      skippedCount: 1,
    });
  });

  test("triggers the author-name-required modal for that exact code", () => {
    expect(
      describeSuggestChangesApplyOutcome({
        success: false,
        code: "author_name_required",
        message: "Set a preferred name before using automatic document edits.",
      }),
    ).toEqual({
      kind: "author-name-required",
      message: "Set a preferred name before using automatic document edits.",
    });
  });

  test("renders nothing for an unrecognized failure code", () => {
    expect(
      describeSuggestChangesApplyOutcome({
        success: false,
        code: "some_other_code",
        message: "unused",
      }),
    ).toBeNull();
  });
});
