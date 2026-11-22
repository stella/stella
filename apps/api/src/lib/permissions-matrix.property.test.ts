import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  ORGANIZATION_ROLE_NAMES,
  type OrganizationRoleName,
} from "@stll/auth-model";
import {
  assignableRoles,
  BILLING_READ_PERMISSION,
  memberHasPermissions,
  type PermissionInput,
  roleAllows,
  withBillingRead,
} from "@stll/permissions";
import { assertProperty } from "@stll/property-testing";

const ROLE_PAIRS: readonly (readonly [
  OrganizationRoleName,
  OrganizationRoleName,
])[] = [
  ["external", "intern"],
  ["intern", "member"],
  ["member", "admin"],
  ["admin", "owner"],
];

const NON_BILLING_PERMISSIONS: readonly PermissionInput[] = [
  { legalHold: ["place"] },
  { legalHold: ["release"] },
  { workspace: ["read"] },
  { workspace: ["create"] },
  { workspace: ["update"] },
  { workspace: ["delete"] },
  { contact: ["create"] },
  { invoice: ["create"] },
  { invoice: ["delete"] },
  { template: ["use"] },
  { template: ["delete"] },
  { entity: ["create"] },
  { entity: ["delete"] },
  { timeEntry: ["read"] },
  { timeEntry: ["approve"] },
  { rate: ["read"] },
  { rate: ["update"] },
  { organizationSettings: ["update"] },
  { auditLog: ["read"] },
  { dataExport: ["create"] },
  { dataExport: ["read"] },
  { agentSkill: ["propose"] },
  { firmMemory: ["update"] },
  { conflictCheck: ["run"] },
  { conflictCheck: ["review"] },
  { searchHistory: ["read"] },
  { signal: ["create"] },
  { signal: ["resolve"] },
];

const ALL_SAMPLE_PERMISSIONS: readonly PermissionInput[] = [
  ...NON_BILLING_PERMISSIONS,
  BILLING_READ_PERMISSION,
];

describe("workspace RBAC and permission-matrix properties", () => {
  test("role hierarchy is strictly monotonic from external to owner with server-client parity", () => {
    assertProperty(
      "role hierarchy is strictly monotonic from external to owner with server-client parity",
      fc.property(
        fc.constantFrom(...ALL_SAMPLE_PERMISSIONS),
        fc.constantFrom(...ROLE_PAIRS),
        (perm, [lower, higher]) => {
          const lowerAllowed = roleAllows(lower, perm);
          const higherAllowed = roleAllows(higher, perm);
          if (lowerAllowed) {
            expect(higherAllowed).toBe(true);
          }
          expect(
            memberHasPermissions({
              role: lower,
              billingAccess: false,
              permissions: perm,
            }),
          ).toBe(lowerAllowed);
          expect(
            memberHasPermissions({
              role: higher,
              billingAccess: false,
              permissions: perm,
            }),
          ).toBe(higherAllowed);
        },
      ),
    );
  });

  test("unknown and prototype-shaped role names always fail closed", () => {
    const unknownRoleArb = fc
      .oneof(
        fc.string({ minLength: 0, maxLength: 24 }),
        fc.constantFrom(
          "constructor",
          "__proto__",
          "toString",
          "valueOf",
          "OWNER",
          "Admin",
          "superadmin",
          "",
        ),
      )
      .filter(
        (candidate) =>
          !ORGANIZATION_ROLE_NAMES.some((valid) => valid === candidate),
      );

    assertProperty(
      "unknown and prototype-shaped role names always fail closed",
      fc.property(
        unknownRoleArb,
        fc.constantFrom(...ALL_SAMPLE_PERMISSIONS),
        (role, perm) => {
          expect(roleAllows(role, perm)).toBe(false);
        },
      ),
    );
  });

  test("billingAccess adds billing read without revoking grants or escalating non-billing privileges", () => {
    assertProperty(
      "billingAccess adds billing read without revoking grants or escalating non-billing privileges",
      fc.property(
        fc.constantFrom(...ORGANIZATION_ROLE_NAMES),
        fc.constantFrom(...NON_BILLING_PERMISSIONS),
        (role, perm) => {
          const withoutBilling = memberHasPermissions({
            role,
            billingAccess: false,
            permissions: perm,
          });
          const withBilling = memberHasPermissions({
            role,
            billingAccess: true,
            permissions: perm,
          });
          expect(withBilling).toBe(withoutBilling);
          expect(
            memberHasPermissions({
              role,
              billingAccess: true,
              permissions: BILLING_READ_PERMISSION,
            }),
          ).toBe(true);
          const combined = withBillingRead(perm);
          expect(combined.billing).toEqual(["read"]);
          expect(combined.workspace).toContain("read");
        },
      ),
    );
  });

  test("assignableRoles enforces strict management privilege ceiling", () => {
    assertProperty(
      "assignableRoles enforces strict management privilege ceiling",
      fc.property(fc.constantFrom(...ORGANIZATION_ROLE_NAMES), (actorRole) => {
        const assignable = assignableRoles(actorRole);
        if (actorRole === "owner") {
          expect(assignable).toEqual([...ORGANIZATION_ROLE_NAMES]);
        } else if (actorRole === "admin") {
          expect(assignable).not.toContain("owner");
          expect(assignable.length).toBe(ORGANIZATION_ROLE_NAMES.length - 1);
        } else {
          expect(assignable).toEqual([]);
        }
      }),
    );
  });
});
