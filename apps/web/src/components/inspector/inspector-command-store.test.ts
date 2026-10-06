import { beforeEach, describe, expect, test } from "bun:test";

import { requestInspectorRename } from "@/components/inspector/inspector-actions";
import { useInspectorCommandStore } from "@/components/inspector/inspector-command-store";
import { startNewInspectorChat } from "@/components/inspector/inspector-new-chat";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import { createChatThreadId } from "@/lib/chat-thread-ref";

beforeEach(() => {
  useInspectorCommandStore.setState({
    newChatCommand: null,
    desktopOpenAttention: null,
    pendingRenameTabId: null,
    pendingBlockScroll: null,
    blockScrollSeq: 0,
    pendingPdfPageScroll: null,
    pendingDocxEditTabId: null,
  });
  useInspectorTabsStore.setState(useInspectorTabsStore.getInitialState(), true);
});

describe("inspector commands", () => {
  test("a rename request activates its tab and queues one command", () => {
    const store = useInspectorTabsStore.getState();
    store.openTask({ taskId: "tab-1", workspaceId: "matter-1" });
    store.openTask({ taskId: "tab-2", workspaceId: "matter-1" });
    const activationSeq = useInspectorTabsStore.getState().activationSeq;
    requestInspectorRename("tab-1");

    expect(useInspectorTabsStore.getState().activeId).toBe("tab-1");
    expect(useInspectorTabsStore.getState().activationSeq).toBe(
      activationSeq + 1,
    );
    expect(useInspectorCommandStore.getState().pendingRenameTabId).toBe(
      "tab-1",
    );
  });

  test("reconciliation clears only commands owned by missing tabs", () => {
    const commands = useInspectorCommandStore.getState();
    commands.requestRename("missing-tab");
    commands.requestDocxEdit("missing-tab");
    commands.requestDesktopOpenAttention("missing-tab");
    commands.requestBlockScroll({ tabId: "open-tab", blockId: "block-1" });
    commands.requestPdfPageScroll({ tabId: "open-tab", pageNumber: 7 });

    commands.clearCommandsForMissingTabs(new Set(["open-tab"]));

    expect(useInspectorCommandStore.getState().pendingRenameTabId).toBeNull();
    expect(useInspectorCommandStore.getState().pendingDocxEditTabId).toBeNull();
    expect(useInspectorCommandStore.getState().desktopOpenAttention).toBeNull();
    expect(useInspectorCommandStore.getState().pendingBlockScroll).toEqual({
      tabId: "open-tab",
      blockId: "block-1",
      text: undefined,
      seq: 1,
    });
    expect(useInspectorCommandStore.getState().pendingPdfPageScroll).toEqual({
      tabId: "open-tab",
      pageNumber: 7,
    });
  });

  test("asking for the same block twice is two distinguishable requests", () => {
    const commands = useInspectorCommandStore.getState();
    commands.requestBlockScroll({ tabId: "field-1", blockId: "block-1" });
    const first = useInspectorCommandStore.getState().pendingBlockScroll;
    commands.clearPendingBlockScroll(first?.seq ?? -1);
    expect(useInspectorCommandStore.getState().pendingBlockScroll).toBeNull();

    commands.requestBlockScroll({ tabId: "field-1", blockId: "block-1" });
    const second = useInspectorCommandStore.getState().pendingBlockScroll;

    expect(second?.blockId).toBe("block-1");
    expect(second?.seq).toBe((first?.seq ?? 0) + 1);
  });

  test("a stale acknowledgement never swallows a newer block-scroll request", () => {
    const commands = useInspectorCommandStore.getState();
    commands.requestBlockScroll({ tabId: "field-1", blockId: "block-1" });
    const stale = useInspectorCommandStore.getState().pendingBlockScroll;
    commands.requestBlockScroll({ tabId: "field-1", blockId: "block-2" });

    commands.clearPendingBlockScroll(stale?.seq ?? -1);

    expect(
      useInspectorCommandStore.getState().pendingBlockScroll?.blockId,
    ).toBe("block-2");
  });

  test("a PDF page request remains bound to its exact file tab", () => {
    const commands = useInspectorCommandStore.getState();
    commands.requestPdfPageScroll({ tabId: "field-2", pageNumber: 12 });

    expect(useInspectorCommandStore.getState().pendingPdfPageScroll).toEqual({
      tabId: "field-2",
      pageNumber: 12,
    });

    commands.clearPendingPdfPageScroll();
    expect(useInspectorCommandStore.getState().pendingPdfPageScroll).toBeNull();
  });

  test("desktop-open attention clears only the matching pulse", () => {
    const commands = useInspectorCommandStore.getState();
    commands.requestDesktopOpenAttention("file-1");
    const firstSequence =
      useInspectorCommandStore.getState().desktopOpenAttention?.sequence;
    commands.requestDesktopOpenAttention("file-1");

    if (firstSequence === undefined) {
      throw new Error("Expected a desktop-open attention sequence");
    }
    commands.clearDesktopOpenAttention(firstSequence);

    expect(useInspectorCommandStore.getState().desktopOpenAttention).toEqual({
      fieldId: "file-1",
      sequence: firstSequence + 1,
    });

    commands.clearDesktopOpenAttention(firstSequence + 1);
    expect(useInspectorCommandStore.getState().desktopOpenAttention).toBeNull();
  });
});

describe("mounted inspector New chat ownership", () => {
  test("global entry points reuse the active chat owner instead of opening a cold thread", () => {
    const id = createChatThreadId();
    const contextMatterIds = ["matter-source"];
    useInspectorTabsStore.getState().openChat({ id, contextMatterIds });
    let runs = 0;
    const unregister = useInspectorCommandStore
      .getState()
      .registerNewChatCommand({
        tabId: id,
        run: () => {
          runs += 1;
        },
      });
    const before = useInspectorTabsStore.getState().tabs;

    startNewInspectorChat({ workspaceId: "different-route-matter" });

    expect(runs).toBe(1);
    expect(useInspectorTabsStore.getState().tabs).toBe(before);
    expect(useInspectorTabsStore.getState().activeId).toBe(id);
    unregister();
  });

  test("an obsolete registration cleanup cannot remove a replacement using the same callback", () => {
    const id = createChatThreadId();
    const run = () => undefined;
    const commands = useInspectorCommandStore.getState();
    const firstCleanup = commands.registerNewChatCommand({ tabId: id, run });
    const secondCleanup = commands.registerNewChatCommand({ tabId: id, run });
    const secondRegistration =
      useInspectorCommandStore.getState().newChatCommand;

    firstCleanup();

    expect(useInspectorCommandStore.getState().newChatCommand).toBe(
      secondRegistration,
    );
    secondCleanup();
    expect(useInspectorCommandStore.getState().newChatCommand).toBeNull();
  });

  test("reconciliation retires only the missing chat owner's callback", () => {
    const id = createChatThreadId();
    const commands = useInspectorCommandStore.getState();
    commands.registerNewChatCommand({ tabId: id, run: () => undefined });
    const registration = useInspectorCommandStore.getState().newChatCommand;

    commands.clearCommandsForMissingTabs(new Set([id]));
    expect(useInspectorCommandStore.getState().newChatCommand).toBe(
      registration,
    );
    commands.clearCommandsForMissingTabs(new Set());
    expect(useInspectorCommandStore.getState().newChatCommand).toBeNull();
  });

  test("a hidden chat owner cannot consume a cold-pane entry point", () => {
    const id = createChatThreadId();
    useInspectorTabsStore.getState().openChat({ id });
    let runs = 0;
    useInspectorCommandStore.getState().registerNewChatCommand({
      tabId: id,
      run: () => {
        runs += 1;
      },
    });
    useInspectorTabsStore.setState({ minimized: true });
    const destination = createChatThreadId();

    startNewInspectorChat({
      id: destination,
      contextMatterIds: ["matter-destination"],
    });

    expect(runs).toBe(0);
    expect(useInspectorTabsStore.getState().activeId).toBe(destination);
    expect(useInspectorTabsStore.getState().minimized).toBe(false);
  });

  test("a callback for another tab cannot consume the active tab's New chat command", () => {
    const oldId = createChatThreadId();
    const activeId = createChatThreadId();
    const tabs = useInspectorTabsStore.getState();
    tabs.openChat({ id: oldId });
    tabs.openChat({ id: activeId });
    let runs = 0;
    useInspectorCommandStore.getState().registerNewChatCommand({
      tabId: oldId,
      run: () => {
        runs += 1;
      },
    });
    const destination = createChatThreadId();

    startNewInspectorChat({ id: destination });

    expect(runs).toBe(0);
    expect(useInspectorTabsStore.getState().activeId).toBe(destination);
  });
});
