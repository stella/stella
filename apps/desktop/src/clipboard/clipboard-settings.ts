import { invoke } from "@tauri-apps/api/core";
import { panic } from "better-result";

import { reorderInlineIds } from "@stll/ui/inline-reorder";
import type { InlineDropPosition } from "@stll/ui/inline-reorder";

import { isClipboardSettingsSnapshot } from "./clipboard-types";
import type {
  ClipboardCaptureStatus,
  ClipboardGroup,
  ClipboardGroupColor,
  ClipboardRetention,
  ClipboardSettingsSnapshot,
  ClipboardSnapshot,
} from "./clipboard-types";

/*
 * The clipboard settings both the Clips window and the Settings window
 * change: capture, retention, screen recordings, excluded applications and
 * groups. One owner for their commands, labels and group order, so the two
 * windows cannot drift apart. Every command answers with the settings after
 * the change and announces it, so the other window reads again.
 */

export const CLIPBOARD_RETENTION_LABEL_KEYS = {
  week: "retentionWeek",
  month: "retentionMonth",
  year: "retentionYear",
} as const satisfies Record<ClipboardRetention, string>;

export const CLIPBOARD_GROUP_DELETION_MODES = [
  "keepClips",
  "deleteClips",
] as const;

export type ClipboardGroupDeletionMode =
  (typeof CLIPBOARD_GROUP_DELETION_MODES)[number];

/** A group dialog: what it creates, edits or deletes, as the user left it. */
export type ClipboardGroupDialogState =
  | {
      color: ClipboardGroupColor;
      /** A clip the new group takes in; only the Clips windows name one. */
      itemId: string | null;
      name: string;
      type: "createGroup";
    }
  | {
      groupId: string;
      groupName: string;
      mode: ClipboardGroupDeletionMode;
      type: "deleteGroup";
    }
  | {
      color: ClipboardGroupColor;
      groupId: string;
      name: string;
      type: "editGroup";
    };

/** The settings after a change, or null when the answer has another shape.
 *  A failed command rejects. */
const settingsAnswer = async (
  answer: Promise<unknown>,
): Promise<ClipboardSettingsSnapshot | null> => {
  const value = await answer;
  return isClipboardSettingsSnapshot(value) ? value : null;
};

export const clipboardSettingsCommands = {
  setCaptureStatus: async (status: ClipboardCaptureStatus) =>
    settingsAnswer(invoke<unknown>("clipboard_set_capture_status", { status })),
  setRetention: async (retention: ClipboardRetention) =>
    settingsAnswer(invoke<unknown>("clipboard_set_retention", { retention })),
  setScreenCapture: async (
    capture: ClipboardSettingsSnapshot["screenCapture"],
  ) =>
    settingsAnswer(
      invoke<unknown>("clipboard_set_screen_capture", { capture }),
    ),
  removeSourceAppExclusion: async (identifier: string) =>
    settingsAnswer(
      invoke<unknown>("clipboard_remove_source_app_exclusion", { identifier }),
    ),
  moveGroup: async ({ id, index }: { id: string; index: number }) =>
    settingsAnswer(invoke<unknown>("clipboard_move_group", { id, index })),
  submitGroupDialog: async (dialog: ClipboardGroupDialogState) => {
    switch (dialog.type) {
      case "createGroup":
        return settingsAnswer(
          invoke<unknown>("clipboard_create_group", {
            color: dialog.color,
            itemId: dialog.itemId,
            name: dialog.name,
          }),
        );
      case "editGroup":
        return settingsAnswer(
          invoke<unknown>("clipboard_update_group", {
            color: dialog.color,
            id: dialog.groupId,
            name: dialog.name,
          }),
        );
      case "deleteGroup":
        return settingsAnswer(
          invoke<unknown>("clipboard_delete_group", {
            id: dialog.groupId,
            mode: dialog.mode,
          }),
        );
      default: {
        dialog satisfies never;
        return panic(`Unhandled group dialog: ${String(dialog)}`);
      }
    }
  },
};

/** Whether a dialog can be submitted: a group needs a name. */
export const isClipboardGroupDialogReady = (
  dialog: ClipboardGroupDialogState,
) => dialog.type === "deleteGroup" || dialog.name.trim().length > 0;

export const canCreateClipboardGroup = (
  settings: Pick<ClipboardSettingsSnapshot, "groupLimit" | "groups">,
) => settings.groups.length < settings.groupLimit;

/**
 * The Clips window's snapshot with the settings a command answered with. An
 * older answer changes nothing. The revision stays the snapshot's own: the
 * clips are not yet read at the newer one, and the change event that every
 * settings command sends brings them.
 */
export const withClipboardSettings = (
  snapshot: ClipboardSnapshot,
  settings: ClipboardSettingsSnapshot,
): ClipboardSnapshot =>
  settings.revision < snapshot.revision
    ? snapshot
    : {
        ...snapshot,
        captureStatus: settings.captureStatus,
        groupLimit: settings.groupLimit,
        groups: settings.groups,
        retention: settings.retention,
        screenCapture: settings.screenCapture,
        sourceAppExclusionLimit: settings.sourceAppExclusionLimit,
        sourceAppExclusions: settings.sourceAppExclusions,
      };

/** Where a group dropped on another lands, or null when the order stays. */
export const clipboardGroupDropIndex = ({
  draggedId,
  groups,
  position,
  targetId,
}: {
  draggedId: string;
  groups: readonly ClipboardGroup[];
  position: InlineDropPosition;
  targetId: string;
}) => {
  const reordered = reorderInlineIds({
    draggedId,
    ids: groups.map((group) => group.id),
    position,
    targetId,
  });
  return reordered === null ? null : reordered.indexOf(draggedId);
};

/** Where a group moved one place earlier (-1) or later (1) lands, or null
 *  at either end. */
export const clipboardGroupStepIndex = (
  groups: readonly ClipboardGroup[],
  id: string,
  step: -1 | 1,
) => {
  const index = groups.findIndex((group) => group.id === id);
  if (index === -1) {
    return null;
  }
  const target = index + step;
  return target < 0 || target >= groups.length ? null : target;
};

/** A drop on a row of a vertical list: its top edge is before it. */
export const verticalDropPosition = (
  edge: "top" | "right" | "bottom" | "left" | null,
): InlineDropPosition | null => {
  if (edge === "top") {
    return "before";
  }
  return edge === "bottom" ? "after" : null;
};
