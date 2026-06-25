import { describe, expect, test } from "bun:test";

import { collectMissingAncestorIds } from "@/api/handlers/entities/read-filesystem-tree.logic";

describe("collectMissingAncestorIds", () => {
  test("backfills an ancestor folder hidden by the filter", () => {
    // A filtered view returns the selected root folder and a matching
    // grandchild, but the intermediate folder did not match and is absent.
    const matched = [
      { entityId: "root", parentId: null },
      { entityId: "grandchild", parentId: "intermediate" },
    ];
    const parentById = new Map<string, string | null>([
      ["root", null],
      ["intermediate", "root"],
      ["grandchild", "intermediate"],
    ]);

    expect(collectMissingAncestorIds(matched, parentById).map(String)).toEqual([
      "intermediate",
    ]);
  });

  test("returns nothing when every ancestor is already present", () => {
    const matched = [
      { entityId: "root", parentId: null },
      { entityId: "child", parentId: "root" },
    ];
    const parentById = new Map<string, string | null>([
      ["root", null],
      ["child", "root"],
    ]);

    expect(collectMissingAncestorIds(matched, parentById).map(String)).toEqual(
      [],
    );
  });

  test("dedupes a shared missing ancestor across several matches", () => {
    const matched = [
      { entityId: "a", parentId: "hidden" },
      { entityId: "b", parentId: "hidden" },
    ];
    const parentById = new Map<string, string | null>([
      ["hidden", "root"],
      ["root", null],
    ]);

    expect(collectMissingAncestorIds(matched, parentById).map(String)).toEqual([
      "hidden",
      "root",
    ]);
  });

  test("stops on a cyclic parent link", () => {
    const matched = [{ entityId: "x", parentId: "a" }];
    const parentById = new Map<string, string | null>([
      ["a", "b"],
      ["b", "a"],
    ]);

    expect(collectMissingAncestorIds(matched, parentById).map(String)).toEqual([
      "a",
      "b",
    ]);
  });
});
