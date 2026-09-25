import { describe, expect, test } from "bun:test";

import { BETTER_AUTH_ORGANIZATION_STATEMENTS } from "@stll/auth-model";

import type { PermissionInput } from "./index";
import {
  isOrganizationManagementRole,
  ORGANIZATION_MANAGEMENT_ROLES,
  roles,
  statements,
} from "./index";

const ROLE_NAMES = ["owner", "admin", "member", "intern", "external"] as const;

/** The product resources, without the Better Auth organization statements. */
const stellaStatements = Object.entries(statements).filter(
  ([resource]) => !(resource in BETTER_AUTH_ORGANIZATION_STATEMENTS),
);

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

describe("organization management roles", () => {
  test("are exactly the roles holding the management grants", () => {
    const holdersOfManagementGrants = ROLE_NAMES.filter(
      (role) =>
        roles[role].authorize({ organizationSettings: ["update"] }).success,
    );

    expect(ORGANIZATION_MANAGEMENT_ROLES.toSorted()).toEqual(
      holdersOfManagementGrants.toSorted(),
    );
    for (const role of ROLE_NAMES) {
      expect(isOrganizationManagementRole(role)).toBe(
        holdersOfManagementGrants.some((holder) => holder === role),
      );
    }
    expect(isOrganizationManagementRole("superuser")).toBe(false);
  });
});

describe("role grant boundaries", () => {
  // Pins the security-critical boundaries between roles so a future grant
  // edit cannot silently widen a low-privilege role.
  test("only owner and admin hold org-admin powers", () => {
    for (const role of ["member", "intern", "external"] as const) {
      expect(roles[role].authorize({ member: ["create"] }).success).toBe(false);
      expect(roles[role].authorize({ member: ["delete"] }).success).toBe(false);
      expect(roles[role].authorize({ organization: ["delete"] }).success).toBe(
        false,
      );
      expect(roles[role].authorize({ invitation: ["create"] }).success).toBe(
        false,
      );
    }
    for (const role of ["owner", "admin"] as const) {
      expect(roles[role].authorize({ member: ["create"] }).success).toBe(true);
      expect(roles[role].authorize({ invitation: ["create"] }).success).toBe(
        true,
      );
    }
  });

  test("member can write content; intern and external cannot", () => {
    expect(roles.member.authorize({ entity: ["update"] }).success).toBe(true);
    expect(roles.member.authorize({ invoice: ["create"] }).success).toBe(true);
    for (const role of ["intern", "external"] as const) {
      expect(roles[role].authorize({ entity: ["update"] }).success).toBe(false);
      expect(roles[role].authorize({ invoice: ["create"] }).success).toBe(
        false,
      );
      expect(roles[role].authorize({ template: ["update"] }).success).toBe(
        false,
      );
    }
  });

  test("intern may fill templates but not author; external cannot fill", () => {
    // The dedicated `use` grant lets a paralegal-style role generate
    // documents from templates without any authoring rights.
    expect(roles.intern.authorize({ template: ["use"] }).success).toBe(true);
    for (const action of ["create", "update", "delete"] as const) {
      expect(roles.intern.authorize({ template: [action] }).success).toBe(
        false,
      );
    }

    // External collaborators stay read-only: no filling firm templates.
    expect(roles.external.authorize({ template: ["use"] }).success).toBe(false);

    // Staff roles keep full template access, including `use`.
    for (const role of ["owner", "admin", "member"] as const) {
      expect(roles[role].authorize({ template: ["use"] }).success).toBe(true);
    }
  });

  test("staff can manage style sets; interns may use them; externals cannot", () => {
    for (const role of ["owner", "admin", "member"] as const) {
      for (const action of ["use", "create", "update", "delete"] as const) {
        expect(roles[role].authorize({ styleSet: [action] }).success).toBe(
          true,
        );
      }
    }
    expect(roles.intern.authorize({ styleSet: ["use"] }).success).toBe(true);
    expect(roles.intern.authorize({ styleSet: ["create"] }).success).toBe(
      false,
    );
    expect(roles.external.authorize({ styleSet: ["use"] }).success).toBe(false);
  });

  test("only owner and admin can approve playbooks", () => {
    for (const role of ["owner", "admin"] as const) {
      expect(roles[role].authorize({ playbook: ["approve"] }).success).toBe(
        true,
      );
    }
    for (const role of ["member", "intern", "external"] as const) {
      expect(roles[role].authorize({ playbook: ["approve"] }).success).toBe(
        false,
      );
    }
  });

  test("staff can author, run, and review workflows; intern and external cannot", () => {
    for (const role of ["owner", "admin", "member"] as const) {
      for (const action of [
        "create",
        "update",
        "delete",
        "run",
        "review",
      ] as const) {
        expect(roles[role].authorize({ flow: [action] }).success).toBe(true);
      }
    }
    for (const role of ["intern", "external"] as const) {
      expect(roles[role].authorize({ flow: ["run"] }).success).toBe(false);
      expect(roles[role].authorize({ flow: ["create"] }).success).toBe(false);
      expect(roles[role].authorize({ flow: ["review"] }).success).toBe(false);
    }
  });

  test("only owner and admin can manage firm memory", () => {
    for (const role of ["owner", "admin"] as const) {
      expect(roles[role].authorize({ firmMemory: ["create"] }).success).toBe(
        true,
      );
      expect(roles[role].authorize({ firmMemory: ["update"] }).success).toBe(
        true,
      );
    }
    for (const role of ["member", "intern", "external"] as const) {
      expect(roles[role].authorize({ firmMemory: ["create"] }).success).toBe(
        false,
      );
      expect(roles[role].authorize({ firmMemory: ["update"] }).success).toBe(
        false,
      );
    }
  });

  test("every role can read its workspace", () => {
    for (const role of ROLE_NAMES) {
      expect(roles[role].authorize({ workspace: ["read"] }).success).toBe(true);
    }
  });

  // The matrix is total by construction on the resource axis (every grant map
  // is `satisfies StellaPermissionMap`, so a new resource must appear in each
  // one), but nothing at compile time covers the ACTION axis: adding an action
  // to `statements` and forgetting it in every grant map leaves it held by no
  // role, so the handler that declares it answers 403 to everyone forever.
  // Management holds every product action today; that is the totality anchor.
  test("owner and admin hold every declared product action", () => {
    const declared = stellaStatements.flatMap(([resource, actions]) =>
      actions.map((action) => `${resource}:${action}`),
    );

    for (const role of ["owner", "admin"] as const) {
      const held = new Set(
        Object.entries(roles[role].statements).flatMap(([resource, actions]) =>
          actions.map((action) => `${resource}:${action}`),
        ),
      );

      expect(declared.filter((action) => !held.has(action))).toEqual([]);
    }
  });

  test("staff author and run case-law research; intern and external cannot", () => {
    const researchActions = ["create", "update", "delete", "run"] as const;
    for (const role of ["owner", "admin", "member"] as const) {
      for (const action of researchActions) {
        expect(
          roles[role].authorize({ caseLawResearch: [action] }).success,
        ).toBe(true);
      }
    }
    // Question columns are organization data and every run spends AI budget,
    // so the roles that hold no authoring grant elsewhere hold none here.
    for (const role of ["intern", "external"] as const) {
      for (const action of researchActions) {
        expect(
          roles[role].authorize({ caseLawResearch: [action] }).success,
        ).toBe(false);
      }
    }
  });

  test("everyone but an external collaborator keeps their own work", () => {
    // Annotations, stored searches and account links are the caller's own
    // work, so they follow the time entry / expense / chat line rather than
    // the authoring line: staff and interns hold them, external
    // collaborators hold no write grant at all.
    const ownWorkGrants: { permissions: PermissionInput; resource: string }[] =
      [
        {
          permissions: {
            legalReaderAnnotation: ["create", "update", "delete"],
          },
          resource: "legalReaderAnnotation",
        },
        {
          permissions: { savedSearch: ["create", "update", "delete"] },
          resource: "savedSearch",
        },
        {
          permissions: { integration: ["create", "update", "delete"] },
          resource: "integration",
        },
      ];

    for (const { permissions, resource } of ownWorkGrants) {
      for (const role of ["owner", "admin", "member", "intern"] as const) {
        expect({
          resource,
          role,
          granted: roles[role].authorize(permissions).success,
        }).toEqual({ resource, role, granted: true });
      }
      expect({
        resource,
        granted: roles.external.authorize(permissions).success,
      }).toEqual({ resource, granted: false });
    }
  });

  test("time entry and rate permissions separate timekeepers from reviewers", () => {
    expect(roles.external.authorize({ timeEntry: ["read"] }).success).toBe(
      false,
    );
    expect(roles.external.authorize({ timeEntry: ["create"] }).success).toBe(
      false,
    );
    expect(roles.external.authorize({ expense: ["create"] }).success).toBe(
      false,
    );
    expect(roles.intern.authorize({ timeEntry: ["create"] }).success).toBe(
      true,
    );
    expect(roles.member.authorize({ timeEntry: ["approve"] }).success).toBe(
      false,
    );
    expect(roles.admin.authorize({ timeEntry: ["approve"] }).success).toBe(
      true,
    );
    expect(roles.member.authorize({ rate: ["read"] }).success).toBe(false);
    expect(roles.owner.authorize({ rate: ["read"] }).success).toBe(true);
  });
});
