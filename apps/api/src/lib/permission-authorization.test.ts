import { describe, expect, test } from "bun:test";
import Elysia from "elysia";
import fc from "fast-check";

import { roles, statements } from "@stll/permissions";
import type { PermissionInput } from "@stll/permissions";
import { assertProperty } from "@stll/property-testing";

import { permissionMacro } from "@/api/lib/auth";
import { isMemberRole } from "@/api/lib/member-roles";
import type { MemberRole } from "@/api/lib/member-roles";
import {
  grantsPermissions,
  hasManagementPermission,
  hasMemberPermission,
  readAuthorizedMemberRole,
  sessionMemberRole,
} from "@/api/lib/permission-authorization";
import type { AuthorizedMemberRole } from "@/api/lib/permission-authorization";

const MEMBER_ROLES = Object.keys(roles).filter(isMemberRole);

type ResourceActions = Record<string, readonly string[]>;
const STATEMENTS: ResourceActions = statements;
const RESOURCES = Object.keys(STATEMENTS);

/** A random permission set over the real statement table, possibly empty. */
const permissionSet = fc
  .array(
    fc
      .constantFrom(...RESOURCES)
      .chain((resource) =>
        fc
          .subarray([...(STATEMENTS[resource] ?? [])], { minLength: 1 })
          .map((actions) => [resource, actions] as const),
      ),
    { maxLength: 6 },
  )
  .map((pairs): ResourceActions => Object.fromEntries(pairs));

/** One requested resource with a non-empty action subset. */
const requested = fc
  .constantFrom(...RESOURCES)
  .chain((resource) =>
    fc
      .subarray([...(STATEMENTS[resource] ?? [])], { minLength: 1 })
      .map((actions) => ({ [resource]: actions })),
  );

// Generated sets come from the statement table itself, so every one is a
// valid permission input; the guard only proves that to the compiler.
const isPermissionInput = (
  candidate: ResourceActions,
): candidate is PermissionInput =>
  Object.entries(candidate).every(([resource, actions]) =>
    actions.every((action) => STATEMENTS[resource]?.includes(action) ?? false),
  );

const toPermissionInput = (value: ResourceActions): PermissionInput => {
  if (!isPermissionInput(value)) {
    throw new TypeError("generated set is not a permission input");
  }
  return value;
};

// The oracle: the role table for the role half, and a plain subset check over
// the request for the credential half.
const roleGrants = (role: MemberRole, request: ResourceActions): boolean =>
  roles[role].authorize(toPermissionInput(request)).success;
const subsetOf = (granted: ResourceActions, request: ResourceActions) =>
  Object.entries(request).every(([resource, actions]) =>
    actions.every(
      (action) =>
        (Object.hasOwn(granted, resource)
          ? granted[resource]
          : undefined
        )?.includes(action) ?? false,
    ),
  );

describe("permission authorization", () => {
  test("reads only a known member role with a credential from request context", () => {
    const contextWithInheritedMemberRole: object = Object.create({
      memberRole: sessionMemberRole("owner"),
    });
    const memberRoleWithInheritedRole: object = Object.create({
      role: "owner",
      credential: { type: "session" },
    });

    expect(
      readAuthorizedMemberRole({ memberRole: sessionMemberRole("owner") }),
    ).toEqual(sessionMemberRole("owner"));
    expect(readAuthorizedMemberRole({})).toBeNull();
    expect(readAuthorizedMemberRole({ memberRole: null })).toBeNull();
    expect(readAuthorizedMemberRole(contextWithInheritedMemberRole)).toBeNull();
    expect(
      readAuthorizedMemberRole({ memberRole: memberRoleWithInheritedRole }),
    ).toBeNull();
    for (const role of ["custom", "constructor"]) {
      expect(
        readAuthorizedMemberRole({
          memberRole: { role, credential: { type: "session" } },
        }),
      ).toBeNull();
    }
  });

  test("refuses a context whose credential is missing or unknown", () => {
    // A context built without the credential must not read as the role's full
    // authority.
    expect(
      readAuthorizedMemberRole({ memberRole: { role: "owner" } }),
    ).toBeNull();
    expect(
      readAuthorizedMemberRole({
        memberRole: { role: "owner", credential: { type: "machine" } },
      }),
    ).toBeNull();
    expect(
      readAuthorizedMemberRole({
        memberRole: { role: "owner", credential: { type: "attenuated" } },
      }),
    ).toBeNull();
    expect(
      readAuthorizedMemberRole({
        memberRole: {
          role: "owner",
          credential: { type: "attenuated", permissions: { view: ["create"] } },
        },
      }),
    ).toEqual({
      role: "owner",
      credential: { type: "attenuated", permissions: { view: ["create"] } },
    });
  });

  test("authorizes a session from the local role map", () => {
    expect(
      hasMemberPermission(sessionMemberRole("owner"), {
        organization: ["delete"],
      }),
    ).toBe(true);
    expect(
      hasMemberPermission(sessionMemberRole("member"), {
        organization: ["delete"],
      }),
    ).toBe(false);
    expect(
      hasMemberPermission(sessionMemberRole("external"), {
        workspace: ["read"],
      }),
    ).toBe(true);
  });

  test("a session spends exactly its role", () => {
    assertProperty(
      "a session spends exactly its role",
      fc.property(
        fc.constantFrom(...MEMBER_ROLES),
        requested,
        (role, request) => {
          expect(
            hasMemberPermission(
              sessionMemberRole(role),
              toPermissionInput(request),
            ),
          ).toBe(roleGrants(role, request));
        },
      ),
    );
  });

  test("an attenuated credential spends what both its role and its set grant", () => {
    assertProperty(
      "an attenuated credential spends what both its role and its set grant",
      fc.property(
        fc.constantFrom(...MEMBER_ROLES),
        permissionSet,
        requested,
        (role, granted, request) => {
          const authority: AuthorizedMemberRole = {
            role,
            credential: {
              type: "attenuated",
              permissions: toPermissionInput(granted),
            },
          };
          const input = toPermissionInput(request);

          expect(hasMemberPermission(authority, input)).toBe(
            roleGrants(role, request) && subsetOf(granted, request),
          );
          expect(grantsPermissions(toPermissionInput(granted), input)).toBe(
            subsetOf(granted, request),
          );
        },
      ),
    );
  });

  test("management overrides need the role and the permission they spend", () => {
    const view = { view: ["create"] } satisfies PermissionInput;
    const update = { agentSkill: ["update"] } satisfies PermissionInput;
    expect(hasManagementPermission(sessionMemberRole("owner"), update)).toBe(
      true,
    );
    expect(hasManagementPermission(sessionMemberRole("member"), update)).toBe(
      false,
    );
    expect(
      hasManagementPermission(
        {
          role: "owner",
          credential: { type: "attenuated", permissions: view },
        },
        update,
      ),
    ).toBe(false);
    expect(
      hasManagementPermission(
        {
          role: "admin",
          credential: { type: "attenuated", permissions: update },
        },
        update,
      ),
    ).toBe(true);
  });

  test("permission macro authenticates before checking permissions", async () => {
    const app = new Elysia()
      .use(permissionMacro)
      .get("/protected", () => ({ ok: true }), {
        permissions: { workspace: ["read"] },
      });

    const response = await app.handle(
      new Request("http://localhost/protected"),
    );

    expect(response.status).toBe(401);
  });
});
