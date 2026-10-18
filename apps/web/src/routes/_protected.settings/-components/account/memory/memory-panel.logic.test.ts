import { describe, expect, test } from "bun:test";

import { canManageMatterMemory } from "./memory-panel.logic";

describe("matter memory management access", () => {
  test("keeps archived matters read-only for users with update permission", () => {
    expect(canManageMatterMemory({ canManage: true, status: "archived" })).toBe(
      false,
    );
  });

  test("allows controls only for permitted active matters", () => {
    expect(canManageMatterMemory({ canManage: true, status: "active" })).toBe(
      true,
    );
    expect(canManageMatterMemory({ canManage: false, status: "active" })).toBe(
      false,
    );
  });
});
