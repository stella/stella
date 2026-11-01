import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import { browserStorage } from "@/lib/account/browser-storage";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/workspaces" });

const { act, cleanup, render, renderHook } =
  await import("@testing-library/react");
const { readPersistedInspectorPaneOpen, startNewPageLoadForTest } =
  await import("@/components/inspector/inspector-broadcast");
const {
  inspectorMinimizedEntry,
  inspectorRestorePendingEntry,
  inspectorStateEntry,
} = await import("@/components/inspector/inspector-storage-keys");
const { useInspectorTabsStore } =
  await import("@/components/inspector/inspector-tabs-store");
const { useInspectorTabPersistence } =
  await import("@/components/inspector/use-inspector-tab-persistence");
const { assignUserStorage, releaseUserStorage } =
  await import("@/lib/account/user-scoped-storage");
const { readPersistedState, writePersistedState } =
  await import("@/lib/persisted-state/registry");
const { ProtectedPendingSkeleton } =
  await import("@/routes/-protected-pending-skeleton");

const scope = { organizationId: "organization-1", userId: "user-1" };
const SAVED_CHAT_ID = "00000000-0000-4000-8000-000000000001";

const area = (name: "local" | "session") =>
  browserStorage(name) ?? panic(`Test requires ${name} browser storage`);

afterEach(() => {
  cleanup();
  releaseUserStorage();
  area("local").clear();
  area("session").clear();
  startNewPageLoadForTest();
  useInspectorTabsStore.setState({
    tabs: [],
    groups: [],
    groupAssignments: {},
    collapsedGroupIds: [],
    activeId: null,
    minimized: false,
    reviveSuggestion: null,
  });
});

afterAll(async () => {
  await unregisterDomEnvironment();
});

/** What a member left behind: one started chat, with the pane open. */
const persistOpenChat = () => {
  writePersistedState(inspectorStateEntry, scope, {
    activeId: SAVED_CHAT_ID,
    collapsedGroupIds: [],
    groupAssignments: {},
    groups: [],
    tabs: [
      {
        contextMatterIds: [],
        id: SAVED_CHAT_ID,
        label: "Chat",
        started: true,
        type: "chat",
      },
    ],
  }).unwrap();
  writePersistedState(inspectorMinimizedEntry, scope, false).unwrap();
};

/** Whether the member loading frame reserves the pane for this scope. */
const loadingFrameReservesPane = () => {
  const { container, unmount } = render(
    <ProtectedPendingSkeleton inspectorScope={scope} />,
  );
  const dock =
    container.querySelector('[data-slot="inspector-pending-dock"]') ??
    panic("The loading frame renders the inspector dock");
  const reserved = dock.getAttribute("style") !== null;
  unmount();
  return reserved;
};

describe("reserving the inspector pane while tabs restore", () => {
  test("reserves the saved pane until the owner's tabs are in the store", () => {
    persistOpenChat();
    const { result } = renderHook(() => useInspectorTabPersistence(scope));

    // The session has not named the owner yet: the store is still empty.
    expect(useInspectorTabsStore.getState().tabs).toEqual([]);
    expect(result.current).toBe(true);
    expect(loadingFrameReservesPane()).toBe(true);

    act(() => {
      assignUserStorage(scope.userId);
    });

    // The tabs restored, so the store's own state now holds the pane open.
    expect(result.current).toBe(false);
    const { minimized, tabs } = useInspectorTabsStore.getState();
    expect(tabs.map((tab) => tab.id)).toEqual([SAVED_CHAT_ID]);
    expect(minimized).toBe(false);
  });

  test("both frames agree on a restore an earlier page load never settled", () => {
    persistOpenChat();
    // This page load restores the tab and marks the restore as unsettled.
    act(() => {
      assignUserStorage(scope.userId);
    });
    const restoring = renderHook(() => useInspectorTabPersistence(scope));
    expect(useInspectorTabsStore.getState().tabs).toHaveLength(1);
    expect(readPersistedState(inspectorRestorePendingEntry, scope)).not.toBe(
      "",
    );
    restoring.unmount();

    // The same page load's own marker is not a stalled restore.
    expect(readPersistedInspectorPaneOpen(scope)).toBe(true);
    expect(loadingFrameReservesPane()).toBe(true);

    // After a reload the marker belongs to the stalled load: the store
    // restores minimized, and neither frame reserves the pane.
    startNewPageLoadForTest();
    expect(readPersistedInspectorPaneOpen(scope)).toBe(false);
    expect(loadingFrameReservesPane()).toBe(false);
  });

  test("a minimized inspector reserves nothing in either frame", () => {
    persistOpenChat();
    expect(readPersistedInspectorPaneOpen(scope)).toBe(true);
    writePersistedState(inspectorMinimizedEntry, scope, true).unwrap();
    const { result } = renderHook(() => useInspectorTabPersistence(scope));
    expect(result.current).toBe(false);
    expect(loadingFrameReservesPane()).toBe(false);
  });
});
