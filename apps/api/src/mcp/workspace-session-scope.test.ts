import { describe, expect, test } from "bun:test";

import type { AccessibleWorkspace } from "@/api/lib/auth";
import { toSafeId } from "@/api/lib/branded-types";
import { filterUsableMcpWorkspaces } from "@/api/mcp/workspace-session-scope";

const workspace1 = toSafeId<"workspace">("workspace_1");
const workspace2 = toSafeId<"workspace">("workspace_2");
const workspace3 = toSafeId<"workspace">("workspace_3");

const accessibleWorkspaces = [
  { id: workspace1, status: "active" },
  { id: workspace2, status: "archived" },
  { id: workspace3, status: "deleting" },
] as const satisfies readonly AccessibleWorkspace[];

describe("MCP token workspace attenuation", () => {
  test("intersects a token subset with current usable workspaces", () => {
    const workspaces = filterUsableMcpWorkspaces({
      accessibleWorkspaces,
      tokenWorkspaceIds: [workspace2, "workspace_not_accessible"],
    });

    expect(workspaces.map(({ id }) => id)).toEqual([workspace2]);
  });

  test("an empty token subset grants no workspaces", () => {
    expect(
      filterUsableMcpWorkspaces({
        accessibleWorkspaces,
        tokenWorkspaceIds: [],
      }),
    ).toEqual([]);
  });

  test("an absent attenuation preserves all current non-deleting access", () => {
    const workspaces = filterUsableMcpWorkspaces({
      accessibleWorkspaces,
      tokenWorkspaceIds: undefined,
    });

    expect(workspaces.map(({ id }) => id)).toEqual([workspace1, workspace2]);
  });
});
