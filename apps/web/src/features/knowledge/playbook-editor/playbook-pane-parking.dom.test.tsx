import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";
import { createStore } from "zustand";
import { immer } from "zustand/middleware/immer";

import type { InspectorTabsStore } from "@/components/inspector/inspector-store-types";
import messages from "@/i18n/langs/en.json";

import type { PlaybookSnapshot } from "./playbook-editor-sync.logic";
import type { ParkedPlaybookPane } from "./playbook-pane-parking";
import type { SaveOutcome, SendSaveArgs } from "./use-playbook-save-queue";

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
  usePlaybookPaneLeave,
  completeParkedPlaybookPaneSave,
} = await import("./playbook-pane-parking");
const { createPlaybookBaseline, hasPlaybookDraftChanges } =
  await import("./playbook-editor.logic");
const { resolveServerFollow, draftToAdopt } =
  await import("./playbook-editor-sync.logic");
const { usePlaybookSaveQueue } = await import("./use-playbook-save-queue");
const { useMountEffect } = await import("@/hooks/use-effect");
const { useState } = await import("react");
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
  for (const unregister of unregisterGuards.splice(0)) {
    unregister();
  }
  for (const tabId of tabIds) {
    discardParkedPlaybookPane(tabId);
  }
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

type BulkCloseConfirmationOptions = {
  close: (store: ReturnType<typeof makeStore>) => void;
  remainingIds: readonly string[];
};

const assertBulkCloseConfirmation = async ({
  close,
  remainingIds,
}: BulkCloseConfirmationOptions) => {
  const store = makeStore();
  openPlaybook(store, "bulk-dirty", "dirty-playbook");
  openPlaybook(store, "bulk-clean", "clean-playbook");
  openPlaybook(store, "bulk-kept", "kept-playbook");
  const dirty = parkedState("dirty-playbook", true);
  const clean = parkedState("clean-playbook");
  const kept = parkedState("kept-playbook");
  park(store, "bulk-dirty", dirty);
  park(store, "bulk-dirty", parkedState("other-parked-playbook"));
  park(store, "bulk-clean", clean);
  park(store, "bulk-kept", kept);
  unregisterGuards.push(
    registerPlaybookPaneLeaveGuard({
      tabId: "bulk-dirty",
      playbookId: "dirty-playbook",
      shouldConfirm: () => true,
    }),
  );
  const originalIds = store.getState().tabs.map((tab) => tab.id);
  const view = renderConfirmation();
  await act(async () => {
    close(store);
  });
  expect(store.getState().tabs.map((tab) => tab.id)).toEqual(originalIds);
  await act(async () => {
    fireEvent.click(
      view.getByRole("button", { name: messages.common.goBackToEditing }),
    );
  });
  expect(store.getState().tabs.map((tab) => tab.id)).toEqual(originalIds);
  expect(readParkedPlaybookPane("bulk-dirty", "dirty-playbook")).toEqual(dirty);
  expect(readParkedPlaybookPane("bulk-clean", "clean-playbook")).toEqual(clean);
  expect(readParkedPlaybookPane("bulk-kept", "kept-playbook")).toEqual(kept);
  await act(async () => {
    close(store);
  });
  await act(async () => {
    fireEvent.click(
      view.getByRole("button", { name: messages.common.leaveAndDiscard }),
    );
  });
  expect(store.getState().tabs.map((tab) => tab.id)).toEqual(remainingIds);
  expect(store.getState().activeId).toBe(remainingIds.at(0) ?? null);
  expect(readParkedPlaybookPane("bulk-dirty", "dirty-playbook")).toBeNull();
  expect(
    readParkedPlaybookPane("bulk-dirty", "other-parked-playbook"),
  ).toBeNull();
  expect(readParkedPlaybookPane("bulk-clean", "clean-playbook")).toBeNull();
  expect(readParkedPlaybookPane("bulk-kept", "kept-playbook")).toEqual(
    remainingIds.includes("bulk-kept") ? kept : null,
  );
};

test("closing other tabs confirms dirty drafts and preserves the selected tab", async () => {
  await assertBulkCloseConfirmation({
    close: (store) => store.getState().closeOthers("bulk-kept"),
    remainingIds: ["bulk-kept"],
  });
});

test("closing all tabs confirms dirty drafts and clears every parked tab", async () => {
  await assertBulkCloseConfirmation({
    close: (store) => store.getState().closeAll(),
    remainingIds: [],
  });
});

test("closeAll obtains fresh confirmation for a dirty tab opened while confirmation was pending", async () => {
  const store = makeStore();
  openPlaybook(store, "race-original", "original-playbook");
  park(store, "race-original", parkedState("original-playbook", true));
  unregisterGuards.push(
    registerPlaybookPaneLeaveGuard({
      tabId: "race-original",
      playbookId: "original-playbook",
      shouldConfirm: () => true,
    }),
  );
  const view = renderConfirmation();
  await act(async () => {
    store.getState().closeAll();
  });
  openPlaybook(store, "race-late", "late-playbook");
  park(store, "race-late", parkedState("late-playbook", true));
  unregisterGuards.push(
    registerPlaybookPaneLeaveGuard({
      tabId: "race-late",
      playbookId: "late-playbook",
      shouldConfirm: () => true,
    }),
  );
  const expectedPrompts = ["race-original", "race-original", "race-late"];
  let confirmed = 0;
  for (const tabId of expectedPrompts) {
    expect(usePlaybookPaneLeave.getState()).toMatchObject({
      type: "confirm",
      tabId,
    });
    expect(store.getState().tabs.map((tab) => tab.id)).toEqual([
      "race-original",
      "race-late",
    ]);
    expect(readParkedPlaybookPane("race-late", "late-playbook")).not.toBeNull();
    await act(async () => {
      fireEvent.click(
        view.getByRole("button", { name: messages.common.leaveAndDiscard }),
      );
    });
    confirmed += 1;
  }
  expect(confirmed).toBe(3);
  expect(store.getState().tabs).toHaveLength(0);
  expect(usePlaybookPaneLeave.getState()).toEqual({ type: "idle" });
  expect(
    readParkedPlaybookPane("race-original", "original-playbook"),
  ).toBeNull();
  expect(readParkedPlaybookPane("race-late", "late-playbook")).toBeNull();
});

type ParkedSaveHarnessProps = {
  tabId: string;
  seed: ParkedPlaybookPane;
  server: PlaybookSnapshot;
  sendSave: (args: SendSaveArgs) => Promise<SaveOutcome>;
  requests: Promise<unknown>[];
};

const ParkedSaveHarness = ({
  tabId,
  seed,
  server,
  sendSave,
  requests,
}: ParkedSaveHarnessProps) => {
  const [initial] = useState(
    () => readParkedPlaybookPane(tabId, seed.playbookId) ?? seed,
  );
  const follow = resolveServerFollow({
    formUpdatedAt: initial.updatedAt,
    serverUpdatedAt: server.updatedAt,
    isDirty: hasPlaybookDraftChanges({
      baseline: initial.baseline,
      current: initial.draft,
    }),
  });
  const adopted = draftToAdopt({
    follow,
    whenBehind: "rebase",
    baseline: initial.baseline.draft,
    local: initial.draft,
    server: server.draft,
  });
  const draft = adopted ?? initial.draft;
  const baseline =
    adopted === null ? initial.baseline : createPlaybookBaseline(server.draft);
  const updatedAt = adopted === null ? initial.updatedAt : server.updatedAt;
  const { flushOnLeave } = usePlaybookSaveQueue({ updatedAt, sendSave });
  useMountEffect(() => () => {
    const parked = { ...initial, draft, baseline, updatedAt };
    parkPlaybookPane({ tabId, state: parked, isTabOpen: () => true });
    const request = flushOnLeave({
      draft,
      isDirty: hasPlaybookDraftChanges({ baseline, current: draft }),
      canSaveDraft: true,
    });
    if (request === null) {
      return;
    }
    requests.push(
      request.then(({ outcome }) => {
        if (outcome.type === "saved") {
          completeParkedPlaybookPaneSave({
            tabId,
            parkedState: parked,
            updatedAt: outcome.updatedAt,
          });
        }
        return outcome;
      }),
    );
  });
  return <output>{draft.description}</output>;
};

test("a hidden pane's completed flush refreshes its baseline so reopening follows a newer same-field server edit", async () => {
  const tabId = "completed-hidden-flush";
  tabIds.add(tabId);
  const seed = {
    ...parkedState("saved-playbook", true),
    status: "draft",
    approvedAt: null,
  } as const satisfies ParkedPlaybookPane;
  const response = Promise.withResolvers<SaveOutcome>();
  const sent: SendSaveArgs[] = [];
  const requests: Promise<unknown>[] = [];
  const sendSave = (args: SendSaveArgs) => {
    sent.push(args);
    return response.promise;
  };
  const server = {
    draft: seed.baseline.draft,
    updatedAt: seed.updatedAt,
    status: "draft",
    approvedAt: null,
  } as const satisfies PlaybookSnapshot;
  const view = render(
    <ParkedSaveHarness
      tabId={tabId}
      seed={seed}
      server={server}
      sendSave={sendSave}
      requests={requests}
    />,
  );
  view.unmount();
  expect(sent).toHaveLength(1);
  const pending = readParkedPlaybookPane(tabId, seed.playbookId);
  expect(pending).not.toBeNull();
  expect(pending?.baseline).toBe(seed.baseline);
  const savedAt = "2026-10-08T08:01:00.000Z";
  await act(async () => {
    response.resolve({ type: "saved", updatedAt: savedAt });
    await Promise.all(requests);
  });
  const saved = readParkedPlaybookPane(tabId, seed.playbookId);
  expect(saved).toMatchObject({
    updatedAt: savedAt,
    status: "draft",
    approvedAt: null,
    requiresLeaveConfirmation: false,
  });
  expect(saved?.baseline).toEqual(createPlaybookBaseline(seed.draft));
  const newerServer = {
    draft: {
      ...seed.draft,
      description: "Changed by another writer after the flush",
    },
    updatedAt: "2026-10-08T08:02:00.000Z",
    status: "draft",
    approvedAt: null,
  } as const satisfies PlaybookSnapshot;
  const reopened = render(
    <ParkedSaveHarness
      tabId={tabId}
      seed={seed}
      server={newerServer}
      sendSave={sendSave}
      requests={requests}
    />,
  );
  expect(reopened.getByText(newerServer.draft.description)).toBeDefined();
  reopened.unmount();
  await act(async () => {
    await Promise.all(requests);
  });
  expect(sent).toHaveLength(1);
});

test("a completed hidden save cannot recreate closed parking or replace a newer parked draft", () => {
  const store = makeStore();
  const tabId = "completed-save-identity";
  openPlaybook(store, tabId, "playbook");
  const original = parkedState("playbook", true);
  park(store, tabId, original);
  discardParkedPlaybookPane(tabId);
  completeParkedPlaybookPaneSave({
    tabId,
    parkedState: original,
    updatedAt: "2026-10-08T08:01:00.000Z",
  });
  expect(readParkedPlaybookPane(tabId, "playbook")).toBeNull();
  const newer = {
    ...original,
    draft: { ...original.draft, description: "New unsaved draft" },
  };
  park(store, tabId, newer);
  completeParkedPlaybookPaneSave({
    tabId,
    parkedState: original,
    updatedAt: "2026-10-08T08:01:00.000Z",
  });
  expect(readParkedPlaybookPane(tabId, "playbook")).toBe(newer);
});
