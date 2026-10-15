import { panic } from "better-result";

export type ClipboardSelectionState = {
  ids: string[];
  session: number;
};

export type ClipboardSelectionAction =
  | { type: "toggle"; id: string }
  | { type: "clear" }
  | { type: "sessionStarted" }
  | { type: "copySucceeded"; session: number };

/** Owns selection order and lifetime, including completions from an older session. */
export const clipboardSelection = (
  selection: ClipboardSelectionState,
  action: ClipboardSelectionAction,
): ClipboardSelectionState => {
  switch (action.type) {
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
