import { isEmailFile, isMarkdownFile } from "@/lib/consts";

export type FileTabNativePreviewKind = "email" | "markdown" | "pdf";

export const getFileTabNativePreviewKind = ({
  fileName,
  mimeType,
}: {
  fileName: string;
  mimeType?: string | undefined;
}): FileTabNativePreviewKind => {
  if (isEmailFile({ fileName, mimeType })) {
    return "email";
  }
  if (isMarkdownFile({ fileName, mimeType })) {
    return "markdown";
  }
  return "pdf";
};

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
