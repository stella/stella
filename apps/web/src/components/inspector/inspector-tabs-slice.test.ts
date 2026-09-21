import { describe, expect, test } from "bun:test";
import { createStore } from "zustand";
import { immer } from "zustand/middleware/immer";

import { INSPECTOR_PANE_INTENT } from "@/components/inspector/inspector-store-types";
import type {
  InspectorTab,
  InspectorTabsStore,
  TaskTab,
} from "@/components/inspector/inspector-store-types";
import {
  closeTabsForDeletedEntities,
  createInspectorTabsSlice,
} from "@/components/inspector/inspector-tabs-slice";
import { toChatThreadId } from "@/lib/chat-thread-ref";

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
        groupAssignments: {},
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

const createMinimizedStore = () => {
  const store = createStore<InspectorTabsStore>()(
    immer((set) => createInspectorTabsSlice(set)),
  );
  store.setState({ minimized: true });
  return store;
};

const chatTabId = toChatThreadId("chat-1");

const detailsTabArgs = {
  type: "case-law-decision-details",
  id: "case-law-decision-details:decision-1",
  label: "Decision 1",
  payload: { decisionId: "decision-1" },
};

describe("opening a tab without taking the pane", () => {
  test("openView with pane keep adds and activates the tab, pane stays collapsed", () => {
    const store = createMinimizedStore();

    store.getState().openView({
      ...detailsTabArgs,
      pane: INSPECTOR_PANE_INTENT.keep,
    });

    const state = store.getState();
    expect(state.minimized).toBe(true);
    expect(state.activeId).toBe(detailsTabArgs.id);
    expect(state.tabs.map((tab) => tab.id)).toEqual([detailsTabArgs.id]);
  });

  test("openView expands the pane by default", () => {
    const store = createMinimizedStore();

    store.getState().openView(detailsTabArgs);

    expect(store.getState().minimized).toBe(false);
  });

  test("openChat with pane keep adds and activates the tab, pane stays collapsed", () => {
    const store = createMinimizedStore();

    store.getState().openChat({
      id: chatTabId,
      label: "Decision chat",
      pane: INSPECTOR_PANE_INTENT.keep,
    });

    const state = store.getState();
    expect(state.minimized).toBe(true);
    expect(state.activeId).toBe(chatTabId);
    expect(state.tabs.map((tab) => tab.id)).toEqual([chatTabId]);
  });

  test("openChat expands the pane by default", () => {
    const store = createMinimizedStore();

    store.getState().openChat({ id: chatTabId });

    expect(store.getState().minimized).toBe(false);
  });
});
