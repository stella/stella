import { describe, expect, test } from "bun:test";

import { getRequestWorkspacePolicy } from "@/routes/_protected.inbox/-new-request.logic";

describe("manual request workspace policy", () => {
  test("allows triagers to create an unscoped request", () => {
    expect(
      getRequestWorkspacePolicy({
        canCreateUnscoped: true,
        workspaceIds: ["workspace-a"],
      }),
    ).toEqual({ type: "unscoped-allowed", defaultWorkspaceId: null });
  });

  test("defaults non-triagers to their first accessible matter", () => {
    expect(
      getRequestWorkspacePolicy({
        canCreateUnscoped: false,
        workspaceIds: ["workspace-a", "workspace-b"],
      }),
    ).toEqual({
      type: "workspace-required",
      defaultWorkspaceId: "workspace-a",
    });
  });

  test("keeps submission blocked when a non-triager has no matter", () => {
    expect(
      getRequestWorkspacePolicy({
        canCreateUnscoped: false,
        workspaceIds: [],
      }),
    ).toEqual({ type: "workspace-required", defaultWorkspaceId: null });
  });
});
