import { panic } from "better-result";

import { withClipboardSettings } from "./clipboard-settings";
import type {
  ClipboardCaptureUpdate,
  ClipboardHideReason,
  ClipboardSettingsSnapshot,
  ClipboardSnapshot,
} from "./clipboard-types";

/** `pending` while a copy the user started has not answered yet: a dismissal
 *  then must not write the clipboard over it. */
type ClipboardSelectionCopy = "idle" | "pending";

export type ClipboardSelectionState = {
  ids: string[];
  session: number;
  copy: ClipboardSelectionCopy;
};

export type ClipboardSelectionAction =
  | { type: "toggle"; id: string }
  | { type: "historyChanged"; ids: readonly string[] }
  | { type: "clear" }
  | { type: "sessionStarted" }
  | { type: "copyStarted"; session: number }
  | { type: "copyFailed"; session: number }
  | { type: "copySucceeded"; session: number };

/** Owns selection order and lifetime, including completions from an older session. */
export const clipboardSelection = (
  selection: ClipboardSelectionState,
  action: ClipboardSelectionAction,
): ClipboardSelectionState => {
  switch (action.type) {
    case "historyChanged": {
      const existingIds = new Set(action.ids);
      return {
        ids: selection.ids.filter((id) => existingIds.has(id)),
        session: selection.session,
        copy: selection.copy,
      };
    }
    case "sessionStarted":
      return { ids: [], session: selection.session + 1, copy: "idle" };
    case "copyStarted":
      if (action.session !== selection.session) {
        return selection;
      }
      return {
        ids: selection.ids,
        session: selection.session,
        copy: "pending",
      };
    case "copyFailed":
      if (action.session !== selection.session) {
        return selection;
      }
      return { ids: selection.ids, session: selection.session, copy: "idle" };
    case "copySucceeded":
      if (action.session !== selection.session) {
        return selection;
      }
      return { ids: [], session: selection.session, copy: "idle" };
    case "clear":
      return { ids: [], session: selection.session, copy: selection.copy };
    case "toggle":
      return {
        ids: selection.ids.includes(action.id)
          ? selection.ids.filter((id) => id !== action.id)
          : [...selection.ids, action.id],
        session: selection.session,
        copy: selection.copy,
      };
    default: {
      action satisfies never;
      return panic("Unknown clipboard selection action.");
    }
  }
};

type ClipboardDismissalCopy =
  { type: "none" } | { type: "copySelection"; ids: string[]; session: number };

/** An outside click commits the selection it leaves behind, in selection
 *  order, unless a copy the user started is still answering; any other close
 *  (Escape, a copy, the shortcut) copies nothing. */
export const clipboardDismissalCopy = (
  selection: ClipboardSelectionState,
  reason: ClipboardHideReason,
): ClipboardDismissalCopy => {
  switch (reason) {
    case "requested":
      return { type: "none" };
    case "deactivated":
      return selection.ids.length === 0 || selection.copy === "pending"
        ? { type: "none" }
        : {
            type: "copySelection",
            ids: [...selection.ids],
            session: selection.session,
          };
    default: {
      reason satisfies never;
      return panic("Unknown clipboard hide reason.");
    }
  }
};

type ClipboardHistoryState = {
  snapshot: ClipboardSnapshot;
  selection: ClipboardSelectionState;
};

type ClipboardHistoryAction =
  | Exclude<ClipboardSelectionAction, { type: "historyChanged" }>
  | { type: "snapshotReceived"; snapshot: ClipboardSnapshot }
  | { type: "settingsReceived"; settings: ClipboardSettingsSnapshot }
  | { type: "captureReceived"; update: ClipboardCaptureUpdate };

/** Snapshots and their selection projection commit together for every history update. */
export const clipboardHistory = (
  state: ClipboardHistoryState,
  action: ClipboardHistoryAction,
): ClipboardHistoryState => {
  if (action.type === "captureReceived") {
    if (action.update.revision !== state.snapshot.revision + 1) {
      return state;
    }
    const removedIds = new Set(action.update.removedItemIds);
    removedIds.add(action.update.item.id);
    const items = [
      action.update.item,
      ...state.snapshot.items.filter((item) => !removedIds.has(item.id)),
    ];
    const visuals = new Map(
      state.snapshot.sourceAppVisuals.map((visual) => [visual.key, visual]),
    );
    for (const visual of action.update.sourceAppVisuals) {
      visuals.set(visual.key, visual);
    }
    const referencedVisualKeys = new Set(
      items.flatMap(({ sourceApp }) =>
        sourceApp === null
          ? []
          : [
              sourceApp.visualKey,
              sourceApp.identifier ?? sourceApp.name,
              sourceApp.page?.origin,
            ],
      ),
    );
    return clipboardHistory(state, {
      type: "snapshotReceived",
      snapshot: {
        ...state.snapshot,
        revision: action.update.revision,
        items,
        sourceAppVisuals: [...visuals.values()].filter((visual) =>
          referencedVisualKeys.has(visual.key),
        ),
      },
    });
  }
  if (action.type === "settingsReceived") {
    const snapshot = withClipboardSettings(state.snapshot, action.settings);
    return snapshot === state.snapshot ? state : { ...state, snapshot };
  }
  if (action.type === "snapshotReceived") {
    if (action.snapshot.revision < state.snapshot.revision) {
      return state;
    }
    return {
      snapshot: action.snapshot,
      selection: clipboardSelection(state.selection, {
        type: "historyChanged",
        ids: action.snapshot.items.map((item) => item.id),
      }),
    };
  }
  if (
    action.type === "toggle" &&
    !state.snapshot.items.some((item) => item.id === action.id)
  ) {
    return state;
  }
  return {
    snapshot: state.snapshot,
    selection: clipboardSelection(state.selection, action),
  };
};
