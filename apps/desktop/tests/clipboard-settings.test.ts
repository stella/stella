import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { clipboardHistory } from "../src/clipboard/clipboard-selection";
import {
  canCreateClipboardGroup,
  CLIPBOARD_RETENTION_LABEL_KEYS,
  clipboardGroupDropIndex,
  clipboardGroupStepIndex,
  isClipboardGroupDialogReady,
  verticalDropPosition,
  withClipboardSettings,
} from "../src/clipboard/clipboard-settings";
import {
  CLIPBOARD_RETENTIONS,
  isClipboardGroupColor,
  isClipboardSettingsSnapshot,
  isClipboardSnapshot,
} from "../src/clipboard/clipboard-types";
import type {
  ClipboardGroup,
  ClipboardGroupColor,
  ClipboardSettingsSnapshot,
  ClipboardSnapshot,
} from "../src/clipboard/clipboard-types";
import enMessages from "../src/i18n/langs/en.json";

const color = (value: string): ClipboardGroupColor => {
  if (!isClipboardGroupColor(value)) {
    throw new TypeError(`Invalid group colour: ${value}`);
  }
  return value;
};

const group = (id: string, name = id): ClipboardGroup => ({
  color: color("#3b82f6"),
  id,
  name,
});

const settings = (
  overrides: Partial<ClipboardSettingsSnapshot> = {},
): ClipboardSettingsSnapshot => ({
  captureStatus: "active",
  groupLimit: 12,
  groups: [group("prompts", "Prompts"), group("intake", "Client intake")],
  retention: "month",
  revision: 4,
  screenCapture: "hidden",
  sourceAppExclusionLimit: 64,
  sourceAppExclusions: [{ identifier: "com.example.editor", name: "Editor" }],
  ...overrides,
});

const snapshot = (
  overrides: Partial<ClipboardSnapshot> = {},
): ClipboardSnapshot => ({
  ...settings(),
  items: [
    {
      copiedAt: "2026-11-20T09:00:00.000Z",
      groupId: "prompts",
      groupedAt: "2026-11-20T09:00:00.000Z",
      id: "clip-1",
      name: null,
      plainText: "Notice period is three months.",
      sourceApp: null,
      type: "text",
    },
  ],
  persistence: { imageCleanup: "idle", status: "encrypted" },
  sourceAppVisuals: [],
  welcomeStatus: "completed",
  ...overrides,
});

describe("settings answers in the Clips window", () => {
  test("a newer answer replaces every setting and keeps the clips and revision", () => {
    const current = snapshot();
    const answer = settings({
      captureStatus: "paused",
      groups: [group("intake", "Client intake")],
      retention: "week",
      revision: 5,
      screenCapture: "visible",
      sourceAppExclusions: [],
    });
    const merged = withClipboardSettings(current, answer);

    const { revision: _answerRevision, ...answeredSettings } = answer;
    expect(merged).toMatchObject(answeredSettings);
    expect(merged.items).toBe(current.items);
    expect(merged.persistence).toBe(current.persistence);
    // The clips are read at the new revision by the change event, not here.
    expect(merged.revision).toBe(current.revision);
  });

  test("an answer older than the snapshot changes nothing", () => {
    const current = snapshot({ revision: 9 });
    const stale = settings({ retention: "year", revision: 8 });
    expect(stale.retention).not.toBe(current.retention);
    expect(withClipboardSettings(current, stale)).toBe(current);
  });

  test("the history reducer applies an answer without dropping the selection", () => {
    const state = {
      selection: { ids: ["clip-1"], session: 2 },
      snapshot: snapshot(),
    };
    const next = clipboardHistory(state, {
      settings: settings({ retention: "year", revision: 5 }),
      type: "settingsReceived",
    });
    expect(next.snapshot.retention).toBe("year");
    expect(next.selection).toBe(state.selection);
    expect(
      clipboardHistory(state, {
        settings: settings({ retention: "year", revision: 1 }),
        type: "settingsReceived",
      }),
    ).toBe(state);
  });

  test("a full snapshot carries the settings, and a settings answer carries no clip", () => {
    const full = snapshot();
    expect(isClipboardSnapshot(full)).toBe(true);
    expect(isClipboardSettingsSnapshot(full)).toBe(true);
    const answer = settings();
    expect(isClipboardSettingsSnapshot(answer)).toBe(true);
    expect(isClipboardSnapshot(answer)).toBe(false);
    const { groups: _groups, ...withoutGroups } = answer;
    expect(isClipboardSettingsSnapshot(withoutGroups)).toBe(false);
    expect(
      isClipboardSettingsSnapshot({
        ...answer,
        sourceAppExclusionLimit: 0,
      }),
    ).toBe(false);
  });
});

describe("group order", () => {
  const groups = ["a", "b", "c", "d"].map((id) => group(id));

  test("a drop lands before or after its target", () => {
    expect(
      clipboardGroupDropIndex({
        draggedId: "d",
        groups,
        position: "before",
        targetId: "a",
      }),
    ).toBe(0);
    expect(
      clipboardGroupDropIndex({
        draggedId: "a",
        groups,
        position: "after",
        targetId: "c",
      }),
    ).toBe(2);
  });

  test("a drop that keeps the order sends no move", () => {
    for (const drop of [
      { draggedId: "b", position: "after", targetId: "a" },
      { draggedId: "b", position: "before", targetId: "c" },
      { draggedId: "b", position: "before", targetId: "b" },
      { draggedId: "missing", position: "before", targetId: "a" },
    ] as const) {
      expect(clipboardGroupDropIndex({ ...drop, groups })).toBeNull();
    }
  });

  test("a drop index moves the group exactly where the native move puts it", () => {
    assertProperty(
      "a drop index moves the group exactly where the native move puts it",
      fc.property(
        fc.uniqueArray(fc.string({ maxLength: 4, minLength: 1 }), {
          maxLength: 8,
          minLength: 2,
        }),
        fc.nat(),
        fc.nat(),
        fc.constantFrom("before", "after"),
        (ids, from, to, position) => {
          const list = ids.map((id) => group(id));
          const draggedId = ids[from % ids.length] ?? "";
          const targetId = ids[to % ids.length] ?? "";
          const index = clipboardGroupDropIndex({
            draggedId,
            groups: list,
            position,
            targetId,
          });
          if (index === null) {
            return;
          }
          // `ClipboardManager::move_group`: remove, then insert at `index`.
          const moved = ids.filter((id) => id !== draggedId);
          moved.splice(index, 0, draggedId);
          const target = moved.indexOf(targetId);
          const dragged = moved.indexOf(draggedId);
          expect(dragged).toBe(position === "before" ? target - 1 : target + 1);
          expect(moved).not.toEqual(ids);
        },
      ),
    );
  });

  test("a keyboard step moves one place and stops at either end", () => {
    expect(clipboardGroupStepIndex(groups, "b", -1)).toBe(0);
    expect(clipboardGroupStepIndex(groups, "b", 1)).toBe(2);
    expect(clipboardGroupStepIndex(groups, "a", -1)).toBeNull();
    expect(clipboardGroupStepIndex(groups, "d", 1)).toBeNull();
    expect(clipboardGroupStepIndex(groups, "missing", 1)).toBeNull();
  });

  test("a vertical row reads its top edge as before and its bottom as after", () => {
    expect(verticalDropPosition("top")).toBe("before");
    expect(verticalDropPosition("bottom")).toBe("after");
    expect(verticalDropPosition("left")).toBeNull();
    expect(verticalDropPosition(null)).toBeNull();
  });
});

describe("group limits and dialogs", () => {
  test("a group can be created only below the limit", () => {
    expect(
      canCreateClipboardGroup({ groupLimit: 2, groups: [group("a")] }),
    ).toBe(true);
    expect(
      canCreateClipboardGroup({
        groupLimit: 2,
        groups: [group("a"), group("b")],
      }),
    ).toBe(false);
  });

  test("a group needs a name, a deletion only its choice", () => {
    const fields = { color: color("#3b82f6"), name: "  " };
    expect(
      isClipboardGroupDialogReady({
        ...fields,
        itemId: null,
        type: "createGroup",
      }),
    ).toBe(false);
    expect(
      isClipboardGroupDialogReady({
        ...fields,
        groupId: "a",
        name: "Prompts",
        type: "editGroup",
      }),
    ).toBe(true);
    expect(
      isClipboardGroupDialogReady({
        groupId: "a",
        groupName: "Prompts",
        mode: "deleteClips",
        type: "deleteGroup",
      }),
    ).toBe(true);
  });

  test("every retention has a label in the catalog", () => {
    expect(Object.keys(CLIPBOARD_RETENTION_LABEL_KEYS).toSorted()).toEqual(
      [...CLIPBOARD_RETENTIONS].toSorted(),
    );
    for (const key of Object.values(CLIPBOARD_RETENTION_LABEL_KEYS)) {
      expect(enMessages.clipboard[key]).toBeString();
    }
  });
});
