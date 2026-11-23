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

const RESOURCE_ARBS = {
  organization: fc
    .subarray([...statements.organization], { minLength: 1 })
    .map((v): PermissionInput => ({ organization: v })),
  member: fc
    .subarray([...statements.member], { minLength: 1 })
    .map((v): PermissionInput => ({ member: v })),
  invitation: fc
    .subarray([...statements.invitation], { minLength: 1 })
    .map((v): PermissionInput => ({ invitation: v })),
  team: fc
    .subarray([...statements.team], { minLength: 1 })
    .map((v): PermissionInput => ({ team: v })),
  ac: fc
    .subarray([...statements.ac], { minLength: 1 })
    .map((v): PermissionInput => ({ ac: v })),
  legalHold: fc
    .subarray([...statements.legalHold], { minLength: 1 })
    .map((v): PermissionInput => ({ legalHold: v })),
  workspace: fc
    .subarray([...statements.workspace], { minLength: 1 })
    .map((v): PermissionInput => ({ workspace: v })),
  contact: fc
    .subarray([...statements.contact], { minLength: 1 })
    .map((v): PermissionInput => ({ contact: v })),
  invoice: fc
    .subarray([...statements.invoice], { minLength: 1 })
    .map((v): PermissionInput => ({ invoice: v })),
  template: fc
    .subarray([...statements.template], { minLength: 1 })
    .map((v): PermissionInput => ({ template: v })),
  styleSet: fc
    .subarray([...statements.styleSet], { minLength: 1 })
    .map((v): PermissionInput => ({ styleSet: v })),
  clause: fc
    .subarray([...statements.clause], { minLength: 1 })
    .map((v): PermissionInput => ({ clause: v })),
  entity: fc
    .subarray([...statements.entity], { minLength: 1 })
    .map((v): PermissionInput => ({ entity: v })),
  timeEntry: fc
    .subarray([...statements.timeEntry], { minLength: 1 })
    .map((v): PermissionInput => ({ timeEntry: v })),
  expense: fc
    .subarray([...statements.expense], { minLength: 1 })
    .map((v): PermissionInput => ({ expense: v })),
  view: fc
    .subarray([...statements.view], { minLength: 1 })
    .map((v): PermissionInput => ({ view: v })),
  property: fc
    .subarray([...statements.property], { minLength: 1 })
    .map((v): PermissionInput => ({ property: v })),
  playbook: fc
    .subarray([...statements.playbook], { minLength: 1 })
    .map((v): PermissionInput => ({ playbook: v })),
  flow: fc
    .subarray([...statements.flow], { minLength: 1 })
    .map((v): PermissionInput => ({ flow: v })),
  signal: fc
    .subarray([...statements.signal], { minLength: 1 })
    .map((v): PermissionInput => ({ signal: v })),
  billingCode: fc
    .subarray([...statements.billingCode], { minLength: 1 })
    .map((v): PermissionInput => ({ billingCode: v })),
  rate: fc
    .subarray([...statements.rate], { minLength: 1 })
    .map((v): PermissionInput => ({ rate: v })),
  billing: fc
    .subarray([...statements.billing], { minLength: 1 })
    .map((v): PermissionInput => ({ billing: v })),
  chat: fc
    .subarray([...statements.chat], { minLength: 1 })
    .map((v): PermissionInput => ({ chat: v })),
  organizationSettings: fc
    .subarray([...statements.organizationSettings], { minLength: 1 })
    .map((v): PermissionInput => ({ organizationSettings: v })),
  auditLog: fc
    .subarray([...statements.auditLog], { minLength: 1 })
    .map((v): PermissionInput => ({ auditLog: v })),
  dataExport: fc
    .subarray([...statements.dataExport], { minLength: 1 })
    .map((v): PermissionInput => ({ dataExport: v })),
  agentSkill: fc
    .subarray([...statements.agentSkill], { minLength: 1 })
    .map((v): PermissionInput => ({ agentSkill: v })),
  firmMemory: fc
    .subarray([...statements.firmMemory], { minLength: 1 })
    .map((v): PermissionInput => ({ firmMemory: v })),
  caseLawResearch: fc
    .subarray([...statements.caseLawResearch], { minLength: 1 })
    .map((v): PermissionInput => ({ caseLawResearch: v })),
  legalReaderAnnotation: fc
    .subarray([...statements.legalReaderAnnotation], { minLength: 1 })
    .map((v): PermissionInput => ({ legalReaderAnnotation: v })),
  savedSearch: fc
    .subarray([...statements.savedSearch], { minLength: 1 })
    .map((v): PermissionInput => ({ savedSearch: v })),
  searchHistory: fc
    .subarray([...statements.searchHistory], { minLength: 1 })
    .map((v): PermissionInput => ({ searchHistory: v })),
  integration: fc
    .subarray([...statements.integration], { minLength: 1 })
    .map((v): PermissionInput => ({ integration: v })),
  conflictCheck: fc
    .subarray([...statements.conflictCheck], { minLength: 1 })
    .map((v): PermissionInput => ({ conflictCheck: v })),
  dictationLearnedFix: fc
    .subarray([...statements.dictationLearnedFix], { minLength: 1 })
    .map((v): PermissionInput => ({ dictationLearnedFix: v })),
} satisfies Record<keyof typeof statements, fc.Arbitrary<PermissionInput>>;

const ALL_RESOURCE_ARBS: readonly fc.Arbitrary<PermissionInput>[] =
  Object.values(RESOURCE_ARBS);
const NON_BILLING_RESOURCE_ARBS: readonly fc.Arbitrary<PermissionInput>[] =
  Object.entries(RESOURCE_ARBS)
    .filter(([key]) => key !== "billing")
    .map(([, arb]) => arb);

const permissionInputArb = (
  pool: readonly fc.Arbitrary<PermissionInput>[] = ALL_RESOURCE_ARBS,
): fc.Arbitrary<PermissionInput> => {
  const single = fc.oneof(...pool);
  return fc
    .tuple(
      single,
      fc.option(single, { nil: undefined }),
      fc.option(single, { nil: undefined }),
    )
    .map(([first, second, third]): PermissionInput => ({
      ...first,
      ...second,
      ...third,
    }));
};

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

  test("billingAccess is monotonic", () => {
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
  });

  test("billingAccess never leaks non-billing permissions", () => {
    assertProperty(
      "billingAccess never leaks non-billing permissions",
      fc.property(
        roleArb,
        permissionInputArb(NON_BILLING_RESOURCE_ARBS),
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
      "role hierarchy: owner >= admin >= member for every permission set",
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
      "withBillingRead always requires billing read and deduplicated workspace read",
      fc.property(
        fc.subarray([...statements.workspace]),
        (workspaceActions) => {
          const required = withBillingRead(
            workspaceActions.length > 0
              ? { workspace: workspaceActions }
              : { invoice: ["update"] },
          );
          expect(required.billing).toEqual(["read"]);
          expect(required.workspace).toContain("read");
          expect(new Set(required.workspace).size).toBe(
            required.workspace.length,
          );
          for (const action of workspaceActions) {
            expect(required.workspace).toContain(action);
          }
        },
      ),
    );
  });

  test("assignableRoles prevents privilege escalation for every role", () => {
    assertProperty(
      "assignableRoles prevents privilege escalation for every role",
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
          expect(assignable).toContain("owner");
          expect(assignable).toContain("admin");
          expect(assignable).toContain("member");
        }
      }),
    );
  });
});
