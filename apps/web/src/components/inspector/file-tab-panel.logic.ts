import {
  FILE_FACETS,
  type FileFacet as Facet,
  type FileTab,
} from "@/components/inspector/inspector-store-types";
import {
  DOCX_MIME,
  getNativeOfficeViewerFormat,
  isEmailFile,
  isMarkdownFile,
} from "@/lib/consts";
import { getDesktopEditFileType } from "@/lib/desktop-edit-formats";

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

export const shouldRunFileAnonymizationPipeline = ({
  facet,
  isActive,
  isFullView,
  isMinimized,
  isMounted,
  isNativeDocxDisplay,
}: {
  facet: Facet;
  isActive: boolean;
  isFullView: boolean;
  isMinimized: boolean;
  isMounted: boolean;
  isNativeDocxDisplay: boolean;
}): boolean =>
  facet === "anonymization" &&
  isActive &&
  isFullView &&
  !isMinimized &&
  isMounted &&
  !isNativeDocxDisplay;

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

type GetFileTabDisplayStateOptions = {
  activeId: string | null;
  minimized: boolean;
  scaleOffsets: ReadonlyMap<string, number>;
  tab: FileTab;
};

export const getFileTabDisplayState = ({
  activeId,
  minimized,
  scaleOffsets,
  tab,
}: GetFileTabDisplayStateOptions) => {
  const isActive = tab.id === activeId;
  const nativePreviewKind = getFileTabNativePreviewKind({
    fileName: tab.fileName,
    mimeType: tab.mimeType,
  });
  const isNativeDocxDisplay = tab.mimeType === DOCX_MIME;
  const isEmailDisplay = nativePreviewKind === "email";
  const storedScaleOffset = scaleOffsets.get(tab.id);
  const scaleOffset = storedScaleOffset ?? 0;
  return {
    desktopEditFileType: getDesktopEditFileType({
      fileName: tab.fileName,
      mimeType: tab.mimeType,
    }),
    isActive,
    isEmailDisplay,
    isEmailViewerActive: isEmailDisplay && isActive && !minimized,
    isMarkdownDisplay: nativePreviewKind === "markdown",
    isNativeDocxDisplay,
    isOfficeDisplay: nativePreviewKind === "office",
    requiresPdfMeasurement:
      !isNativeDocxDisplay && nativePreviewKind !== "office",
    needsPropertyResolution:
      isNativeDocxDisplay && tab.propertyId === undefined,
    officeViewerFormat: getNativeOfficeViewerFormat(tab.mimeType),
    renderId: tab.renderId ?? tab.id,
    scaleOffset,
  };
};

export type FileTabDisplayState = ReturnType<typeof getFileTabDisplayState>;

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
