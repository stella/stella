import { describe, expect, test } from "bun:test";

import { roles } from "./index";

describe("organization management permissions", () => {
  test("owner can perform Better Auth organization invite and member actions", () => {
    expect(roles.owner.authorize({ invitation: ["create"] }).success).toBe(
      true,
    );
    expect(roles.owner.authorize({ invitation: ["cancel"] }).success).toBe(
      true,
    );
    expect(roles.owner.authorize({ member: ["update"] }).success).toBe(true);
    expect(roles.owner.authorize({ team: ["create"] }).success).toBe(true);
    expect(roles.owner.authorize({ organization: ["update"] }).success).toBe(
      true,
    );
    expect(roles.owner.authorize({ ac: ["read"] }).success).toBe(true);
  });

  test("admin can invite users and manage members without delete-org access", () => {
    expect(roles.admin.authorize({ invitation: ["create"] }).success).toBe(
      true,
    );
    expect(roles.admin.authorize({ invitation: ["cancel"] }).success).toBe(
      true,
    );
    expect(roles.admin.authorize({ member: ["delete"] }).success).toBe(true);
    expect(roles.admin.authorize({ team: ["update"] }).success).toBe(true);
    expect(roles.admin.authorize({ organization: ["update"] }).success).toBe(
      true,
    );
    expect(roles.admin.authorize({ organization: ["delete"] }).success).toBe(
      false,
    );
  });

  test("non-management roles cannot invite users to the organization", () => {
    expect(roles.member.authorize({ invitation: ["create"] }).success).toBe(
      false,
    );
    expect(roles.intern.authorize({ invitation: ["create"] }).success).toBe(
      false,
    );
    expect(roles.external.authorize({ invitation: ["create"] }).success).toBe(
      false,
    );
  });
});
