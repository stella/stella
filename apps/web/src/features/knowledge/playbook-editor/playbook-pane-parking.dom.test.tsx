import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";
import { createStore } from "zustand";
import { immer } from "zustand/middleware/immer";

import type { InspectorTabsStore } from "@/components/inspector/inspector-store-types";
import messages from "@/i18n/langs/en.json";

import type { ParkedPlaybookPane } from "./playbook-pane-parking";

GlobalRegistrator.register({ url: "http://localhost:3000" });
const { cleanup, render, fireEvent, act } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { createInspectorTabsSlice } =
  await import("@/components/inspector/inspector-tabs-slice");
const { PlaybookPaneLeaveConfirmation } =
  await import("./playbook-pane-leave-confirmation");
const {
  parkPlaybookPane,
  readParkedPlaybookPane,
  discardParkedPlaybookPane,
  registerPlaybookPaneLeaveGuard,
  cancelPlaybookPaneLeave,
} = await import("./playbook-pane-parking");
const { createPlaybookBaseline } = await import("./playbook-editor.logic");
const { PLAYBOOK_DRAFT_VIEW } =
  await import("@/lib/knowledge/playbook-draft-view");
await import("./playbook-draft-view-registration");

const tabIds = new Set<string>();
const unregisterGuards: (() => void)[] = [];
const makeStore = () =>
  createStore<InspectorTabsStore>()(
    immer((set, get) => createInspectorTabsSlice(set, get)),
  );

const openPlaybook = (
  store: ReturnType<typeof makeStore>,
  tabId: string,
  playbookId: string,
) => {
  tabIds.add(tabId);
  store.getState().openView({
    id: tabId,
    type: PLAYBOOK_DRAFT_VIEW,
    label: playbookId,
    payload: { type: "playbook", playbookId },
  });
};

const parkedState = (
  playbookId: string,
  requiresLeaveConfirmation = false,
): ParkedPlaybookPane => {
  const draft = {
    name: `Draft ${playbookId}`,
    description: "Unsaved description",
    documentTypeKey: null,
    perspective: null,
    trigger: null,
    positions: [],
  };
  return {
    playbookId,
    draft,
    baseline: createPlaybookBaseline({ ...draft, description: "" }),
    updatedAt: "2026-10-08T08:00:00.000Z",
    status: "approved",
    approvedAt: "2026-10-08T08:00:00.000Z",
    openIds: new Set(),
    revealedIds: new Set(),
    scrollTop: 42,
    requiresLeaveConfirmation,
  };
};

const renderConfirmation = () =>
  render(
    <IntlProvider locale="en" messages={messages}>
      <PlaybookPaneLeaveConfirmation />
    </IntlProvider>,
  );

const park = (
  store: ReturnType<typeof makeStore>,
  tabId: string,
  state: ParkedPlaybookPane,
) => {
  tabIds.add(tabId);
  parkPlaybookPane({
    tabId,
    state,
    isTabOpen: (id) => store.getState().tabs.some((tab) => tab.id === id),
  });
};

afterEach(() => {
  cleanup();
  for (const unregister of unregisterGuards.splice(0)) unregister();
  for (const tabId of tabIds) discardParkedPlaybookPane(tabId);
  tabIds.clear();
  cancelPlaybookPaneLeave();
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

test("closing a dirty pane keeps the tab when cancelled and closes only after confirmation", async () => {
  const store = makeStore();
  openPlaybook(store, "close-dirty", "approved-playbook");
  unregisterGuards.push(
    registerPlaybookPaneLeaveGuard({
      tabId: "close-dirty",
      playbookId: "approved-playbook",
      shouldConfirm: () => true,
    }),
  );
  const view = renderConfirmation();
  await act(async () => {
    store.getState().closeTab("close-dirty");
  });
  expect(store.getState().tabs).toHaveLength(1);
  await act(async () => {
    fireEvent.click(
      view.getByRole("button", { name: messages.common.goBackToEditing }),
    );
  });
  expect(store.getState().tabs).toHaveLength(1);
  await act(async () => {
    store.getState().closeTab("close-dirty");
  });
  await act(async () => {
    fireEvent.click(
      view.getByRole("button", { name: messages.common.leaveAndDiscard }),
    );
  });
  expect(store.getState().tabs).toHaveLength(0);
});

test("a model retarget confirms another playbook while preserving the parked drafts independently", async () => {
  const store = makeStore();
  const tabId = "model-retarget";
  openPlaybook(store, tabId, "first");
  const first = parkedState("first", true);
  const second = parkedState("second");
  park(store, tabId, first);
  park(store, tabId, second);
  const view = renderConfirmation();
  const retarget = () =>
    store.getState().updateView({
      id: tabId,
      label: "second",
      payload: { type: "playbook", playbookId: "second" },
    });
  await act(async () => {
    retarget();
  });
  expect(store.getState().tabs.at(0)).toMatchObject({
    payload: { playbookId: "first" },
  });
  await act(async () => {
    fireEvent.click(
      view.getByRole("button", { name: messages.common.goBackToEditing }),
    );
  });
  expect(store.getState().tabs.at(0)).toMatchObject({
    payload: { playbookId: "first" },
  });
  await act(async () => {
    retarget();
  });
  await act(async () => {
    fireEvent.click(
      view.getByRole("button", { name: messages.common.leaveAndDiscard }),
    );
  });
  expect(store.getState().tabs.at(0)).toMatchObject({
    payload: { playbookId: "second" },
  });
  expect(readParkedPlaybookPane(tabId, "first")).toEqual(first);
  expect(readParkedPlaybookPane(tabId, "second")).toEqual(second);
});

test("closing an inactive parked tab clears all its playbooks and preserves another tab", () => {
  const store = makeStore();
  openPlaybook(store, "inactive", "first");
  park(store, "inactive", parkedState("first"));
  park(store, "inactive", parkedState("second"));
  openPlaybook(store, "active", "first");
  const activeDraft = parkedState("first");
  park(store, "active", activeDraft);
  expect(store.getState().activeId).toBe("active");
  store.getState().closeTab("inactive");
  expect(readParkedPlaybookPane("inactive", "first")).toBeNull();
  expect(readParkedPlaybookPane("inactive", "second")).toBeNull();
  expect(readParkedPlaybookPane("active", "first")).toEqual(activeDraft);
  expect(store.getState().activeId).toBe("active");
});

test("parking drafts is isolated by both tab and playbook", () => {
  const store = makeStore();
  openPlaybook(store, "tab-a", "first");
  openPlaybook(store, "tab-b", "first");
  const tabAFirst = parkedState("first");
  const tabASecond = parkedState("second");
  const tabBFirst = { ...parkedState("first"), scrollTop: 99 };
  park(store, "tab-a", tabAFirst);
  park(store, "tab-a", tabASecond);
  park(store, "tab-b", tabBFirst);
  expect(readParkedPlaybookPane("tab-a", "first")).toEqual(tabAFirst);
  expect(readParkedPlaybookPane("tab-a", "second")).toEqual(tabASecond);
  expect(readParkedPlaybookPane("tab-b", "first")).toEqual(tabBFirst);
  expect(readParkedPlaybookPane("tab-b", "second")).toBeNull();
});
