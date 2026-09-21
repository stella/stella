import { describe, expect, test } from "bun:test";

import { canWriteWorkspaceEntities } from "@/api/lib/workspace-entity-write-access";

describe("canWriteWorkspaceEntities", () => {
  test("requires current workspace access for non-admin edit roles", () => {
    expect(
      canWriteWorkspaceEntities({
        organizationRole: "member",
        workspaceMemberId: null,
      }),
    ).toBe(false);

    expect(
      canWriteWorkspaceEntities({
        organizationRole: "member",
        workspaceMemberId: "workspace_member_test",
      }),
    ).toBe(true);
  });

  test("allows owner and admin roles without a workspace membership row", () => {
    expect(
      canWriteWorkspaceEntities({
        organizationRole: "owner",
        workspaceMemberId: null,
      }),
    ).toBe(true);

    expect(
      canWriteWorkspaceEntities({
        organizationRole: "admin",
        workspaceMemberId: null,
      }),
    ).toBe(true);
  });

  test("rejects roles without entity update permission", () => {
    expect(
      canWriteWorkspaceEntities({
        organizationRole: "intern",
        workspaceMemberId: "workspace_member_test",
      }),
    ).toBe(false);

    expect(
      canWriteWorkspaceEntities({
        organizationRole: "external",
        workspaceMemberId: "workspace_member_test",
      }),
    ).toBe(false);
  });

  test("rejects missing or unknown organization roles", () => {
    expect(
      canWriteWorkspaceEntities({
        organizationRole: null,
        workspaceMemberId: "workspace_member_test",
      }),
    ).toBe(false);

    expect(
      canWriteWorkspaceEntities({
        organizationRole: "custom",
        workspaceMemberId: "workspace_member_test",
      }),
    ).toBe(false);

    expect(
      canWriteWorkspaceEntities({
        organizationRole: "toString",
        workspaceMemberId: "workspace_member_test",
      }),
    ).toBe(false);
  });
});
