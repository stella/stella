import { useRef } from "react";
import type { RefObject } from "react";

import type { DocxEditorRef } from "@stll/folio-react";

import { useExternalSyncEffect } from "@/hooks/use-effect";

import type { AutosaveStatus } from "./docx-edit-mode.logic";

type UseDocxUnlockTransitionOptions = {
  editorRef: RefObject<DocxEditorRef | null>;
  isUnlocked: boolean;
  setAutosaveStatus: (status: AutosaveStatus) => void;
};

/**
 * Locking the document settles the autosave status; the first unlock after a
 * lock moves focus into the editor.
 */
export const useDocxUnlockTransition = ({
  editorRef,
  isUnlocked,
  setAutosaveStatus,
}: UseDocxUnlockTransitionOptions) => {
  const wasUnlockedRef = useRef(false);

  useExternalSyncEffect(() => {
    if (!isUnlocked) {
      wasUnlockedRef.current = false;
      setAutosaveStatus("synced");
      return undefined;
    }

    if (wasUnlockedRef.current) {
      return undefined;
    }

    wasUnlockedRef.current = true;
    const frame = requestAnimationFrame(() => {
      editorRef.current?.focus();
    });

    return () => cancelAnimationFrame(frame);
  }, [editorRef, isUnlocked, setAutosaveStatus]);
};
