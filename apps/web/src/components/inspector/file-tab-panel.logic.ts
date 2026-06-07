export type MarkdownDraftSyncDecision =
  | {
      fieldId: string;
      resetMode: boolean;
      text: string;
      type: "sync";
    }
  | { type: "skip" };

export const getMarkdownDraftSyncDecision = ({
  fieldId,
  isDirty,
  isMarkdownDisplay,
  lastSyncedFieldId,
  serverText,
}: {
  fieldId: string;
  isDirty: boolean;
  isMarkdownDisplay: boolean;
  lastSyncedFieldId: string | null;
  serverText: string | undefined;
}): MarkdownDraftSyncDecision => {
  if (!isMarkdownDisplay || serverText === undefined) {
    return { type: "skip" };
  }

  const isNewField = lastSyncedFieldId !== fieldId;
  if (!isNewField && isDirty) {
    return { type: "skip" };
  }

  return {
    fieldId,
    resetMode: isNewField,
    text: serverText,
    type: "sync",
  };
};
