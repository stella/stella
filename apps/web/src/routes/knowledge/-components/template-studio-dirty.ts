import type { DocxEditorRef } from "@stll/folio-react";

type PendingChangesReader = Pick<DocxEditorRef, "hasPendingChanges">;

/**
 * Folio batches document-change notifications. Read its current pending state
 * when the notification arrives so a callback queued before save cannot make a
 * fully serialized document dirty again after save clears its change markers.
 */
export const hasUnsavedEditorChanges = (
  editor: PendingChangesReader | null,
): boolean => editor?.hasPendingChanges() === true;
