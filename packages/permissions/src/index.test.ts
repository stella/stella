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

  test("every role can read its workspace", () => {
    for (const role of [
      "owner",
      "admin",
      "member",
      "intern",
      "external",
    ] as const) {
      expect(roles[role].authorize({ workspace: ["read"] }).success).toBe(true);
    }
  });

  test("external is read-only; intern may log its own time", () => {
    expect(roles.external.authorize({ timeEntry: ["create"] }).success).toBe(
      false,
    );
    expect(roles.external.authorize({ expense: ["create"] }).success).toBe(
      false,
    );
    expect(roles.intern.authorize({ timeEntry: ["create"] }).success).toBe(
      true,
    );
  });
});
