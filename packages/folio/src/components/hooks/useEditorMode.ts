import { useCallback, useState } from "react";

/** Editor mode. Mirrors Google Docs editing/suggesting/viewing semantics. */
export type EditorMode = "editing" | "suggesting" | "viewing";

/** How tracked changes render. Drives the display mode dropdown. */
export const DISPLAY_MODES = [
  "all-markup",
  "simple-markup",
  "no-markup",
  "original",
] as const;

export type DisplayMode = (typeof DISPLAY_MODES)[number];

export type UseEditorModeArgs = {
  /** Controlled mode prop, or undefined when uncontrolled. */
  modeProp: EditorMode | undefined;
  /** Notified whenever the mode changes (controlled and uncontrolled paths). */
  onModeChange: ((mode: EditorMode) => void) | undefined;
  /** External read-only flag from the host. */
  readOnlyProp: boolean;
};

export type UseEditorModeReturn = {
  /** Effective editing mode (controlled `modeProp` wins over the internal value). */
  editingMode: EditorMode;
  /** Change mode. No-op for the internal state when the host controls it via `modeProp`. */
  setEditingMode: (mode: EditorMode) => void;
  /** True when the host opts into read-only OR the mode is `"viewing"`. */
  readOnly: boolean;
  /** True when the mode is `"suggesting"`. */
  trackChangesOn: boolean;
  /** Toggle between `"editing"` and `"suggesting"`. */
  toggleTrackChanges: () => void;
  /** Display mode for the tracked-changes overlay (`all-markup` by default). */
  displayMode: DisplayMode;
  setDisplayMode: (mode: DisplayMode) => void;
};

/**
 * Editor-mode and display-mode state for the DocxEditor.
 *
 * `editingMode` mirrors Google Docs:
 *  - `"editing"`     → direct edits (default)
 *  - `"suggesting"`  → tracked-change edits
 *  - `"viewing"`     → behaves as read-only
 *
 * `displayMode` is independent: it controls how tracked-changes render
 * (`all-markup`, `simple-markup`, `no-markup`, `original`). Switching the
 * editing mode does not switch the display mode.
 */
export function useEditorMode({
  modeProp,
  onModeChange,
  readOnlyProp,
}: UseEditorModeArgs): UseEditorModeReturn {
  const [editingModeInternal, setEditingModeInternal] = useState<EditorMode>(
    modeProp ?? "editing",
  );
  const editingMode = modeProp ?? editingModeInternal;

  const setEditingMode = useCallback(
    (mode: EditorMode) => {
      if (!modeProp) {
        setEditingModeInternal(mode);
      }
      onModeChange?.(mode);
    },
    [modeProp, onModeChange],
  );

  const readOnly = readOnlyProp || editingMode === "viewing";
  const trackChangesOn = editingMode === "suggesting";

  const toggleTrackChanges = useCallback(() => {
    setEditingMode(trackChangesOn ? "editing" : "suggesting");
  }, [setEditingMode, trackChangesOn]);

  const [displayMode, setDisplayMode] = useState<DisplayMode>("all-markup");

  return {
    editingMode,
    setEditingMode,
    readOnly,
    trackChangesOn,
    toggleTrackChanges,
    displayMode,
    setDisplayMode,
  };
}
