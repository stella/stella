import {
  FILE_FACETS,
  type FileFacet as Facet,
} from "@/components/inspector/inspector-store-types";
import {
  getNativeOfficeViewerFormat,
  isEmailFile,
  isMarkdownFile,
} from "@/lib/consts";

// Sidepeek shows every facet, including Preview (the file viewer
// itself). Fullscreen drops Preview entirely — the main view IS
// the preview, so a duplicate chip would be confusing; the
// FullViewPreviewGuard handles users who land in Full view with a
// stale "preview" facet by swapping to Metadata + flashing the
// Minimize button.
export const FACETS: readonly Facet[] = FILE_FACETS;
export const FULLVIEW_FACETS: readonly Facet[] = FILE_FACETS.filter(
  (facet) => facet !== "preview",
);

export type FileTabNativePreviewKind = "email" | "markdown" | "office" | "pdf";

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
  if (getNativeOfficeViewerFormat(mimeType) !== null) {
    return "office";
  }
  return "pdf";
};

export const shouldSurfaceEmailResolutionAlert = ({
  isEmailDisplay,
  isPreviewVisible,
  resolutionFailed,
}: {
  isEmailDisplay: boolean;
  isPreviewVisible: boolean;
  resolutionFailed: boolean;
}): boolean => isEmailDisplay && !isPreviewVisible && resolutionFailed;

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
