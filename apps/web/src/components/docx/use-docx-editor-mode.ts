import type { EditorMode } from "@stll/folio-react";
import { useKeyedState } from "@stll/ui/effects";

/**
 * The editing mode the reader picked in Folio. Folio's own "viewing" mode is
 * not kept: a locked document renders as viewing regardless, and locking it
 * returns the mode to editing for the next unlock (the pick is held per lock
 * state, so it starts over whenever the lock changes).
 */
export const useDocxEditorMode = (isUnlocked: boolean) => {
  const [editorMode, setEditorMode] = useKeyedState<EditorMode>(
    isUnlocked,
    "editing",
  );

  const handleEditorModeChange = (mode: EditorMode) => {
    if (mode !== "viewing") {
      setEditorMode(mode);
    }
  };

  return { editorMode, handleEditorModeChange };
};
