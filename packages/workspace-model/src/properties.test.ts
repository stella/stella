import { describe, expect, test } from "bun:test";

import {
  isWorkspacePropertyType,
  resolveWorkspacePropertyOptionGroups,
  workspacePropertyDefinitionStatuses,
  workspacePropertyTypes,
} from "./properties";
import type {
  WorkspacePropertyOption,
  WorkspacePropertyOptionGroup,
} from "./properties";

const group = (id: string, sortOrder: number): WorkspacePropertyOptionGroup =>
  ({
    id,
    key: id,
    label: id,
    sortOrder,
  }) satisfies WorkspacePropertyOptionGroup;
const option = (
  id: string,
  sortOrder: number,
  groupId?: string,
): WorkspacePropertyOption => ({
  color: "gray",
  ...(groupId === undefined ? {} : { groupId }),
  id,
  key: id,
  label: id,
  sortOrder,
  status: "active",
});

describe("workspace property option groups", () => {
  const groups = [group("todo", 0), group("done", 1)];

  test("lays grouped options out as adjacent runs in sort order", () => {
    const resolved = resolveWorkspacePropertyOptionGroups({
      groups,
      options: [
        option("shipped", 3, "done"),
        option("backlog", 0),
        option("open", 1, "todo"),
        option("blocked", 2, "todo"),
      ],
    });

    expect(resolved.type).toBe("ok");
    if (resolved.type !== "ok") {
      return;
    }
    expect(
      resolved.spans.map((span) => [
        span.group?.id ?? null,
        span.options.map((candidate) => candidate.id),
      ]),
    ).toEqual([
      [null, ["backlog"]],
      ["todo", ["open", "blocked"]],
      ["done", ["shipped"]],
    ]);
  });

  test("reports an option whose group is not declared", () => {
    const resolved = resolveWorkspacePropertyOptionGroups({
      groups,
      options: [option("open", 0, "todo"), option("lost", 1, "missing")],
    });

    expect(resolved).toEqual({
      issues: [{ groupId: "missing", type: "undeclared-group" }],
      type: "invalid",
    });
  });

  test("reports a group whose options are split by another run", () => {
    const resolved = resolveWorkspacePropertyOptionGroups({
      groups,
      options: [
        option("open", 0, "todo"),
        option("shipped", 1, "done"),
        option("blocked", 2, "todo"),
      ],
    });

    expect(resolved).toEqual({
      issues: [{ groupId: "todo", type: "split-group" }],
      type: "invalid",
    });
  });

  test("treats a definition without groups as ungrouped runs", () => {
    const resolved = resolveWorkspacePropertyOptionGroups({
      options: [option("b", 1), option("a", 0)],
    });

    expect(resolved).toEqual({
      spans: [
        { group: null, options: [option("a", 0)] },
        { group: null, options: [option("b", 1)] },
      ],
      type: "ok",
    });
  });
});

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
