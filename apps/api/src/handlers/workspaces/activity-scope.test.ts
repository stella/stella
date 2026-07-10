import { describe, expect, test } from "bun:test";

import {
  resolveWorkspaceActivityScope,
  WORKSPACE_ACTIVITY_PERMISSIONS,
  WORKSPACE_ACTIVITY_SCOPE,
} from "@/api/handlers/workspaces/activity-scope";
import { hasMemberPermission } from "@/api/lib/permission-authorization";

describe("workspace activity authorization", () => {
  test("allows read-only external users to receive entity activity", () => {
    const memberRole = { role: "external" } as const;

    expect(
      hasMemberPermission(memberRole, WORKSPACE_ACTIVITY_PERMISSIONS),
    ).toBe(true);
    expect(resolveWorkspaceActivityScope(memberRole)).toBe(
      WORKSPACE_ACTIVITY_SCOPE.entities,
    );
  });

  test("includes chat activity only for roles with chat access", () => {
    expect(resolveWorkspaceActivityScope({ role: "member" })).toBe(
      WORKSPACE_ACTIVITY_SCOPE.entitiesAndChat,
    );
  });
});
