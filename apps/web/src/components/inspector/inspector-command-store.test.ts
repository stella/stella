import { beforeEach, describe, expect, test } from "bun:test";

import { requestInspectorRename } from "@/components/inspector/inspector-actions";
import { useInspectorCommandStore } from "@/components/inspector/inspector-command-store";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";

beforeEach(() => {
  useInspectorCommandStore.setState({
    desktopOpenAttention: null,
    pendingRenameTabId: null,
    pendingBlockScroll: null,
    pendingPdfPageScroll: null,
    pendingDocxEditTabId: null,
  });
  useInspectorTabsStore.setState({
    tabs: [],
    activeId: null,
    activationSeq: 0,
    flashTabId: null,
    flashSeq: 0,
    minimized: false,
    reviveSuggestion: null,
  });
});

describe("inspector commands", () => {
  test("a rename request activates its tab and queues one command", () => {
    requestInspectorRename("tab-1");

    expect(useInspectorTabsStore.getState().activeId).toBe("tab-1");
    expect(useInspectorTabsStore.getState().activationSeq).toBe(1);
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
    });
    expect(useInspectorCommandStore.getState().pendingPdfPageScroll).toEqual({
      tabId: "open-tab",
      pageNumber: 7,
    });
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
