type ReadOnlyEditKeyEvent = Pick<
  KeyboardEvent,
  "altKey" | "ctrlKey" | "key" | "metaKey"
>;

const MODIFIED_EDIT_KEYS = new Set(["b", "i", "u", "v", "x", "y", "z"]);
const PLAIN_EDIT_KEYS = new Set(["Backspace", "Delete", "Enter"]);

export const isReadOnlyEditKey = (event: ReadOnlyEditKeyEvent): boolean => {
  if (event.metaKey || event.ctrlKey) {
    return MODIFIED_EDIT_KEYS.has(event.key.toLowerCase());
  }

  if (event.altKey) {
    return false;
  }

  return event.key.length === 1 || PLAIN_EDIT_KEYS.has(event.key);
};
