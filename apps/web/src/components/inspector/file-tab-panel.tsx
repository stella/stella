import { lazy, Suspense, useState } from "react";
import type {
  Dispatch,
  MouseEvent,
  ReactElement,
  RefObject,
  SetStateAction,
} from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  CheckIcon,
  DownloadIcon,
  GitCommitHorizontalIcon,
  LockOpenIcon,
  Maximize2Icon,
  Minimize2Icon,
  XIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import type { DocxCompatibility } from "@stll/folio-react";
import { Button } from "@stll/ui/button";
import { stellaToast } from "@stll/ui/toast";
import { cn } from "@stll/ui/utils";

import { FILE_CHAT_OVERLAY_ACTIVATION } from "@/components/ai-suggestions/file-viewer-with-ai-config";
import { useReviewStore } from "@/components/ai-suggestions/review-store";
import { DocxBrowserEditor } from "@/components/docx/docx-browser-editor";
import type { DocxBrowserEditorActions } from "@/components/docx/docx-browser-editor";
import { getDocxEditBlockReason } from "@/components/docx/docx-browser-editor.logic";
import { AnonymizationFacet } from "@/components/inspector/anonymization-facet";
import { DesktopOpenButton } from "@/components/inspector/desktop-open-button";
import { DocumentAiSourceBar } from "@/components/inspector/document-ai-source-bar";
import { EmailAttachmentsFacet } from "@/components/inspector/email-attachments-facet";
import { getEmailAttachmentPreviewId } from "@/components/inspector/email-attachments-facet.logic";
import {
  EmailChatResolutionAlert,
  EmailFileViewer,
  EmailViewerWithAI,
} from "@/components/inspector/email-html-viewer";
import {
  EMAIL_CHAT_HOST,
  EMAIL_CHAT_MODE,
  getEmailChatMode,
  getEmailExtractionRefetchInterval,
  shouldSurfaceEmailChatResolutionError,
} from "@/components/inspector/email-html-viewer.logic";
import { EntityMetadataPanel } from "@/components/inspector/entity-metadata-panel";
import { downloadTabOriginalFile } from "@/components/inspector/file-download-service";
import {
  FullViewPreviewGuard,
  MetadataPanelSkeleton,
  TabFacetBar,
} from "@/components/inspector/file-facets";
import {
  FACETS,
  FULLVIEW_FACETS,
  getFileTabNativePreviewKind,
  getMarkdownDraftSyncDecision,
  shouldSurfaceEmailResolutionAlert,
} from "@/components/inspector/file-tab-panel.logic";
import { useInspectorCommandStore } from "@/components/inspector/inspector-command-store";
import { InspectorPdfErrorFallback } from "@/components/inspector/inspector-pdf-error-fallback";
import {
  InspectorTabHeader,
  MatterOriginLink,
} from "@/components/inspector/inspector-tab-header";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import type { FileTab } from "@/components/inspector/inspector-tabs-store";
import { MeasuredPdfProvider } from "@/components/inspector/measured-pdf-provider";
import { PlaybookFacet } from "@/components/inspector/playbook-facet";
import { SuggestionsFacet } from "@/components/inspector/suggestions-facet";
import { VersionsFacet } from "@/components/inspector/versions-facet";
import { MarkdownHybridEditor } from "@/components/markdown/markdown-hybrid-editor";
import {
  PeekPdfControls,
  PeekPdfViewer,
  PeekSuspenseFallback,
} from "@/components/pdf/peek/peek-pdf-viewer";
import { QuerySuspenseBoundary } from "@/components/query-suspense-boundary";
import Tooltip from "@/components/tooltip";
import { env } from "@/env";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import {
  DOCX_MIME,
  getNativeOfficeViewerFormat,
  MARKDOWN_MIME,
  TOOLBAR_ROW_HEIGHT,
} from "@/lib/consts";
import { getDesktopEditFileType } from "@/lib/desktop-edit-formats";
import { detached } from "@/lib/detached";
import { unwrapEden } from "@/lib/errors/api";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { filesKeys, textFileOptions } from "@/lib/files/queries";
import { toSafeId } from "@/lib/safe-id";
import { entitiesKeys, entityOptions } from "@/lib/workspaces/queries/entities";

const OfficeFileViewer = lazy(async () => {
  const m = await import("@/components/office/office-file-viewer");
  return { default: m.OfficeFileViewer };
});

type MatterOrigin = {
  color: string | null;
  id: string;
  name: string;
  onClick: () => void;
};

type FileTabPanelProps = {
  activeId: string | null;
  canUpdateEntity: boolean;
  closeAll: () => void;
  commitRename: (tab: FileTab) => void;
  docxActionsRef: RefObject<Map<string, DocxBrowserEditorActions>>;
  docxCompatibilityByTab: ReadonlyMap<string, DocxCompatibility>;
  docxScrollTopByTab: ReadonlyMap<string, number>;
  editingDocxTabId: string | null;
  editingTabId: string | null;
  editValue: string;
  flashDocxEditButton: (tabId: string) => void;
  flashMinimizeButton: (tabId: string) => void;
  flashingDocxEditTabId: string | null;
  flashingMinimizeTabId: string | null;
  handleCloseTab: (tabId: string) => void;
  handleMinimizeFromFullView: (tab: FileTab) => void;
  handleOpenFullView: () => Promise<void>;
  handleResetZoom: (tabId: string) => void;
  handleStartDocxEdit: (tabId: string) => Promise<void>;
  handleWheelZoom: (tabId: string, deltaY: number) => void;
  handleZoom: (tabId: string, direction: "in" | "out") => void;
  matterColor: string | null;
  matterOrigin: MatterOrigin | null;
  minimized: boolean;
  mountedPdfIds: ReadonlySet<string>;
  pdfRouteJustification: string | null;
  peekPdfViewId: string;
  ribbonLabelContextMenuOpenAt: (event: MouseEvent<HTMLElement>) => void;
  scaleOffsets: ReadonlyMap<string, number>;
  setDocxCompatibilityByTab: Dispatch<
    SetStateAction<Map<string, DocxCompatibility>>
  >;
  setDocxScrollTopByTab: Dispatch<SetStateAction<Map<string, number>>>;
  setEditingTabId: Dispatch<SetStateAction<string | null>>;
  setEditingDocxTabId: Dispatch<SetStateAction<string | null>>;
  setEditValue: Dispatch<SetStateAction<string>>;
  setScaleOffsets: Dispatch<SetStateAction<Map<string, number>>>;
  startRename: (tab: FileTab) => void;
  tab: FileTab;
};

/** Strip the file extension (e.g. ".pdf", ".docx") from a filename. */
const stripExtension = (name: string): string => {
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex <= 0) {
    return name;
  }
  return name.slice(0, dotIndex);
};

const getFileTabDisplayState = ({
  activeId,
  minimized,
  scaleOffsets,
  tab,
}: Pick<
  FileTabPanelProps,
  "activeId" | "minimized" | "scaleOffsets" | "tab"
>) => {
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
    canResetZoom: scaleOffset !== 0,
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

const getFileTabEntityState = ({
  entityData,
  entityQueryError,
  needsPropertyResolution,
  tab,
}: {
  entityData:
    | {
        extractionFileFieldId?: string | null | undefined;
        fields: { id: string; propertyId?: string | undefined }[];
      }
    | undefined;
  entityQueryError: boolean;
  needsPropertyResolution: boolean;
  tab: FileTabPanelProps["tab"];
}) => {
  const resolvedEmailChatMode = getEmailChatMode({
    extractionFileFieldId: entityData?.extractionFileFieldId,
    fieldId: tab.id,
  });
  const shouldSurfaceEmailResolutionError =
    shouldSurfaceEmailChatResolutionError({
      hasData: entityData !== undefined,
      isError: entityQueryError,
    });
  return {
    emailChatMode: shouldSurfaceEmailResolutionError
      ? EMAIL_CHAT_MODE.resolutionError
      : resolvedEmailChatMode,
    filePropertyId:
      tab.propertyId ??
      (needsPropertyResolution
        ? entityData?.fields.find((field) => field.id === tab.id)?.propertyId
        : undefined),
    resolvedEmailChatMode,
    shouldSurfaceEmailResolutionError,
  };
};

const getEmailAttachmentState = ({
  isActive,
  scaleOffsets,
  selectedEmailAttachmentId,
  tab,
}: {
  isActive: boolean;
  scaleOffsets: FileTabPanelProps["scaleOffsets"];
  selectedEmailAttachmentId: string | null;
  tab: FileTabPanelProps["tab"];
}) => {
  const selectedEmailAttachmentPreviewId = selectedEmailAttachmentId
    ? getEmailAttachmentPreviewId({
        attachmentId: selectedEmailAttachmentId,
        fieldId: tab.id,
        workspaceId: tab.workspaceId,
      })
    : null;
  const facet = tab.facet ?? "preview";
  const isPreviewActive = isActive && facet === "preview";
  return {
    emailAttachmentOverlayActivation:
      isActive && tab.facet === "attachments"
        ? FILE_CHAT_OVERLAY_ACTIVATION.active
        : FILE_CHAT_OVERLAY_ACTIVATION.deferred,
    emailAttachmentScaleOffset: selectedEmailAttachmentPreviewId
      ? (scaleOffsets.get(selectedEmailAttachmentPreviewId) ?? 0)
      : 0,
    emailPreviewOverlayActivation: isPreviewActive
      ? FILE_CHAT_OVERLAY_ACTIVATION.active
      : FILE_CHAT_OVERLAY_ACTIVATION.deferred,
    emailSidepeekOverlayActivation:
      isPreviewActive || (isActive && tab.facet === "attachments")
        ? FILE_CHAT_OVERLAY_ACTIVATION.active
        : FILE_CHAT_OVERLAY_ACTIVATION.deferred,
    selectedEmailAttachmentPreviewId,
  };
};

const getFileTabEditorState = ({
  canUpdateEntity,
  desktopEditFileType,
  editingDocxTabId,
  entityData,
  filePropertyId,
  flashingDocxEditTabId,
  isNativeDocxDisplay,
  tab,
}: {
  canUpdateEntity: boolean;
  desktopEditFileType: ReturnType<typeof getDesktopEditFileType>;
  editingDocxTabId: string | null;
  entityData:
    | { fields: { id: string; propertyId?: string | undefined }[] }
    | undefined;
  filePropertyId: string | undefined;
  flashingDocxEditTabId: string | null;
  isNativeDocxDisplay: boolean;
  tab: FileTabPanelProps["tab"];
}) => {
  const isEditingNativeDocx =
    isNativeDocxDisplay &&
    editingDocxTabId === tab.id &&
    filePropertyId !== undefined;
  const isCurrentDesktopEditField =
    filePropertyId !== undefined &&
    entityData?.fields.some(
      (field) => field.id === tab.id && field.propertyId === filePropertyId,
    ) === true;
  return {
    canUnlockNativeDocx:
      canUpdateEntity &&
      isNativeDocxDisplay &&
      filePropertyId !== undefined &&
      !isEditingNativeDocx,
    desktopEditTarget:
      canUpdateEntity &&
      desktopEditFileType !== null &&
      filePropertyId !== undefined &&
      isCurrentDesktopEditField
        ? { fileType: desktopEditFileType, propertyId: filePropertyId }
        : null,
    isEditingNativeDocx,
    isMetadataLaneExpanded: (tab.metadataLane ?? "closed") === "expanded",
    isPromptingDocxUnlock: flashingDocxEditTabId === tab.id,
  };
};

const shouldQueryFileTabEntity = ({
  canUpdateEntity,
  desktopEditFileType,
  isActive,
  isEmailViewerActive,
  minimized,
  needsPropertyResolution,
}: {
  canUpdateEntity: boolean;
  desktopEditFileType: ReturnType<typeof getDesktopEditFileType>;
  isActive: boolean;
  isEmailViewerActive: boolean;
  minimized: boolean;
  needsPropertyResolution: boolean;
}) =>
  isEmailViewerActive ||
  needsPropertyResolution ||
  (isActive && !minimized && canUpdateEntity && desktopEditFileType !== null);

type MarkdownSyncInput = {
  fieldId: string;
  isDirty: boolean;
  isMarkdownDisplay: boolean;
  serverText: string | undefined;
};

const shouldSyncMarkdownDraft = ({
  lastSyncInput,
  syncInput,
}: {
  lastSyncInput: MarkdownSyncInput | null;
  syncInput: MarkdownSyncInput;
}) =>
  lastSyncInput === null ||
  lastSyncInput.fieldId !== syncInput.fieldId ||
  lastSyncInput.isDirty !== syncInput.isDirty ||
  lastSyncInput.isMarkdownDisplay !== syncInput.isMarkdownDisplay ||
  lastSyncInput.serverText !== syncInput.serverText;

const getFileTabChromeState = ({
  isEditingNativeDocx,
  isEmailDisplay,
  isMarkdownDisplay,
  isOfficeDisplay,
  tab,
}: {
  isEditingNativeDocx: boolean;
  isEmailDisplay: boolean;
  isMarkdownDisplay: boolean;
  isOfficeDisplay: boolean;
  tab: FileTabPanelProps["tab"];
}) => {
  const isPreviewFacet = (tab.facet ?? "preview") === "preview";
  return {
    canOpenFullView: !isEmailDisplay && !isMarkdownDisplay,
    isPreviewFacet,
    isPreviewOverlayVisible:
      isPreviewFacet &&
      !isEditingNativeDocx &&
      !isEmailDisplay &&
      !isMarkdownDisplay &&
      !isOfficeDisplay,
  };
};

export const FileTabPanel = ({
  activeId,
  canUpdateEntity,
  closeAll,
  commitRename,
  docxActionsRef,
  docxCompatibilityByTab,
  docxScrollTopByTab,
  editingDocxTabId,
  editingTabId,
  editValue,
  flashDocxEditButton,
  flashMinimizeButton,
  flashingDocxEditTabId,
  flashingMinimizeTabId,
  handleCloseTab,
  handleMinimizeFromFullView,
  handleOpenFullView,
  handleResetZoom,
  handleStartDocxEdit,
  handleWheelZoom,
  handleZoom,
  matterColor,
  matterOrigin,
  minimized,
  mountedPdfIds,
  pdfRouteJustification,
  peekPdfViewId,
  ribbonLabelContextMenuOpenAt,
  scaleOffsets,
  setDocxCompatibilityByTab,
  setDocxScrollTopByTab,
  setEditingTabId,
  setEditingDocxTabId,
  setEditValue,
  setScaleOffsets,
  startRename,
  tab,
}: FileTabPanelProps) => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const openFile = useInspectorTabsStore((s) => s.openFile);
  const replaceFileFieldId = useInspectorTabsStore((s) => s.replaceFileFieldId);
  const setFileFacet = useInspectorTabsStore((s) => s.setFileFacet);
  const requestDocxEdit = useInspectorCommandStore((s) => s.requestDocxEdit);
  const {
    canResetZoom,
    desktopEditFileType,
    isActive,
    isEmailDisplay,
    isEmailViewerActive,
    isMarkdownDisplay,
    isNativeDocxDisplay,
    isOfficeDisplay,
    needsPropertyResolution,
    officeViewerFormat,
    renderId,
    requiresPdfMeasurement,
    scaleOffset,
  } = getFileTabDisplayState({ activeId, minimized, scaleOffsets, tab });
  // A DOCX tab opened by a caller that knows only the file field (a review's
  // reference, a search hit) still needs the field's property to mount the
  // editor; read it off the entity rather than leaving the viewer empty.
  const entityQuery = useQuery({
    ...entityOptions(tab.workspaceId, tab.entityId),
    enabled: shouldQueryFileTabEntity({
      canUpdateEntity,
      desktopEditFileType,
      isActive,
      isEmailViewerActive,
      minimized,
      needsPropertyResolution,
    }),
    refetchInterval: ({ state }) =>
      getEmailExtractionRefetchInterval({
        extractionFileFieldId: state.data?.extractionFileFieldId,
        isEmailViewerActive,
      }),
  });
  const {
    emailChatMode,
    filePropertyId,
    resolvedEmailChatMode,
    shouldSurfaceEmailResolutionError,
  } = getFileTabEntityState({
    entityData: entityQuery.data,
    entityQueryError: entityQuery.isError,
    needsPropertyResolution,
    tab,
  });
  const [selectedEmailAttachmentId, setSelectedEmailAttachmentId] = useState<
    string | null
  >(null);
  const {
    emailAttachmentOverlayActivation,
    emailAttachmentScaleOffset,
    emailPreviewOverlayActivation,
    emailSidepeekOverlayActivation,
    selectedEmailAttachmentPreviewId,
  } = getEmailAttachmentState({
    isActive,
    scaleOffsets,
    selectedEmailAttachmentId,
    tab,
  });
  const openEmailAttachment = (attachmentId: string | null) => {
    setSelectedEmailAttachmentId(attachmentId);
    setFileFacet(tab.id, "attachments");
  };
  const resetEmailAttachmentZoom = () => {
    if (selectedEmailAttachmentPreviewId) {
      handleResetZoom(selectedEmailAttachmentPreviewId);
    }
  };
  const zoomEmailAttachment = (direction: "in" | "out") => {
    if (selectedEmailAttachmentPreviewId) {
      handleZoom(selectedEmailAttachmentPreviewId, direction);
    }
  };
  const markdownTextQuery = useQuery({
    ...textFileOptions({ workspaceId: tab.workspaceId, fieldId: tab.id }),
    enabled: isMarkdownDisplay,
  });
  const [markdownDraft, setMarkdownDraft] = useState("");
  const [markdownDraftSourceFieldId, setMarkdownDraftSourceFieldId] = useState<
    string | null
  >(null);
  const markdownText = markdownTextQuery.data?.text ?? "";
  const markdownIsDirty = markdownDraft !== markdownText;
  const [lastMarkdownSyncInput, setLastMarkdownSyncInput] =
    useState<MarkdownSyncInput | null>(null);
  const markdownSaveMutation = useMutation({
    mutationFn: async ({
      entityId,
      fileName,
      text,
      workspaceId,
    }: {
      entityId: string;
      fieldId: string;
      fileName: string;
      propertyId?: string | undefined;
      text: string;
      workspaceId: string;
    }) => {
      const file = new File([text], fileName, { type: MARKDOWN_MIME });
      const response = await api
        .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
        ["upload-version"].post({
          entityId: toSafeId<"entity">(entityId),
          file,
        });

      return unwrapEden(response);
    },
    onSuccess: async (response, variables) => {
      replaceFileFieldId(variables.fieldId, {
        id: response.fieldId,
        fileName: variables.fileName,
        label: tab.label,
        mimeType: MARKDOWN_MIME,
        pdfFileId: null,
        ...(variables.propertyId ? { propertyId: variables.propertyId } : {}),
      });
      stellaToast.add({
        title: t("workspaces.files.versionUploaded"),
        type: "success",
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: filesKeys.all() }),
        queryClient.invalidateQueries({
          queryKey: entitiesKeys.all(variables.workspaceId),
        }),
      ]);
    },
    onError: (error) => {
      analytics.captureError(error);
      stellaToast.add({
        title: t("workspaces.files.versionUploadFailed"),
        description: userErrorFromThrown(error, t("errors.actionFailed")),
        type: "error",
      });
    },
  });

  const markdownSyncInput = {
    fieldId: tab.id,
    isDirty: markdownIsDirty,
    isMarkdownDisplay,
    serverText: markdownTextQuery.data?.text,
  } satisfies MarkdownSyncInput;
  if (
    shouldSyncMarkdownDraft({
      lastSyncInput: lastMarkdownSyncInput,
      syncInput: markdownSyncInput,
    })
  ) {
    setLastMarkdownSyncInput(markdownSyncInput);
    if (!isMarkdownDisplay) {
      setMarkdownDraftSourceFieldId(null);
    } else {
      const decision = getMarkdownDraftSyncDecision({
        ...markdownSyncInput,
        lastSyncedFieldId: markdownDraftSourceFieldId,
      });
      if (decision.type === "sync") {
        setMarkdownDraftSourceFieldId(decision.fieldId);
        setMarkdownDraft(decision.text);
      }
    }
  }

  if (minimized) {
    return null;
  }
  if (!mountedPdfIds.has(tab.id)) {
    return null;
  }
  // DOCX files always render via Folio so the AI keeps
  // block ids to target. The previous justification-driven
  // PDF fallback meant that opening a DOCX with an active
  // AI justification mounted a flat PDF preview — no
  // Folio, no block ids, edits had nowhere to land.
  // Justification bbox highlighting on Folio is a separate
  // follow-up; until then the bbox overlay is omitted on
  // DOCX, but the doc itself remains editable.
  const {
    canUnlockNativeDocx,
    desktopEditTarget,
    isEditingNativeDocx,
    isMetadataLaneExpanded,
    isPromptingDocxUnlock,
  } = getFileTabEditorState({
    canUpdateEntity,
    desktopEditFileType,
    editingDocxTabId,
    entityData: entityQuery.data,
    filePropertyId,
    flashingDocxEditTabId,
    isNativeDocxDisplay,
    tab,
  });
  const isCollaboratingNativeDocx =
    isEditingNativeDocx &&
    env.VITE_FEATURE_FOLIO_COLLAB &&
    env.VITE_COLLAB_URL !== undefined;
  const desktopOpenButton =
    desktopEditTarget !== null ? (
      <DesktopOpenButton
        entityId={tab.entityId}
        fieldId={tab.id}
        fileType={desktopEditTarget.fileType}
        propertyId={desktopEditTarget.propertyId}
        workspaceId={tab.workspaceId}
      />
    ) : null;

  const downloadButton = (
    <Tooltip
      content={t("common.download")}
      render={
        <Button
          aria-label={t("common.download")}
          onClick={() => {
            detached(
              downloadTabOriginalFile({
                fieldId: tab.id,
                fileName: tab.fileName,
                workspaceId: tab.workspaceId,
                onError: (message) => {
                  stellaToast.add({ title: message, type: "error" });
                },
              }),
              "file-tab-panel.download-tab-original-file",
            );
          }}
          size="xs"
          variant="ghost"
        >
          <DownloadIcon className="size-3.5" />
        </Button>
      }
      side="bottom"
    />
  );

  // "Expanded" persona: the route already renders the file in
  // its main content (full folio), so the inspector tab drops
  // the file chrome (zoom, file viewer) and
  // shows itself as a metadata panel — same tab state, different
  // rendering.
  if (isMetadataLaneExpanded) {
    return (
      <div
        className={cn(
          "bg-background flex flex-1 flex-col overflow-hidden",
          !isActive && "hidden",
        )}
        key={renderId}
      >
        <FullViewPreviewGuard
          facet={tab.facet}
          flashMinimize={flashMinimizeButton}
          setFileFacet={setFileFacet}
          tabId={tab.id}
        />
        <InspectorTabHeader
          actions={
            <>
              {downloadButton}
              {desktopOpenButton}
              <Tooltip
                content={t("workspaces.pdf.backToPeek")}
                render={
                  <Button
                    className={cn(
                      "transition-[color,background-color,box-shadow]",
                      flashingMinimizeTabId === tab.id &&
                        "bg-primary/10 text-primary ring-primary/60 animate-pulse ring-2",
                    )}
                    onClick={() => {
                      handleMinimizeFromFullView(tab);
                    }}
                    size="icon-xs"
                    variant="ghost"
                  >
                    <Minimize2Icon className="size-3.5" />
                  </Button>
                }
              />
            </>
          }
          label={stripExtension(tab.label)}
          matter={
            matterOrigin ? (
              <MatterOriginLink
                color={matterOrigin.color}
                id={matterOrigin.id}
                name={matterOrigin.name}
                onClick={matterOrigin.onClick}
              />
            ) : undefined
          }
          onClose={() => handleCloseTab(tab.id)}
          onLabelContextMenu={ribbonLabelContextMenuOpenAt}
          onStartRename={() => startRename(tab)}
          rename={{
            active: editingTabId === tab.id,
            value: editValue,
            onChange: setEditValue,
            onCommit: () => commitRename(tab),
            onCancel: () => setEditingTabId(null),
          }}
        />
        <TabFacetBar
          // Preview is intentionally absent in fullscreen — the
          // main view IS the preview. If the user enters Full
          // view with Preview active in sidepeek, the
          // FullViewPreviewGuard above swaps to Metadata and
          // pulses the Minimize button so they know how to get
          // a side-by-side view back.
          baseFacets={FULLVIEW_FACETS}
          entityId={tab.entityId}
          facet={tab.facet ?? "metadata"}
          fieldId={tab.id}
          fileName={tab.fileName}
          mimeType={tab.mimeType}
          onChange={(next) => {
            setFileFacet(tab.id, next);
            if (next === "suggestions") {
              // Glow the chat input under the file viewer so
              // the user sees the suggestions they're reading
              // came from the chat right below — closes the
              // loop between panel and producer.
              useReviewStore.getState().pulseChatInput(tab.entityId);
            }
          }}
          pulseSeq={tab.facetPulseSeq}
          workspaceId={tab.workspaceId}
        />
        <div className="flex min-h-0 flex-1 flex-col">
          {(tab.facet ?? "metadata") === "metadata" && (
            <Suspense fallback={<MetadataPanelSkeleton />}>
              <EntityMetadataPanel
                activeJustificationFieldId={pdfRouteJustification}
                currentFilePropertyId={filePropertyId ?? null}
                entityId={tab.entityId}
                fileFieldId={tab.id}
                onAiFieldClick={({ fieldId, propertyId }) => {
                  // Keep the inspector tab in sync so
                  // peek-back lands on the same selection.
                  openFile({
                    ...tab,
                    justificationFieldId: fieldId,
                    propertyId,
                  });
                  detached(
                    navigate({
                      to: "/workspaces/$workspaceId/$viewId/document",
                      params: {
                        workspaceId: tab.workspaceId,
                        viewId: peekPdfViewId,
                      },
                      replace: true,
                      search: (prev) => ({
                        ...prev,
                        entity: tab.entityId,
                        field: tab.id,
                        justification: fieldId,
                        justificationPage: 1,
                      }),
                    }),
                    "file-tab-panel.navigate",
                  );
                }}
                workspaceId={tab.workspaceId}
              />
            </Suspense>
          )}
          {tab.facet === "attachments" && isEmailDisplay && (
            <EmailAttachmentsFacet
              chatMode={emailChatMode}
              entityId={tab.entityId}
              fieldId={tab.id}
              fileName={tab.fileName}
              onResetZoom={resetEmailAttachmentZoom}
              onSelectedIdChange={setSelectedEmailAttachmentId}
              onZoomIn={() => zoomEmailAttachment("in")}
              onZoomOut={() => zoomEmailAttachment("out")}
              overlayActivation={emailAttachmentOverlayActivation}
              scaleOffset={emailAttachmentScaleOffset}
              selectedId={selectedEmailAttachmentId}
              workspaceId={tab.workspaceId}
            />
          )}
          {tab.facet === "versions" && (
            <VersionsFacet
              currentFieldId={tab.id}
              entityId={tab.entityId}
              workspaceId={tab.workspaceId}
            />
          )}
          {tab.facet === "suggestions" && (
            <SuggestionsFacet
              entityId={tab.entityId}
              fileFieldId={tab.id}
              workspaceId={tab.workspaceId}
            />
          )}
          {tab.facet === "playbook" && (
            <PlaybookFacet
              entityId={tab.entityId}
              fileFieldId={tab.id}
              workspaceId={tab.workspaceId}
            />
          )}
          {tab.facet === "anonymization" && (
            <AnonymizationFacet
              activeFieldId={tab.id}
              entityId={tab.entityId}
              isVisible={isActive}
              workspaceId={tab.workspaceId}
            />
          )}
          {/* No preview branch in fullscreen: the main view
           *  IS the preview. FullViewPreviewGuard above swaps
           *  a stale "preview" facet to "metadata" on entry
           *  and pulses the Minimize button. */}
        </div>
      </div>
    );
  }

  const promptDocxUnlock = () => {
    const compatibility = docxCompatibilityByTab.get(tab.id);
    const blockReason = getDocxEditBlockReason({
      canSafelyEdit: compatibility?.canSafelyEdit,
    });
    if (blockReason === "pendingCompatibility") {
      // Queue the unlock via the inspector's pending-edit slot;
      // `use-docx-tab-edit-session` re-runs once canSafelyEdit
      // resolves and enters edit mode silently. Avoids a
      // "still verifying…" toast on what reads as a non-action.
      requestDocxEdit(tab.id);
      return;
    }

    if (blockReason === "unsafe") {
      // Editing is blocked because Folio can't safely rewrite this DOCX. The
      // block is surfaced quietly on the composer's edit-mode control (a "View
      // only" chip) instead of a disruptive toast; just stay locked.
      return;
    }
    if (canUnlockNativeDocx) {
      flashDocxEditButton(tab.id);
    }
  };

  // Edit ↔ Save is a single mode toggle, so it lives in
  // exactly one place — the tab header — alongside Full
  // view. Both buttons use the same labelled-text shape so
  // the row reads consistently. The floating overlay below
  // is for ephemeral preview controls only (zoom). The
  // toggle is gated on the Preview facet because switching
  // facets unmounts the editor; if the user is on a non-
  // preview facet, we hide the toggle entirely (Full view
  // alone) rather than show a button that would no-op.
  const { canOpenFullView, isPreviewFacet, isPreviewOverlayVisible } =
    getFileTabChromeState({
      isEditingNativeDocx,
      isEmailDisplay,
      isMarkdownDisplay,
      isOfficeDisplay,
      tab,
    });
  const markdownActions = (() => {
    if (!isMarkdownDisplay) {
      return null;
    }

    return (
      markdownIsDirty && (
        <>
          <Button
            disabled={markdownSaveMutation.isPending}
            onClick={() => {
              setMarkdownDraft(markdownText);
            }}
            size="xs"
            variant="ghost"
          >
            <XIcon className="size-3.5" />
            {t("common.cancel")}
          </Button>
          <Button
            disabled={markdownSaveMutation.isPending}
            onClick={() => {
              markdownSaveMutation.mutate({
                entityId: tab.entityId,
                fieldId: tab.id,
                fileName: tab.fileName,
                propertyId: filePropertyId,
                text: markdownDraft,
                workspaceId: tab.workspaceId,
              });
            }}
            size="xs"
          >
            <CheckIcon className="size-3.5" />
            {t("common.save")}
          </Button>
        </>
      )
    );
  })();

  const editToggle = (() => {
    if (isEditingNativeDocx) {
      return (
        <Button
          className={cn(
            "transition-colors",
            isCollaboratingNativeDocx && "min-h-11",
          )}
          onClick={() => {
            docxActionsRef.current.get(tab.id)?.finalize();
          }}
          size="xs"
        >
          {isCollaboratingNativeDocx ? (
            <GitCommitHorizontalIcon className="size-3.5" />
          ) : (
            <CheckIcon className="size-3.5" />
          )}
          {isCollaboratingNativeDocx
            ? t("folio.createVersion")
            : t("common.save")}
        </Button>
      );
    }
    if (canUnlockNativeDocx) {
      return (
        <Button
          className={cn(
            "transition-[color,background-color,box-shadow]",
            isPromptingDocxUnlock &&
              "bg-primary/10 text-primary ring-primary/60 animate-pulse ring-2",
          )}
          onClick={() => {
            detached(
              handleStartDocxEdit(tab.id),
              "file-tab-panel.start-docx-edit",
            );
          }}
          size="xs"
          variant="ghost"
        >
          <LockOpenIcon className="size-3.5" />
          {t("common.edit")}
        </Button>
      );
    }
    return null;
  })();

  const fullViewButton = (
    <Button
      onClick={() => {
        detached(handleOpenFullView(), "file-tab-panel.open-full-view");
      }}
      size="xs"
      variant="ghost"
    >
      <Maximize2Icon className="size-3.5" />
      {t("workspaces.pdf.fullView")}
    </Button>
  );

  const fileActions = (
    <>
      {downloadButton}
      {desktopOpenButton}
      {isPreviewFacet && (markdownActions ?? editToggle)}
      {canOpenFullView && fullViewButton}
    </>
  );

  // Floating preview-only toolbar mounted on top of the
  // viewer body — zoom controls only. The Edit / Save mode
  // toggle lives in the tab header (`fileActions` above) so
  // primary state changes have one stable location.
  const previewOverlay = isPreviewOverlayVisible ? (
    <div className="bg-background/80 supports-[backdrop-filter]:bg-background/65 absolute end-2 top-2 z-10 flex items-center gap-1 rounded-md border p-0.5 shadow-sm backdrop-blur">
      <PeekPdfControls
        canResetZoom={canResetZoom}
        onResetZoom={() => handleResetZoom(tab.id)}
        onZoomIn={() => handleZoom(tab.id, "in")}
        onZoomOut={() => handleZoom(tab.id, "out")}
        scaleOffset={scaleOffset}
      />
    </div>
  ) : null;

  const contextBar = (
    <InspectorTabHeader
      actions={fileActions}
      label={stripExtension(tab.label)}
      matter={
        matterOrigin ? (
          <MatterOriginLink
            color={matterOrigin.color}
            id={matterOrigin.id}
            name={matterOrigin.name}
            onClick={matterOrigin.onClick}
          />
        ) : undefined
      }
      matterColor={matterColor}
      onClose={() => handleCloseTab(tab.id)}
      onLabelContextMenu={ribbonLabelContextMenuOpenAt}
      onStartRename={() => startRename(tab)}
      rename={{
        active: editingTabId === tab.id,
        value: editValue,
        onChange: setEditValue,
        onCommit: () => commitRename(tab),
        onCancel: () => setEditingTabId(null),
      }}
    />
  );

  const viewerErrorFallback = ({ reset }: { reset: () => void }) => (
    <InspectorPdfErrorFallback onRetry={reset} />
  );

  const handleViewerError = () => {
    stellaToast.add({
      title: t("errors.actionFailed"),
      type: "error",
    });
  };

  const handleDocxScrollTopChange = (scrollTop: number) => {
    setDocxScrollTopByTab((prev) => {
      const next = new Map(prev);
      next.set(tab.id, scrollTop);
      return next;
    });
  };

  const fileViewer = (() => {
    if (isEmailDisplay) {
      if (shouldSurfaceEmailResolutionError) {
        return (
          <EmailFileViewer
            chatMode={EMAIL_CHAT_MODE.resolutionError}
            entityId={tab.entityId}
            fieldId={tab.id}
            fileName={tab.fileName}
            onOpenAttachment={openEmailAttachment}
            overlayActivation={emailPreviewOverlayActivation}
            onRetryChatResolution={() => {
              detached(entityQuery.refetch(), "file-tab-panel.refetch");
            }}
            chatHost={EMAIL_CHAT_HOST.parent}
            workspaceId={tab.workspaceId}
          />
        );
      }
      return (
        <EmailFileViewer
          chatMode={resolvedEmailChatMode}
          entityId={tab.entityId}
          fieldId={tab.id}
          fileName={tab.fileName}
          onOpenAttachment={openEmailAttachment}
          overlayActivation={emailPreviewOverlayActivation}
          chatHost={EMAIL_CHAT_HOST.parent}
          workspaceId={tab.workspaceId}
        />
      );
    }
    if (isMarkdownDisplay) {
      if (markdownTextQuery.isPending) {
        return (
          <div className="text-muted-foreground flex min-h-0 flex-1 items-center justify-center p-6 text-sm">
            {t("common.loading")}
          </div>
        );
      }
      if (markdownTextQuery.error) {
        return (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
            <p className="text-muted-foreground max-w-sm text-sm">
              {markdownTextQuery.error.message || t("errors.actionFailed")}
            </p>
            <Button
              onClick={() => {
                detached(markdownTextQuery.refetch(), "file-tab-panel.refetch");
              }}
              size="xs"
              variant="secondary"
            >
              {t("common.retry")}
            </Button>
          </div>
        );
      }
      // Workspace .md edits use the same hybrid editor as skills. Edits feed
      // the draft; the existing Save button uploads a new file version.
      return (
        <MarkdownHybridEditor
          imagePolicy="data-only"
          key={tab.id}
          markdown={markdownText}
          onMarkdownChange={setMarkdownDraft}
          readOnly={!canUpdateEntity}
        />
      );
    }
    if (isOfficeDisplay && officeViewerFormat !== null) {
      return (
        <QuerySuspenseBoundary
          area="office-file-viewer"
          errorFallback={viewerErrorFallback}
          resetKeys={[tab.id]}
          suspenseFallback={
            <div className="text-muted-foreground flex min-h-0 flex-1 items-center justify-center text-sm">
              {t("common.loading")}
            </div>
          }
        >
          <OfficeFileViewer
            desktopEditTarget={desktopEditTarget}
            entityId={tab.entityId}
            fieldId={tab.id}
            fileName={tab.fileName}
            format={officeViewerFormat}
            key={tab.id}
            workspaceId={tab.workspaceId}
          />
        </QuerySuspenseBoundary>
      );
    }
    if (isNativeDocxDisplay) {
      if (filePropertyId === undefined) {
        // Still resolving the field's property, or the entity no longer
        // holds this field: never fall through to the PDF viewer, which has
        // nothing to draw for a DOCX.
        return entityQuery.data === undefined && !entityQuery.isError ? (
          <PeekSuspenseFallback />
        ) : (
          <InspectorPdfErrorFallback />
        );
      }
      return (
        <DocxBrowserEditor
          actionsKey={tab.id}
          actionsMapRef={docxActionsRef}
          entityId={tab.entityId}
          errorFallback={viewerErrorFallback}
          fieldId={tab.id}
          initialScrollTop={docxScrollTopByTab.get(tab.id)}
          isEditing={isEditingNativeDocx}
          onClose={() => {
            // Don't touch docxActionsRef here. The editor stays
            // mounted across error → idle transitions; only its
            // own cleanup effect should release the slot, otherwise
            // the next "Edit file" click finds no entry and silently
            // no-ops. setEditingDocxTabId(null) is enough to flip
            // the UI back out of edit mode.
            setEditingDocxTabId(null);
          }}
          onCompatibilityChange={(compatibility) => {
            setDocxCompatibilityByTab((prev) => {
              if (prev.get(tab.id) === compatibility) {
                return prev;
              }
              const next = new Map(prev);
              next.set(tab.id, compatibility);
              return next;
            });
          }}
          onError={handleViewerError}
          onReadonlyEditAttempt={promptDocxUnlock}
          onSaved={(fieldId) => {
            if (fieldId !== tab.id) {
              setDocxScrollTopByTab((prev) => {
                const scrollTop = prev.get(tab.id);
                if (scrollTop === undefined) {
                  return prev;
                }
                const next = new Map(prev);
                next.set(fieldId, scrollTop);
                return next;
              });
              setScaleOffsets((prev) => {
                const savedScaleOffset = prev.get(tab.id);
                if (savedScaleOffset === undefined) {
                  return prev;
                }
                const next = new Map(prev);
                next.set(fieldId, savedScaleOffset);
                return next;
              });
              useInspectorTabsStore
                .getState()
                .replaceFileFieldId(tab.id, fieldId);
            }
          }}
          onScrollTopChange={handleDocxScrollTopChange}
          propertyId={filePropertyId}
          scaleOffset={scaleOffset}
          showActionBar={false}
          surface="inspector"
          workspaceId={tab.workspaceId}
        />
      );
    }
    return (
      <PeekPdfViewer
        activePropertyId={filePropertyId ?? ""}
        entityId={tab.entityId}
        errorFallback={viewerErrorFallback}
        fieldId={tab.id}
        filePurpose="display"
        mimeType={tab.mimeType ?? undefined}
        onDocxScrollTopChange={handleDocxScrollTopChange}
        onError={handleViewerError}
        onPeekNavigate={closeAll}
        onWheelZoom={(deltaY) => handleWheelZoom(tab.id, deltaY)}
        scaleOffset={scaleOffset}
        viewId={peekPdfViewId}
        workspaceId={tab.workspaceId}
      />
    );
  })();

  const viewerPane = (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {tab.justificationFieldId !== undefined &&
        !isEmailDisplay &&
        !isMarkdownDisplay && (
          <Suspense
            fallback={
              <div
                className={cn(
                  "text-muted-foreground flex items-center border-b px-3 text-xs italic",
                  TOOLBAR_ROW_HEIGHT,
                )}
              >
                {t("common.loading")}...
              </div>
            }
          >
            <DocumentAiSourceBar
              activeTab={tab}
              fieldId={tab.justificationFieldId}
              isActiveTab={isActive}
              workspaceId={tab.workspaceId}
            />
          </Suspense>
        )}
      <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {fileViewer}
        {previewOverlay}
      </div>
    </div>
  );

  const viewerContent = (
    <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
      {viewerPane}
    </div>
  );

  const sidepeekFacet = tab.facet ?? "preview";

  // Facet bar stays visible during edit. The viewer (with the
  // live editor) is kept mounted via CSS hide on facet switches
  // (see `sidepeekBody` below) so unsaved session state survives a
  // pop-out to Metadata / Versions / etc. and is restored intact
  // when the user returns to Preview.
  const facetBar = (
    <TabFacetBar
      baseFacets={FACETS}
      entityId={tab.entityId}
      facet={sidepeekFacet}
      fieldId={tab.id}
      fileName={tab.fileName}
      mimeType={tab.mimeType}
      onChange={(next) => {
        setFileFacet(tab.id, next);
      }}
      pulseSeq={tab.facetPulseSeq}
      workspaceId={tab.workspaceId}
    />
  );

  // Sidepeek body — `preview` keeps the existing viewer
  // (PDF/DOCX zoom, justification bar, etc.); the other
  // facets render the same content as the fullscreen branch
  // so the inspector tab is one consistent workbench
  // regardless of mode.
  //
  // The viewer stays mounted across facet switches and is
  // visually hidden when off-Preview, so the DOCX/PDF doesn't
  // re-parse every time the user pops out to Metadata and back.
  const isPreviewVisible = sidepeekFacet === "preview";
  const sidepeekBody = (
    <>
      <div
        className={cn(
          "min-h-0 min-w-0 flex-1",
          isPreviewVisible ? "flex" : "hidden",
        )}
      >
        {viewerContent}
      </div>
      {!isPreviewVisible && (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {sidepeekFacet === "metadata" && (
            <Suspense fallback={<MetadataPanelSkeleton />}>
              <EntityMetadataPanel
                activeJustificationFieldId={pdfRouteJustification}
                currentFilePropertyId={filePropertyId ?? null}
                entityId={tab.entityId}
                fileFieldId={tab.id}
                onAiFieldClick={({ fieldId, propertyId }) => {
                  openFile({
                    ...tab,
                    justificationFieldId: fieldId,
                    propertyId,
                  });
                  detached(
                    navigate({
                      to: "/workspaces/$workspaceId/$viewId/document",
                      params: {
                        workspaceId: tab.workspaceId,
                        viewId: peekPdfViewId,
                      },
                      replace: true,
                      search: (prev) => ({
                        ...prev,
                        entity: tab.entityId,
                        field: tab.id,
                        justification: fieldId,
                        justificationPage: 1,
                      }),
                    }),
                    "file-tab-panel.navigate",
                  );
                }}
                workspaceId={tab.workspaceId}
              />
            </Suspense>
          )}
          {sidepeekFacet === "attachments" && isEmailDisplay && (
            <EmailAttachmentsFacet
              chatMode={emailChatMode}
              entityId={tab.entityId}
              fieldId={tab.id}
              fileName={tab.fileName}
              onResetZoom={resetEmailAttachmentZoom}
              onSelectedIdChange={setSelectedEmailAttachmentId}
              onZoomIn={() => zoomEmailAttachment("in")}
              onZoomOut={() => zoomEmailAttachment("out")}
              overlayActivation={emailAttachmentOverlayActivation}
              scaleOffset={emailAttachmentScaleOffset}
              selectedId={selectedEmailAttachmentId}
              chatHost={EMAIL_CHAT_HOST.parent}
              workspaceId={tab.workspaceId}
            />
          )}
          {sidepeekFacet === "versions" && (
            <VersionsFacet
              currentFieldId={tab.id}
              entityId={tab.entityId}
              workspaceId={tab.workspaceId}
            />
          )}
          {sidepeekFacet === "suggestions" && (
            <SuggestionsFacet
              entityId={tab.entityId}
              fileFieldId={tab.id}
              workspaceId={tab.workspaceId}
              // Quick fix: sidepeek's DOCX editor unmounts when
              // the user switches off Preview, so Accept on a
              // suggestion has no live editor to apply against.
              // Route to the DOCX main view, where the editor is
              // mounted by default and the same `<SuggestionsFacet>`
              // (rendered by the fullscreen branch above) reuses
              // the registration.
              // Replace with an in-app approval flow that doesn't need the
              // full editor mounted.
              //
              // Only the *active* tab is allowed to redirect.
              // Non-active PDF tabs stay mounted (CSS-hidden) so
              // their facet panels still run effects; without
              // this gate a background tab whose facet happens
              // to be "suggestions" would hijack the route to
              // its own document view. Per Codex review on
              // PR #80.
              {...(isActive
                ? {
                    onMissingEditor: () => {
                      // Pre-select the suggestions facet on
                      // the inspector store so the document
                      // route's inspector lands directly on
                      // this panel instead of the default
                      // Preview.
                      setFileFacet(tab.id, "suggestions");
                      // Replace the current history entry
                      // rather than pushing a new one. This is
                      // an automatic, user-didn't-click-anything
                      // redirect: pushing creates a back-button
                      // trap (Back returns to the previous
                      // sidepeek state, which immediately
                      // remounts SuggestionsFacet without an
                      // editor and pushes again — bouncing).
                      // With `replace` the same Back gesture
                      // takes the user out of the suggestions
                      // flow entirely. Per Codex review on
                      // PR #80.
                      detached(
                        navigate({
                          to: "/workspaces/$workspaceId/$viewId/document",
                          params: {
                            workspaceId: tab.workspaceId,
                            viewId: peekPdfViewId,
                          },
                          replace: true,
                          search: (prev) => ({
                            ...prev,
                            entity: tab.entityId,
                            field: tab.id,
                          }),
                        }),
                        "file-tab-panel.navigate",
                      );
                    },
                  }
                : {})}
            />
          )}
          {sidepeekFacet === "playbook" && (
            <PlaybookFacet
              entityId={tab.entityId}
              fileFieldId={tab.id}
              workspaceId={tab.workspaceId}
            />
          )}
          {sidepeekFacet === "anonymization" && (
            // Sidepeek shows the file as a thumbnail-sized preview
            // without an interactive Folio editor underneath, so
            // there's no per-document match data to display. Pass
            // `activeFieldId={null}` so the facet renders the
            // "open full view first" hint instead of a zero count
            // that the user can't act on from here.
            <AnonymizationFacet
              activeFieldId={null}
              entityId={tab.entityId}
              onOpenFullView={() => {
                detached(handleOpenFullView(), "file-tab-panel.open-full-view");
              }}
              workspaceId={tab.workspaceId}
            />
          )}
        </div>
      )}
    </>
  );
  const sidepeekContent = isEmailDisplay ? (
    <EmailViewerWithAI
      chatMode={emailChatMode}
      entityId={tab.entityId}
      fieldId={tab.id}
      fileName={tab.fileName}
      overlayActivation={emailSidepeekOverlayActivation}
      workspaceId={tab.workspaceId}
    >
      {sidepeekBody}
      {shouldSurfaceEmailResolutionAlert({
        isEmailDisplay,
        isPreviewVisible,
        resolutionFailed: shouldSurfaceEmailResolutionError,
      }) ? (
        <EmailChatResolutionAlert
          onRetry={() => {
            detached(entityQuery.refetch(), "file-tab-panel.refetch");
          }}
        />
      ) : null}
    </EmailViewerWithAI>
  ) : (
    sidepeekBody
  );
  return (
    <div
      className={cn(
        "flex flex-1 flex-col overflow-hidden",
        !isActive && "hidden",
      )}
      key={renderId}
    >
      {contextBar}
      {facetBar}
      <FileTabMeasurementBoundary
        active={isActive}
        fieldId={tab.id}
        measured={requiresPdfMeasurement}
        onError={handleViewerError}
        scaleOffset={scaleOffset}
      >
        {sidepeekContent}
      </FileTabMeasurementBoundary>
    </div>
  );
};

const FileTabMeasurementBoundary = ({
  active,
  children,
  fieldId,
  measured,
  onError,
  scaleOffset,
}: {
  active: boolean;
  children: ReactElement;
  fieldId: string;
  measured: boolean;
  onError: () => void;
  scaleOffset: number;
}): ReactElement => {
  if (!measured) {
    return children;
  }
  return (
    <div className="min-h-0 min-w-0 flex-1">
      <MeasuredPdfProvider
        active={active}
        fallback={{
          suspense: <PeekSuspenseFallback />,
          error: <InspectorPdfErrorFallback />,
        }}
        fieldId={fieldId}
        initialScaleOffset={scaleOffset}
        onError={onError}
      >
        {children}
      </MeasuredPdfProvider>
    </div>
  );
};
