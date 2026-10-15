import { describe, expect, test } from "bun:test";

import { roles } from "@stll/permissions";

import { canWriteWorkspaceEntities } from "@/api/lib/entities/workspace-entity-write-access";
import { isMemberRole } from "@/api/lib/member-roles";

describe("canWriteWorkspaceEntities", () => {
  test("never writes in a matter the database access rule does not reach", () => {
    for (const organizationRole of Object.keys(roles)) {
      expect(
        canWriteWorkspaceEntities({ organizationRole, reachesMatter: false }),
      ).toBe(false);
    }
  });

  test("writes in a reached matter exactly when the role may update entities", () => {
    for (const organizationRole of Object.keys(roles).filter(isMemberRole)) {
      expect(
        canWriteWorkspaceEntities({ organizationRole, reachesMatter: true }),
      ).toBe(roles[organizationRole].authorize({ entity: ["update"] }).success);
    }
    expect(
      canWriteWorkspaceEntities({
        organizationRole: "member",
        reachesMatter: true,
      }),
    ).toBe(true);
    expect(
      canWriteWorkspaceEntities({
        organizationRole: "intern",
        reachesMatter: true,
      }),
    ).toBe(false);
    expect(
      canWriteWorkspaceEntities({
        organizationRole: "external",
        reachesMatter: true,
      }),
    ).toBe(false);
  });

  test("rejects missing or unknown organization roles", () => {
    for (const organizationRole of [null, "custom", "toString"]) {
      expect(
        canWriteWorkspaceEntities({ organizationRole, reachesMatter: true }),
      ).toBe(false);
    }
  });
});
