import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import type { ClipboardSelectionState } from "../src/clipboard/clipboard-selection";
import {
  clipboardDismissalCopy,
  clipboardHistory,
  clipboardSelection,
} from "../src/clipboard/clipboard-selection";
import type { ClipboardSnapshot } from "../src/clipboard/clipboard-types";

describe("ordered clipboard selection", () => {
  test("keeps click order, toggles off, and appends a reselected clip", () => {
    let selection: ClipboardSelectionState = {
      ids: [],
      session: 0,
      copy: "idle",
    };
    for (const id of ["third", "first", "second"]) {
      selection = clipboardSelection(selection, { type: "toggle", id });
    }
    expect(selection.ids).toEqual(["third", "first", "second"]);
    selection = clipboardSelection(selection, { type: "toggle", id: "first" });
    expect(selection.ids).toEqual(["third", "second"]);
    expect(
      clipboardSelection(selection, { type: "toggle", id: "first" }).ids,
    ).toEqual(["third", "second", "first"]);
  });

  test("Escape clears every selected clip and clearing is idempotent", () => {
    const cleared = clipboardSelection(
      { ids: ["third", "first", "second"], session: 0, copy: "idle" },
      {
        type: "clear",
      },
    );
    expect(cleared.ids).toEqual([]);
    expect(clipboardSelection(cleared, { type: "clear" })).toEqual(cleared);
  });

  test("toggling an unselected clip twice restores the prior selection without mutating it", () => {
    const selection = {
      ids: ["third", "first"],
      session: 0,
      copy: "idle",
    } satisfies ClipboardSelectionState;
    expect(
      clipboardSelection(
        clipboardSelection(selection, { type: "toggle", id: "second" }),
        { type: "toggle", id: "second" },
      ),
    ).toEqual(selection);
    expect(selection.ids).toEqual(["third", "first"]);
  });
  test("successful copies and new sessions clear selection through its owner", () => {
    const selection = {
      ids: ["third", "first"],
      session: 7,
      copy: "idle",
    } satisfies ClipboardSelectionState;
    expect(
      clipboardSelection(selection, { type: "copySucceeded", session: 7 }),
    ).toEqual({ ids: [], session: 7, copy: "idle" });
    expect(clipboardSelection(selection, { type: "sessionStarted" })).toEqual({
      ids: [],
      session: 8,
      copy: "idle",
    });
  });

  test("a late copy completion cannot clear a later session selection", () => {
    const nextSession = clipboardSelection(
      { ids: ["old"], session: 7, copy: "idle" },
      { type: "sessionStarted" },
    );
    const selected = clipboardSelection(nextSession, {
      type: "toggle",
      id: "new",
    });
    expect(
      clipboardSelection(selected, { type: "copySucceeded", session: 7 }),
    ).toEqual({ ids: ["new"], session: 8, copy: "idle" });
  });
});

describe("clipboard dismissal", () => {
  test("an outside click commits the selection once, in selection order", () => {
    const selection = {
      ids: ["third", "first", "second"],
      session: 4,
      copy: "idle",
    } satisfies ClipboardSelectionState;
    const dismissal = clipboardDismissalCopy(selection, "deactivated");
    expect(dismissal).toEqual({
      type: "copySelection",
      ids: ["third", "first", "second"],
      session: 4,
    });
    if (dismissal.type !== "copySelection") {
      panic("an outside click with a selection copies it");
    }
    expect(dismissal.ids).not.toBe(selection.ids);
  });

  test("an outside click without a selection copies nothing", () => {
    expect(
      clipboardDismissalCopy(
        { ids: [], session: 4, copy: "idle" },
        "deactivated",
      ),
    ).toEqual({ type: "none" });
  });

  test("an outside click while a started copy is answering copies nothing", () => {
    const copying = clipboardSelection(
      { ids: ["third", "first"], session: 4, copy: "idle" },
      { type: "copyStarted", session: 4 },
    );
    expect(clipboardDismissalCopy(copying, "deactivated")).toEqual({
      type: "none",
    });
    const failed = clipboardSelection(copying, {
      type: "copyFailed",
      session: 4,
    });
    expect(clipboardDismissalCopy(failed, "deactivated")).toEqual({
      type: "copySelection",
      ids: ["third", "first"],
      session: 4,
    });
    expect(
      clipboardSelection(copying, { type: "copyStarted", session: 3 }),
    ).toBe(copying);
  });

  test("a close the window asked for never copies the selection", () => {
    expect(
      clipboardDismissalCopy(
        { ids: ["first"], session: 4, copy: "idle" },
        "requested",
      ),
    ).toEqual({ type: "none" });
  });

  test("the commit's completion cannot clear a selection made after a reopen", () => {
    const dismissed = {
      ids: ["first"],
      session: 4,
      copy: "idle",
    } satisfies ClipboardSelectionState;
    const dismissal = clipboardDismissalCopy(dismissed, "deactivated");
    if (dismissal.type !== "copySelection") {
      panic("an outside click with a selection copies it");
    }
    const reopened = clipboardSelection(
      clipboardSelection(dismissed, { type: "sessionStarted" }),
      { type: "toggle", id: "second" },
    );
    expect(
      clipboardSelection(reopened, {
        type: "copySucceeded",
        session: dismissal.session,
      }),
    ).toEqual({ ids: ["second"], session: 5, copy: "idle" });
  });
});

test("every history replacement prunes missing IDs atomically without changing selection order", () => {
  const snapshot = {
    revision: 0,
    captureStatus: "active",
    groupLimit: 24,
    groups: [],
    items: ["first", "second", "third"].map((id) => ({
      type: "text" as const,
      id,
      name: null,
      plainText: id,
      copiedAt: "2026-09-08T05:00:00.000Z",
      sourceApp: null,
      groupId: null,
      groupedAt: null,
    })),
    persistence: { status: "encrypted", imageCleanup: "idle" },
    retention: "month",
    screenCapture: "hidden",
    sourceAppExclusionLimit: 128,
    sourceAppExclusions: [],
    sourceAppVisuals: [],
    welcomeStatus: "completed",
  } satisfies ClipboardSnapshot;
  const state = {
    snapshot,
    selection: {
      ids: ["third", "first", "second"],
      session: 9,
      copy: "idle",
    } satisfies ClipboardSelectionState,
  };
  const replacement = {
    ...snapshot,
    items: snapshot.items.filter((item) => item.id !== "first"),
  };
  const updated = clipboardHistory(state, {
    type: "snapshotReceived",
    snapshot: replacement,
  });
  expect(updated.snapshot).toBe(replacement);
  expect(clipboardHistory(updated, { type: "toggle", id: "first" })).toEqual(
    updated,
  );
  expect(updated.selection).toEqual({
    ids: ["third", "second"],
    session: 9,
    copy: "idle",
  });
  const empty = clipboardHistory(updated, {
    type: "snapshotReceived",
    snapshot: { ...snapshot, items: [] },
  });
  expect(empty.selection.ids).toEqual([]);
  expect(
    clipboardHistory(empty, { type: "snapshotReceived", snapshot }).selection
      .ids,
  ).toEqual([]);
  expect(
    clipboardHistory(updated, {
      type: "snapshotReceived",
      snapshot: replacement,
    }),
  ).toEqual(updated);
  const current = clipboardHistory(updated, {
    type: "snapshotReceived",
    snapshot: { ...replacement, revision: 2, items: [] },
  });
  expect(
    clipboardHistory(current, {
      type: "snapshotReceived",
      snapshot: replacement,
    }),
  ).toBe(current);
  const item = snapshot.items.at(0);
  if (item === undefined) {
    panic("capture fixture requires an item");
  }
  expect(
    clipboardHistory(current, {
      type: "captureReceived",
      update: { revision: 1, item, removedItemIds: [], sourceAppVisuals: [] },
    }),
  ).toBe(current);
  expect(
    clipboardHistory(current, {
      type: "captureReceived",
      update: { revision: 4, item, removedItemIds: [], sourceAppVisuals: [] },
    }),
  ).toBe(current);
  const captured = clipboardHistory(current, {
    type: "captureReceived",
    update: { revision: 3, item, removedItemIds: [], sourceAppVisuals: [] },
  });
  expect(captured.snapshot.items).toEqual([item]);
  expect(captured.snapshot.revision).toBe(3);

  const afterInitialSnapshot = clipboardHistory(state, {
    type: "snapshotReceived",
    snapshot,
  });
  const afterBufferedCapture = clipboardHistory(afterInitialSnapshot, {
    type: "captureReceived",
    update: {
      revision: 1,
      item: { ...item, id: "buffered-capture" },
      removedItemIds: [],
      sourceAppVisuals: [],
    },
  });
  expect(afterBufferedCapture.snapshot.items.map((entry) => entry.id)).toEqual([
    "buffered-capture",
    "first",
    "second",
    "third",
  ]);
});
