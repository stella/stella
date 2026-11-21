import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { ORGANIZATION_ROLE_NAMES } from "@stll/auth-model";
import {
  assignableRoles,
  isOrganizationManagementRole,
  memberHasPermissions,
  roleAllows,
  statements,
  withBillingRead,
} from "@stll/permissions";
import type { PermissionInput } from "@stll/permissions";
import { assertProperty } from "@stll/property-testing";

const RESOURCES = Object.keys(statements) as (keyof typeof statements)[];
const NON_BILLING_RESOURCES = RESOURCES.filter((r) => r !== "billing");

const singleResourcePermissionArb = (
  pool: readonly (keyof typeof statements)[],
): fc.Arbitrary<PermissionInput> =>
  fc.constantFrom(...pool).chain((resource) => {
    const actions = [...statements[resource]];
    return fc
      .subarray(actions, { minLength: 1 })
      .map((chosen) => ({ [resource]: chosen }) as PermissionInput);
  });

const permissionInputArb = (
  pool: readonly (keyof typeof statements)[] = RESOURCES,
): fc.Arbitrary<PermissionInput> =>
  fc
    .array(singleResourcePermissionArb(pool), { minLength: 1, maxLength: 3 })
    .map((parts) => Object.assign({}, ...parts) as PermissionInput);

const roleArb = fc.constantFrom(...ORGANIZATION_ROLE_NAMES);

describe("organization permissions properties", () => {
  test("client roleAllows matches server memberHasPermissions without billingAccess", () => {
    assertProperty(
      "client roleAllows matches server memberHasPermissions without billingAccess",
      fc.property(roleArb, permissionInputArb(), (role, permissions) => {
        expect(roleAllows(role, permissions)).toBe(
          memberHasPermissions({
            role,
            billingAccess: false,
            permissions,
          }),
        );
      }),
    );
  });

  test("billingAccess is monotonic and never leaks non-billing permissions", () => {
    assertProperty(
      "billingAccess is monotonic",
      fc.property(roleArb, permissionInputArb(), (role, permissions) => {
        const withoutBilling = memberHasPermissions({
          role,
          billingAccess: false,
          permissions,
        });
        const withBilling = memberHasPermissions({
          role,
          billingAccess: true,
          permissions,
        });
        if (withoutBilling) {
          expect(withBilling).toBe(true);
        }
      }),
    );

    assertProperty(
      "billingAccess never leaks non-billing permissions",
      fc.property(
        roleArb,
        permissionInputArb(NON_BILLING_RESOURCES),
        (role, permissions) => {
          expect(
            memberHasPermissions({ role, billingAccess: true, permissions }),
          ).toBe(
            memberHasPermissions({ role, billingAccess: false, permissions }),
          );
        },
      ),
    );
  });

  test("role hierarchy: owner >= admin >= member for every permission set", () => {
    assertProperty(
      "role hierarchy owner >= admin >= member",
      fc.property(
        fc.boolean(),
        permissionInputArb(),
        (billingAccess, permissions) => {
          const memberAllowed = memberHasPermissions({
            role: "member",
            billingAccess,
            permissions,
          });
          const adminAllowed = memberHasPermissions({
            role: "admin",
            billingAccess,
            permissions,
          });
          const ownerAllowed = memberHasPermissions({
            role: "owner",
            billingAccess,
            permissions,
          });
          if (memberAllowed) {
            expect(adminAllowed).toBe(true);
          }
          if (adminAllowed) {
            expect(ownerAllowed).toBe(true);
          }
        },
      ),
    );
  });

  test("withBillingRead always requires billing read and deduplicated workspace read", () => {
    assertProperty(
      "withBillingRead requires billing read and deduplicated workspace read",
      fc.property(
        fc.subarray([...statements.workspace]),
        (workspaceActions) => {
          const result = withBillingRead(
            workspaceActions.length === 0
              ? {}
              : { workspace: workspaceActions },
          );
          expect(result.billing).toEqual(["read"]);
          expect(result.workspace).toContain("read");
          expect(new Set(result.workspace).size).toBe(result.workspace.length);
          for (const action of workspaceActions) {
            expect(result.workspace).toContain(action);
          }
        },
      ),
    );
  });

  test("assignableRoles prevents privilege escalation for every role", () => {
    assertProperty(
      "assignableRoles prevents privilege escalation",
      fc.property(roleArb, (role) => {
        const assignable = assignableRoles(role);
        if (!isOrganizationManagementRole(role)) {
          expect(assignable).toEqual([]);
          return;
        }
        if (role === "admin") {
          expect(assignable).not.toContain("owner");
        }
        if (role === "owner") {
          expect([...assignable].toSorted()).toEqual(
            [...ORGANIZATION_ROLE_NAMES].toSorted(),
          );
        }
      }),
    );
  });
});
