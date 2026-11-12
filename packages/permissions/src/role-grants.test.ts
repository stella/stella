import { describe, expect, test } from "bun:test";

import { ORGANIZATION_ROLE_NAMES } from "@stll/auth-model";

import { roles } from "./index";
import type { PermissionInput } from "./role-grants";
import { roleAllows, statements } from "./role-grants";

/** Every single action of every resource, each asked for on its own. */
const singleActions: PermissionInput[] = Object.entries(statements).flatMap(
  ([resource, actions]) =>
    actions.map((action): PermissionInput => ({ [resource]: [action] })),
);

describe("roleAllows", () => {
  // The clients decide what to offer with `roleAllows`; the server decides
  // with the access control built from the same grants. They must agree on
  // every action, or a client offers what the server refuses.
  test.each(ORGANIZATION_ROLE_NAMES)(
    "agrees with the server's access control for %s on every action",
    (role) => {
      for (const permissions of singleActions) {
        expect({ permissions, allowed: roleAllows(role, permissions) }).toEqual(
          {
            permissions,
            allowed: roles[role].authorize(permissions).success,
          },
        );
      }
    },
  );

  test("grants a set only when every action in it is granted", () => {
    expect(roleAllows("member", { entity: ["create", "update"] })).toBe(true);
    expect(roleAllows("intern", { chat: ["create"], entity: ["update"] })).toBe(
      false,
    );
  });

  test("lets an intern or an external only read matters", () => {
    for (const role of ["intern", "external"]) {
      expect(roleAllows(role, { workspace: ["read"] })).toBe(true);
      expect(roleAllows(role, { workspace: ["update"] })).toBe(false);
      expect(roleAllows(role, { entity: ["delete"] })).toBe(false);
    }
  });

  test("grants nothing to a role it does not know", () => {
    expect(roleAllows("", { workspace: ["read"] })).toBe(false);
    expect(roleAllows("constructor", { workspace: ["read"] })).toBe(false);
  });
});
