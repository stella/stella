import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as v from "valibot";

import { ORGANIZATION_ROLE_NAMES } from "@stll/auth-model";
import { assignableRoles } from "@stll/permissions";

import {
  inviteMemberSchema,
  roleAssignmentOptions,
} from "./role-assignment.logic";

const inviteSource = () =>
  readFileSync(
    fileURLToPath(
      new URL(
        "../../components/organization/invite-member-dialog.tsx",
        import.meta.url,
      ),
    ),
    "utf-8",
  );
const membersSource = () =>
  readFileSync(
    fileURLToPath(
      new URL(
        "../../routes/_protected.settings/organization.members.tsx",
        import.meta.url,
      ),
    ),
    "utf-8",
  );

describe("membership role control policy", () => {
  for (const actorRole of ORGANIZATION_ROLE_NAMES) {
    test(`${actorRole} sees and submits exactly the shared assignable roles`, () => {
      const expected = assignableRoles(actorRole);
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

  test("invitation validation and both controls use the shared role policy", () => {
    expect(inviteSource()).not.toMatch(/v\.picklist\(\[/u);
    expect(membersSource()).not.toContain("ASSIGNABLE_ROLES");
    expect(inviteSource()).toContain("inviteMemberSchema(currentUserRole)");
    expect(inviteSource()).toContain("roleAssignmentOptions(currentUserRole)");
    expect(membersSource()).toContain("roleAssignmentOptions(currentUserRole)");
    expect(inviteSource()).toContain("{roles.map((item) => (");
    expect(membersSource()).toContain("{roleData.map((item) => (");
  });

  test("role controls declare no independent role picklist", () => {
    for (const source of [inviteSource(), membersSource()]) {
      for (const array of source.matchAll(/\[([^\]]*)\]/gsu)) {
        for (const role of ORGANIZATION_ROLE_NAMES) {
          expect(array.at(1)).not.toMatch(new RegExp(`["']${role}["']`, "u"));
        }
      }
      expect(source).not.toContain("v.picklist(");
      expect(source).not.toMatch(
        /Object\.(?:keys|values|entries)\(\s*roleTranslationKeys\s*\)/u,
      );
      expect(source).not.toMatch(
        /roleTranslationKeys\s*\.\s*(?:map|filter|flatMap)\s*\(/u,
      );
      expect(source).toContain("roleTranslationKeys[value].labelKey");
    }
  });
});
