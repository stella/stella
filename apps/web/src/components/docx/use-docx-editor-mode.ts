import { useCallback, useState } from "react";

import type { EditorMode } from "@stll/folio-react";

import { useExternalSyncEffect } from "@/hooks/use-effect";

/**
 * The editing mode the reader picked in Folio. Folio's own "viewing" mode is
 * not kept: a locked document renders as viewing regardless, and locking it
 * returns the mode to editing for the next unlock.
 */
export const useDocxEditorMode = (isUnlocked: boolean) => {
  const [editorMode, setEditorMode] = useState<EditorMode>("editing");

  const handleEditorModeChange = useCallback(
    (mode: EditorMode) => {
      if (mode !== "viewing") {
        setEditorMode(mode);
      }
    },
    [setEditorMode],
  );

  useExternalSyncEffect(() => {
    if (!isUnlocked) {
      setEditorMode("editing");
    }
  }, [isUnlocked]);

  return { editorMode, handleEditorModeChange };
};
