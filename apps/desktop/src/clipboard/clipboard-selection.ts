import { panic } from "better-result";

import type { ClipboardSnapshot } from "./clipboard-types";

export type ClipboardSelectionState = {
  ids: string[];
  session: number;
};

export type ClipboardSelectionAction =
  | { type: "toggle"; id: string }
  | { type: "historyChanged"; ids: readonly string[] }
  | { type: "clear" }
  | { type: "sessionStarted" }
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
      };
    }
    case "sessionStarted":
      return { ids: [], session: selection.session + 1 };
    case "copySucceeded":
      if (action.session !== selection.session) {
        return selection;
      }
      return { ids: [], session: selection.session };
    case "clear":
      return { ids: [], session: selection.session };
    case "toggle":
      return {
        ids: selection.ids.includes(action.id)
          ? selection.ids.filter((id) => id !== action.id)
          : [...selection.ids, action.id],
        session: selection.session,
      };
    default: {
      action satisfies never;
      return panic("Unknown clipboard selection action.");
    }
  }
};

type ClipboardHistoryState = {
  snapshot: ClipboardSnapshot;
  selection: ClipboardSelectionState;
};

type ClipboardHistoryAction =
  | Exclude<ClipboardSelectionAction, { type: "historyChanged" }>
  | { type: "snapshotReceived"; snapshot: ClipboardSnapshot };

/** Snapshots and their selection projection commit together for every history update. */
export const clipboardHistory = (
  state: ClipboardHistoryState,
  action: ClipboardHistoryAction,
): ClipboardHistoryState => {
  if (action.type === "snapshotReceived") {
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
