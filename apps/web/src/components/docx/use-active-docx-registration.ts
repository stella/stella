import { useRef } from "react";
import type { RefObject } from "react";

import type { DocxEditorRef } from "@stll/folio-react";

import { useActiveDocxStore } from "@/components/ai-suggestions/active-docx-store";
import type { ActiveDocxRegistrationToken } from "@/components/ai-suggestions/active-docx-store";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";

import type { DocxEditModeResult } from "./docx-browser-editor.logic";

type UseActiveDocxRegistrationOptions = {
  editorRef: RefObject<DocxEditorRef | null>;
  entityId: string;
  fieldId: string;
  isUnlocked: boolean;
  requestEditMode: () => Promise<DocxEditModeResult>;
};

/**
 * Publishes the editor handles to the active-DOCX registry so the
 * inspector's Suggestions facet can apply AI edits without needing to reach
 * into the editor's tree.
 */
export const useActiveDocxRegistration = ({
  editorRef,
  entityId,
  fieldId,
  isUnlocked,
  requestEditMode,
}: UseActiveDocxRegistrationOptions) => {
  // Capture the token returned by `registerEditor` and pass it back to
  // `unregisterEditor` so a fast remount overlap (instance A
  // unmounts AFTER instance B has already registered) doesn't
  // delete B's slot.
  const tokenRef = useRef<ActiveDocxRegistrationToken | null>(null);
  // `isUnlocked` is intentionally NOT in deps: this effect owns the
  // register/unregister lifecycle, and the next sync below propagates
  // lock-state changes via `updateEditable`. Including it here would
  // tear down + re-create the registration on every toggle,
  // invalidating the token contract documented above.
  const registerActiveEditor = useLatestCallback(() => {
    const token = useActiveDocxStore
      .getState()
      .registerEditor(entityId, fieldId, {
        editorRef,
        requestEditMode,
        editable: isUnlocked,
      });
    tokenRef.current = token;
    return () => {
      useActiveDocxStore.getState().unregisterEditor(entityId, fieldId, token);
      if (tokenRef.current === token) {
        tokenRef.current = null;
      }
    };
  });
  useExternalSyncEffect(registerActiveEditor, [
    entityId,
    fieldId,
    requestEditMode,
    registerActiveEditor,
  ]);

  useExternalSyncEffect(() => {
    const token = tokenRef.current;
    if (token === null) {
      return;
    }
    useActiveDocxStore
      .getState()
      .updateEditable(entityId, fieldId, isUnlocked, token);
  }, [entityId, fieldId, isUnlocked]);
};
