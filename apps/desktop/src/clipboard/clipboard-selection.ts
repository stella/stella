import { panic } from "better-result";

export type ClipboardSelectionAction =
  | { type: "toggle"; id: string }
  | { type: "clear" };

/** Appending on selection keeps paste order independent of the visual rail. */
export const clipboardSelection = (
  selection: readonly string[],
  action: ClipboardSelectionAction,
): string[] => {
  switch (action.type) {
    case "clear":
      return [];
    case "toggle":
      return selection.includes(action.id)
        ? selection.filter((id) => id !== action.id)
        : [...selection, action.id];
    default: {
      action satisfies never;
      return panic("Unknown clipboard selection action.");
    }
  }
};
