import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";

import { createMemoryDedupIdentity } from "./memory-dedup";

const USER_ID = toSafeId<"user">("user-memory-dedup");
const WORKSPACE_A = toSafeId<"workspace">(
  "11111111-1111-4111-8111-111111111111",
);
const WORKSPACE_B = toSafeId<"workspace">(
  "22222222-2222-4222-8222-222222222222",
);

describe("memory dedup identity", () => {
  test("treats provenance as a set", () => {
    const first = createMemoryDedupIdentity({
      scope: "user",
      userId: USER_ID,
      workspaceId: null,
      kind: "instruction",
      content: "Use short headings",
      sourceDataWorkspaceIds: [WORKSPACE_B, WORKSPACE_A, WORKSPACE_B],
    });
    const second = createMemoryDedupIdentity({
      scope: "user",
      userId: USER_ID,
      workspaceId: null,
      kind: "instruction",
      content: "Use short headings",
      sourceDataWorkspaceIds: [WORKSPACE_A, WORKSPACE_B],
    });

    expect(first).toEqual(second);
    expect(first.sourceDataWorkspaceIds).toEqual([WORKSPACE_A, WORKSPACE_B]);
  });

  test("keeps identical text separate across owners and provenance", () => {
    const base = {
      scope: "user",
      userId: USER_ID,
      workspaceId: null,
      kind: "preference",
      content: "Prefer concise answers",
    } as const;
    const portable = createMemoryDedupIdentity({
      ...base,
      sourceDataWorkspaceIds: [],
    });
    const matterDerived = createMemoryDedupIdentity({
      ...base,
      sourceDataWorkspaceIds: [WORKSPACE_A],
    });
    const otherUser = createMemoryDedupIdentity({
      ...base,
      userId: toSafeId<"user">("other-user"),
      sourceDataWorkspaceIds: [],
    });

    expect(portable.dedupKey).not.toBe(matterDerived.dedupKey);
    expect(portable.dedupKey).not.toBe(otherUser.dedupKey);
  });
});
