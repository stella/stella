import { describe, expect, test } from "bun:test";

import type {
  InspectorTab,
  TaskTab,
} from "@/components/inspector/inspector-store-types";
import { closeTabsForDeletedEntities } from "@/components/inspector/inspector-tabs-slice";

const makeTaskTab = (id: string): TaskTab => ({
  type: "task",
  id,
  creationStatus: "ready",
  label: id,
  isNew: false,
  workspaceId: "workspace-1",
});

const tabs: InspectorTab[] = [
  makeTaskTab("task-1"),
  {
    type: "pdf",
    id: "field-1",
    entityId: "file-1",
    label: "File 1",
    fileName: "file-1.pdf",
    pdfFileId: "pdf-1",
    workspaceId: "workspace-1",
  },
  makeTaskTab("task-2"),
  {
    type: "pdf",
    id: "field-2",
    entityId: "file-2",
    label: "File 2",
    fileName: "file-2.pdf",
    pdfFileId: "pdf-2",
    workspaceId: "workspace-1",
  },
];

const entityIds = ["task-1", "file-1", "task-2", "file-2"] as const;

const deletionSubsets: string[][] = [[]];
for (const entityId of entityIds) {
  const existingSubsets = [...deletionSubsets];
  for (const subset of existingSubsets) {
    deletionSubsets.push([...subset, entityId]);
  }
}

const tabEntityId = (tab: InspectorTab): string | null => {
  if (tab.type === "pdf") {
    return tab.entityId;
  }
  if (tab.type === "task") {
    return tab.id;
  }
  return null;
};

describe("closing deleted inspector entities", () => {
  test("preserves tab-state invariants for every deletion subset", () => {
    for (const deleted of deletionSubsets) {
      const state = {
        tabs,
        activeId: "field-1",
        reviveSuggestion: tabs.at(-1) ?? null,
      };

      const result = closeTabsForDeletedEntities(state, deleted);
      const remainingIds = new Set(result.tabs.map((tab) => tab.id));

      expect(
        result.tabs.every((tab) => {
          const entityId = tabEntityId(tab);
          return entityId === null || !deleted.includes(entityId);
        }),
      ).toBe(true);
      expect(
        result.activeId === null || remainingIds.has(result.activeId),
      ).toBe(true);
      expect(
        result.reviveSuggestion === null ||
          !deleted.includes(tabEntityId(result.reviveSuggestion) ?? ""),
      ).toBe(true);
      expect(state.tabs).toBe(tabs);
    }
  });
});
