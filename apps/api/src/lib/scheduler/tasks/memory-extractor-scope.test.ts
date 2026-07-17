import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";

import { resolveExtractedMemoryScope } from "./memory-extractor-scope";

const userId = toSafeId<"user">("22222222-2222-4222-8222-222222222222");
const workspaceId = toSafeId<"workspace">(
  "33333333-3333-4333-8333-333333333333",
);

describe("memory extraction scope", () => {
  test("drops portable kinds inferred from matter-derived summaries", () => {
    expect(
      resolveExtractedMemoryScope({
        kind: "preference",
        threadUserId: userId,
        threadWorkspaceId: workspaceId,
        threadDataWorkspaceIds: [workspaceId],
      }),
    ).toEqual({ type: "drop" });
  });

  test("keeps portable kinds from chats with no matter-derived data", () => {
    expect(
      resolveExtractedMemoryScope({
        kind: "instruction",
        threadUserId: userId,
        threadWorkspaceId: null,
        threadDataWorkspaceIds: [],
      }),
    ).toEqual({
      type: "user",
      userId,
      workspaceId: null,
      sourceDataWorkspaceIds: [],
    });
  });

  test("retains all contributing matters on workspace suggestions", () => {
    const secondWorkspaceId = toSafeId<"workspace">(
      "44444444-4444-4444-8444-444444444444",
    );

    expect(
      resolveExtractedMemoryScope({
        kind: "fact",
        threadUserId: userId,
        threadWorkspaceId: workspaceId,
        threadDataWorkspaceIds: [workspaceId, secondWorkspaceId],
      }),
    ).toEqual({
      type: "workspace",
      userId: null,
      workspaceId,
      sourceDataWorkspaceIds: [workspaceId, secondWorkspaceId],
    });
  });
});
