import { useCallback } from "react";
import type { RefObject } from "react";

import type {
  DocxCompatibility,
  DocxEditorRef,
  EditorMode,
} from "@stll/folio-react";

import { useEvidenceReferences } from "@/components/docx/use-evidence-references";
import { detached } from "@/lib/detached";

import type { DocxEditModeResult } from "./docx-browser-editor.logic";

export type EvidenceReferencesDialogState = "closed" | "open" | "requested";

const canInsertEvidenceReference = (
  canUnlock: boolean,
  compatibility: DocxCompatibility | null,
) => canUnlock && compatibility?.canSafelyEdit !== false;

type UseEvidenceReferenceInsertionOptions = {
  canUnlock: boolean;
  compatibility: DocxCompatibility | null;
  /** Whether an edit session open was already attempted. */
  didOpenRef: RefObject<boolean>;
  dialogState: EvidenceReferencesDialogState;
  editorMode: EditorMode;
  editorRef: RefObject<DocxEditorRef | null>;
  isUnlocked: boolean;
  onDialogStateChange: (state: EvidenceReferencesDialogState) => void;
  requestEditMode: () => Promise<DocxEditModeResult>;
};

/**
 * Evidence references for the toolbar button and its dialog. Opening the
 * dialog on a locked document requests edit mode first; the dialog opens once
 * the document unlocks.
 */
export const useEvidenceReferenceInsertion = ({
  canUnlock,
  compatibility,
  didOpenRef,
  dialogState,
  editorMode,
  editorRef,
  isUnlocked,
  onDialogStateChange,
  requestEditMode,
}: UseEvidenceReferenceInsertionOptions) => {
  const editable = isUnlocked && editorMode !== "viewing";
  const evidence = useEvidenceReferences(editable);
  const canInsert = canInsertEvidenceReference(canUnlock, compatibility);

  const handleEvidenceReferencesClick = useCallback(() => {
    if (!canInsert || isUnlocked) {
      if (canInsert) {
        editorRef.current?.ensureEditorView({ focus: false });
      }
      onDialogStateChange("open");
      return;
    }

    editorRef.current?.ensureEditorView({ focus: false });
    onDialogStateChange("requested");
    if (!didOpenRef.current) {
      detached(requestEditMode(), "evidence-reference.request-edit-mode");
    }
  }, [
    canInsert,
    didOpenRef,
    editorRef,
    isUnlocked,
    onDialogStateChange,
    requestEditMode,
  ]);

  return {
    canInsert,
    /** `EvidenceReferencesDialog` props besides the document identity. */
    dialog: {
      canInsert,
      document: evidence.document,
      editable,
      open:
        dialogState === "open" || (dialogState === "requested" && isUnlocked),
      onOpenChange: (nextOpen: boolean) => {
        onDialogStateChange(nextOpen ? "open" : "closed");
      },
    },
    document: evidence.document,
    onClick: handleEvidenceReferencesClick,
    plugins: evidence.plugins,
  };
};

export type EvidenceReferenceInsertion = ReturnType<
  typeof useEvidenceReferenceInsertion
>;
