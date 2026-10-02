import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { ORGANIZATION_ROLE_NAMES } from "@stll/auth-model";
import { assignableRoles } from "@stll/permissions";

import {
  inviteMemberSchema,
  roleAssignmentOptions,
} from "./role-assignment.logic";

describe("membership role control policy", () => {
  for (const actorRole of ORGANIZATION_ROLE_NAMES) {
    test(`${actorRole} sees and submits exactly the shared assignable roles`, () => {
      const expected = [...assignableRoles(actorRole)];
      const options = roleAssignmentOptions(actorRole);
      expect(options.map(({ value }) => value)).toEqual(expected);
      expect(new Set(options.map(({ value }) => value)).size).toBe(
        options.length,
      );

      const schema = inviteMemberSchema(actorRole);
      const accepted = ORGANIZATION_ROLE_NAMES.filter(
        (role) =>
          v.safeParse(schema, { email: "member@example.com", role }).success,
      );
      expect(accepted).toEqual(expected);
      for (const { value: role } of options) {
        expect(v.parse(schema, { email: "member@example.com", role })).toEqual({
          email: "member@example.com",
          role,
        });
      }
      for (const role of [
        "unknown",
        "admin,member",
        ["admin", "member"],
        " owner ",
      ]) {
        expect(
          v.safeParse(schema, { email: "member@example.com", role }).success,
        ).toBe(false);
      }
    });
  }

  test("an unresolved actor cannot offer or submit a role", () => {
    expect(roleAssignmentOptions(undefined)).toEqual([]);
    for (const role of ORGANIZATION_ROLE_NAMES) {
      expect(
        v.safeParse(inviteMemberSchema(undefined), {
          email: "member@example.com",
          role,
        }).success,
      ).toBe(false);
    }
  });
});
