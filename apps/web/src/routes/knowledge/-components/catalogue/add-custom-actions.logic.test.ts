import { describe, expect, test } from "bun:test";

import { addCustomActions } from "./add-custom-actions.logic";

describe("add custom actions", () => {
  test("a member who may create skills can start one from a blueprint", () => {
    expect(
      addCustomActions({ canManageCustomTools: false, canCreateSkills: true }),
    ).toEqual(["skill-blueprint", "skill-import"]);
  });

  test("an admin gets every action", () => {
    expect(
      addCustomActions({ canManageCustomTools: true, canCreateSkills: true }),
    ).toEqual(["mcp", "skill-blueprint", "skill-import"]);
  });

  test("a role without skill creation gets no skill actions", () => {
    expect(
      addCustomActions({ canManageCustomTools: false, canCreateSkills: false }),
    ).toEqual([]);
  });
});
