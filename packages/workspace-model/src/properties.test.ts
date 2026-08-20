import { describe, expect, test } from "bun:test";

import {
  isWorkspacePropertyType,
  workspacePropertyDefinitionStatuses,
  workspacePropertyTypes,
} from "./properties";

describe("workspace property model", () => {
  test("publishes each property discriminator exactly once", () => {
    expect(new Set(workspacePropertyTypes).size).toBe(
      workspacePropertyTypes.length,
    );
    expect(workspacePropertyTypes).toEqual([
      "file",
      "text",
      "single-select",
      "multi-select",
      "date",
      "int",
      "money",
      "person",
    ]);
  });

  test("recognizes only declared property types", () => {
    for (const type of workspacePropertyTypes) {
      expect(isWorkspacePropertyType(type)).toBe(true);
    }
    expect(isWorkspacePropertyType("checkbox")).toBe(false);
  });

  test("keeps lifecycle status explicit", () => {
    expect(workspacePropertyDefinitionStatuses).toEqual(["active", "archived"]);
  });
});
