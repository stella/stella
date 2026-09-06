import { describe, expect, test } from "bun:test";

import {
  getInspectorTabGroupId,
  getInspectorTabMatterId,
  normalizeInspectorGroupAssignments,
  planInspectorTabDrop,
} from "@/components/inspector/inspector-groups.logic";
import type { InspectorTab } from "@/components/inspector/inspector-store-types";

const matterTabs = [
  {
    type: "task",
    id: "task-1",
    creationStatus: "ready",
    label: "Task",
    isNew: false,
    workspaceId: "workspace-1",
  },
  {
    type: "matter",
    id: "matter:workspace-1",
    label: "Matter",
    workspaceId: "workspace-1",
  },
  {
    type: "pdf",
    id: "field-1",
    entityId: "entity-1",
    label: "File",
    fileName: "file.pdf",
    pdfFileId: "file-1",
    workspaceId: "workspace-1",
  },
] satisfies InspectorTab[];

const dropTabs = [
  ...matterTabs,
  {
    type: "skill-resource",
    id: "skill-resource:one/body.md",
    label: "First loose tab",
    skillName: "one",
    skillId: null,
    origin: "authored",
    target: "body",
    resourcePath: "body.md",
    mimeType: "text/markdown",
    content: "",
  },
  {
    type: "skill-resource",
    id: "skill-resource:two/body.md",
    label: "Second loose tab",
    skillName: "two",
    skillId: null,
    origin: "authored",
    target: "body",
    resourcePath: "body.md",
    mimeType: "text/markdown",
    content: "",
  },
] satisfies InspectorTab[];

describe("inspector tab grouping", () => {
  test("every matter-bearing tab derives the same stable matter group", () => {
    for (const tab of matterTabs) {
      expect(getInspectorTabMatterId(tab)).toBe("workspace-1");
      expect(getInspectorTabGroupId({ groupAssignments: {} }, tab)).toBe(
        "matter:workspace-1",
      );
    }
  });

  test("an explicit assignment wins, including explicit ungrouping", () => {
    const tab = matterTabs[0];
    expect(
      getInspectorTabGroupId(
        { groupAssignments: { [tab.id]: "custom:review" } },
        tab,
      ),
    ).toBe("custom:review");
    expect(
      getInspectorTabGroupId({ groupAssignments: { [tab.id]: null } }, tab),
    ).toBeNull();
  });

  test("normalization removes missing tabs and explicitly ungroups dangling custom groups", () => {
    expect(
      normalizeInspectorGroupAssignments(
        matterTabs,
        [{ id: "custom:known", type: "custom", name: "Known", color: "blue" }],
        {
          "task-1": "custom:missing",
          "field-1": "custom:known",
          missing: "custom:known",
        },
      ),
    ).toEqual({ "task-1": null, "field-1": "custom:known" });
  });

  test("a tab moved into an otherwise empty matter survives normalization", () => {
    expect(
      normalizeInspectorGroupAssignments(matterTabs, [], {
        "task-1": "matter:workspace-elsewhere",
      }),
    ).toEqual({ "task-1": "matter:workspace-elsewhere" });
  });

  test("dropping onto an automatically grouped matter tab joins its matter", () => {
    expect(
      planInspectorTabDrop({
        state: { tabs: dropTabs, groupAssignments: {} },
        sourceId: "skill-resource:one/body.md",
        targetId: "task-1",
      }),
    ).toEqual({ type: "join", groupId: "matter:workspace-1" });
  });

  test("dropping onto a custom-group member joins its explicit group", () => {
    expect(
      planInspectorTabDrop({
        state: {
          tabs: dropTabs,
          groupAssignments: { "task-1": "custom:review" },
        },
        sourceId: "skill-resource:one/body.md",
        targetId: "task-1",
      }),
    ).toEqual({ type: "join", groupId: "custom:review" });
  });

  test("dropping onto default or explicitly ungrouped tabs creates a named group", () => {
    for (const groupAssignments of [
      {},
      { "skill-resource:two/body.md": null },
    ]) {
      expect(
        planInspectorTabDrop({
          state: { tabs: dropTabs, groupAssignments },
          sourceId: "skill-resource:one/body.md",
          targetId: "skill-resource:two/body.md",
        }),
      ).toEqual({ type: "create", name: "Second loose tab" });
    }
  });

  test("self-drops and stale tab IDs are ignored", () => {
    for (const [sourceId, targetId] of [
      ["task-1", "task-1"],
      ["missing", "task-1"],
      ["task-1", "missing"],
    ]) {
      expect(
        planInspectorTabDrop({
          state: { tabs: dropTabs, groupAssignments: {} },
          sourceId,
          targetId,
        }),
      ).toEqual({ type: "ignore" });
    }
  });

  test("dropping within the same automatic or custom group is ignored", () => {
    expect(
      planInspectorTabDrop({
        state: { tabs: dropTabs, groupAssignments: {} },
        sourceId: "field-1",
        targetId: "task-1",
      }),
    ).toEqual({ type: "ignore" });
    expect(
      planInspectorTabDrop({
        state: {
          tabs: dropTabs,
          groupAssignments: {
            "skill-resource:one/body.md": "custom:review",
            "skill-resource:two/body.md": "custom:review",
          },
        },
        sourceId: "skill-resource:one/body.md",
        targetId: "skill-resource:two/body.md",
      }),
    ).toEqual({ type: "ignore" });
  });
});
