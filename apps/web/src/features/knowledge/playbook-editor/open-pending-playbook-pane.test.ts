import { expect, test } from "bun:test";
import { createStore } from "zustand";
import { immer } from "zustand/middleware/immer";

import type { InspectorTabsStore } from "@/components/inspector/inspector-store-types";
import { createInspectorTabsSlice } from "@/components/inspector/inspector-tabs-slice";
import "@/features/knowledge/playbook-editor/playbook-draft-view-registration";
import {
  PLAYBOOK_DRAFT_VIEW,
  playbookDraftTabId,
} from "@/lib/knowledge/playbook-draft-view";

import { openPendingPlaybookPane } from "./open-pending-playbook-pane";

const makeStore = () =>
  createStore<InspectorTabsStore>()(
    immer((set, get) => createInspectorTabsSlice(set, get)),
  );

const playbookPanes = (store: ReturnType<typeof makeStore>) =>
  store
    .getState()
    .tabs.flatMap((tab) =>
      tab.type === "view" && tab.viewType === PLAYBOOK_DRAFT_VIEW
        ? [{ id: tab.id, payload: tab.payload }]
        : [],
    );

const open = (store: ReturnType<typeof makeStore>, threadId: string) =>
  openPendingPlaybookPane({
    inspector: store.getState(),
    threadId,
    label: "Playbook",
  });

test("each new build replaces the pending pane of the one before it", () => {
  const store = makeStore();
  for (const threadId of ["thread-1", "thread-2", "thread-3"]) {
    open(store, threadId);
    expect(playbookPanes(store)).toEqual([
      { id: playbookDraftTabId(threadId), payload: { type: "pending" } },
    ]);
    expect(store.getState().activeId).toBe(playbookDraftTabId(threadId));
  }
});

test("a new build leaves another thread's saved playbook open", () => {
  const store = makeStore();
  const saved = { type: "playbook", playbookId: "playbook-1" } as const;
  store.getState().openView({
    type: PLAYBOOK_DRAFT_VIEW,
    id: playbookDraftTabId("thread-1"),
    label: "NDA playbook",
    payload: saved,
  });

  open(store, "thread-2");

  expect(playbookPanes(store)).toEqual([
    { id: playbookDraftTabId("thread-1"), payload: saved },
    { id: playbookDraftTabId("thread-2"), payload: { type: "pending" } },
  ]);
});

test("the first save turns the pending pane into the editor without a leave prompt", () => {
  const store = makeStore();
  open(store, "thread-1");
  const saved = { type: "playbook", playbookId: "playbook-1" } as const;

  store.getState().updateView({
    id: playbookDraftTabId("thread-1"),
    label: "NDA playbook",
    payload: saved,
  });

  expect(playbookPanes(store)).toEqual([
    { id: playbookDraftTabId("thread-1"), payload: saved },
  ]);
});
