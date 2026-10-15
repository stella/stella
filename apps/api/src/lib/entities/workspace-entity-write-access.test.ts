import { describe, expect, test } from "bun:test";

import { CLIENT_MATTER_ADMIN_ROLES, roles } from "@stll/permissions";

import { canWriteWorkspaceEntities } from "@/api/lib/entities/workspace-entity-write-access";

describe("canWriteWorkspaceEntities", () => {
  test("requires current workspace access for non-admin edit roles", () => {
    expect(
      canWriteWorkspaceEntities({
        organizationRole: "member",
        workspaceClientId: "client_test",
        workspaceMemberId: null,
      }),
    ).toBe(false);

    expect(
      canWriteWorkspaceEntities({
        organizationRole: "member",
        workspaceClientId: null,
        workspaceMemberId: "workspace_member_test",
      }),
    ).toBe(true);
  });

  test("allows owner and admin roles on client matters without a membership row", () => {
    expect(
      canWriteWorkspaceEntities({
        organizationRole: "owner",
        workspaceClientId: "client_test",
        workspaceMemberId: null,
      }),
    ).toBe(true);

    expect(
      canWriteWorkspaceEntities({
        organizationRole: "admin",
        workspaceClientId: "client_test",
        workspaceMemberId: null,
      }),
    ).toBe(true);
  });

  test("requires a membership row for owner and admin roles on matters without a client", () => {
    expect(
      canWriteWorkspaceEntities({
        organizationRole: "owner",
        workspaceClientId: null,
        workspaceMemberId: null,
      }),
    ).toBe(false);

    expect(
      canWriteWorkspaceEntities({
        organizationRole: "admin",
        workspaceClientId: null,
        workspaceMemberId: null,
      }),
    ).toBe(false);

    expect(
      canWriteWorkspaceEntities({
        organizationRole: "owner",
        workspaceClientId: null,
        workspaceMemberId: "workspace_member_test",
      }),
    ).toBe(true);
  });

  test("never reaches a matter the authorized workspace view does not grant", () => {
    for (const organizationRole of Object.keys(roles)) {
      for (const workspaceClientId of [null, "client_test"]) {
        for (const workspaceMemberId of [null, "workspace_member_test"]) {
          const viewGrantsMatter =
            workspaceMemberId !== null ||
            (workspaceClientId !== null &&
              CLIENT_MATTER_ADMIN_ROLES.some(
                (role) => role === organizationRole,
              ));
          const canWrite = canWriteWorkspaceEntities({
            organizationRole,
            workspaceClientId,
            workspaceMemberId,
          });
          expect(canWrite && !viewGrantsMatter).toBe(false);
        }
      }
    }
  });

  test("rejects roles without entity update permission", () => {
    expect(
      canWriteWorkspaceEntities({
        organizationRole: "intern",
        workspaceClientId: null,
        workspaceMemberId: "workspace_member_test",
      }),
    ).toBe(false);

    expect(
      canWriteWorkspaceEntities({
        organizationRole: "external",
        workspaceClientId: null,
        workspaceMemberId: "workspace_member_test",
      }),
    ).toBe(false);
  });

  test("rejects missing or unknown organization roles", () => {
    expect(
      canWriteWorkspaceEntities({
        organizationRole: null,
        workspaceClientId: "client_test",
        workspaceMemberId: "workspace_member_test",
      }),
    ).toBe(false);

    expect(
      canWriteWorkspaceEntities({
        organizationRole: "custom",
        workspaceClientId: "client_test",
        workspaceMemberId: "workspace_member_test",
      }),
    ).toBe(false);

    expect(
      canWriteWorkspaceEntities({
        organizationRole: "toString",
        workspaceClientId: "client_test",
        workspaceMemberId: "workspace_member_test",
      }),
    ).toBe(false);
  });
});
