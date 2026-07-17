import { describe, expect, test } from "bun:test";

import { createSafeId } from "@/api/lib/branded-types";

import { resolveMemorySourceWorkspaceIds } from "./memory-provenance";

describe("resolveMemorySourceWorkspaceIds", () => {
  test("includes refs registered during the turn and filters inaccessible IDs", () => {
    const bound = createSafeId<"workspace">();
    const thread = createSafeId<"workspace">();
    const toolRead = createSafeId<"workspace">();
    const inaccessible = createSafeId<"workspace">();

    expect(
      resolveMemorySourceWorkspaceIds({
        accessibleWorkspaceIds: new Set([bound, thread, toolRead]),
        contextMatterIds: [bound],
        dataWorkspaceIds: [thread],
        registeredWorkspaceIds: [toolRead, inaccessible, toolRead],
        workspaceId: bound,
      }),
    ).toEqual([bound, thread, toolRead]);
  });
});
