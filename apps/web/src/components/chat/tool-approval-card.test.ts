import { describe, expect, test } from "bun:test";

process.env["VITE_API_URL"] ??= "https://api.example.test";
const { hasAutomaticApproval } =
  await import("@/components/chat/tool-approval-card");

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
