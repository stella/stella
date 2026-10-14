import { describe, expect, test } from "bun:test";

import { canWriteWorkspaceEntities } from "@/api/lib/entities/workspace-entity-write-access";

describe("canWriteWorkspaceEntities", () => {
  test("requires current workspace access for non-admin edit roles", () => {
    expect(
      canWriteWorkspaceEntities({
        organizationRole: "member",
        workspaceMemberId: null,
        workspaceVisibility: "admins_and_assigned",
      }),
    ).toBe(false);

    expect(
      canWriteWorkspaceEntities({
        organizationRole: "member",
        workspaceMemberId: "workspace_member_test",
        workspaceVisibility: "admins_and_assigned",
      }),
    ).toBe(true);
  });

  test("allows owner and admin roles without a workspace membership row", () => {
    for (const organizationRole of ["owner", "admin"]) {
      expect(
        canWriteWorkspaceEntities({
          organizationRole,
          workspaceMemberId: null,
          workspaceVisibility: "admins_and_assigned",
        }),
      ).toBe(true);
    }
  });

  test("needs a membership row on an assigned-only matter, even for owners and admins", () => {
    for (const organizationRole of ["owner", "admin"]) {
      expect(
        canWriteWorkspaceEntities({
          organizationRole,
          workspaceMemberId: null,
          workspaceVisibility: "assigned_only",
        }),
      ).toBe(false);
      expect(
        canWriteWorkspaceEntities({
          organizationRole,
          workspaceMemberId: "workspace_member_test",
          workspaceVisibility: "assigned_only",
        }),
      ).toBe(true);
    }
  });

  test("an all-members matter lets an unassigned member write, and narrowing it closes their session", () => {
    expect(
      canWriteWorkspaceEntities({
        organizationRole: "member",
        workspaceMemberId: null,
        workspaceVisibility: "all_members",
      }),
    ).toBe(true);
    // The same long-lived credential, re-evaluated after the matter is
    // narrowed to admins and assigned members.
    expect(
      canWriteWorkspaceEntities({
        organizationRole: "member",
        workspaceMemberId: null,
        workspaceVisibility: "admins_and_assigned",
      }),
    ).toBe(false);
  });

  test("an all-members matter never admits an external user, and an intern keeps the intern's read-only grant", () => {
    expect(
      canWriteWorkspaceEntities({
        organizationRole: "external",
        workspaceMemberId: null,
        workspaceVisibility: "all_members",
      }),
    ).toBe(false);
    expect(
      canWriteWorkspaceEntities({
        organizationRole: "intern",
        workspaceMemberId: null,
        workspaceVisibility: "all_members",
      }),
    ).toBe(false);
  });

  test("rejects roles without entity update permission", () => {
    for (const organizationRole of ["intern", "external"]) {
      expect(
        canWriteWorkspaceEntities({
          organizationRole,
          workspaceMemberId: "workspace_member_test",
          workspaceVisibility: "admins_and_assigned",
        }),
      ).toBe(false);
    }
  });

  test("rejects missing or unknown organization roles", () => {
    for (const organizationRole of [null, "custom", "toString"]) {
      expect(
        canWriteWorkspaceEntities({
          organizationRole,
          workspaceMemberId: "workspace_member_test",
          workspaceVisibility: "all_members",
        }),
      ).toBe(false);
    }
  });
});
