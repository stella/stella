import { describe, expect, test } from "bun:test";

process.env["VITE_API_URL"] ??= "https://api.example.test";
const { describeEditWorkspaceDocumentOutcome, hasAutomaticApproval } =
  await import("@/components/chat/tool-approval-card.logic");

const noGrants = new Set<never>();

describe("automatic tool approval", () => {
  test("uses a matching conversation grant", () => {
    expect(
      hasAutomaticApproval({
        alwaysApprovedTools: noGrants,
        canAlwaysAllow: true,
        conversationApprovedTools: new Set(["mcp__connector__read"]),
        isDocxEditBatch: false,
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
        isDocxEditBatch: false,
        isPublicOfficialApproval: false,
        name: "spawn_subagents",
      }),
    ).toBe(false);
  });
});

describe("describeEditWorkspaceDocumentOutcome", () => {
  test("reports applied and skipped counts on success", () => {
    expect(
      describeEditWorkspaceDocumentOutcome({
        success: true,
        applied: [{ id: "a" }, { id: "b" }],
        skipped: [{ id: "c" }],
      }),
    ).toEqual({ kind: "applied", appliedCount: 2, skippedCount: 1 });
  });

  test("triggers the author-name-required modal for that exact code", () => {
    expect(
      describeEditWorkspaceDocumentOutcome({
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
      describeEditWorkspaceDocumentOutcome({
        success: false,
        code: "some_other_code",
        message: "unused",
      }),
    ).toBeNull();
  });
});
