import { useState } from "react";
import type {
  Dispatch,
  MouseEvent,
  ReactElement,
  ReactNode,
  RefObject,
  SetStateAction,
} from "react";

import { CheckIcon, GitCommitHorizontalIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import type { DocxCompatibility } from "@stll/folio-react";
import { Button } from "@stll/ui/button";
import { stellaToast } from "@stll/ui/toast";
import { cn } from "@stll/ui/utils";

import type { FileChatOverlayActivation } from "@/components/ai-suggestions/file-viewer-with-ai-config";
import {
  REVIEW_SUGGESTION_ORIGIN,
  useReviewStore,
} from "@/components/ai-suggestions/review-store";
import type { DocxBrowserEditorActions } from "@/components/docx/use-docx-browser-editor-actions";
import { useFileAnonymizationPipeline } from "@/components/inspector/anonymize-pdf";
import {
  EmailChatResolutionAlert,
  EmailViewerWithAI,
} from "@/components/inspector/email-html-viewer";
import type { EmailChatMode } from "@/components/inspector/email-html-viewer.logic";
import { TabFacetBar } from "@/components/inspector/file-facets";
import type { Facet } from "@/components/inspector/file-facets";
import { FileTabFacetContent } from "@/components/inspector/file-tab-facet-content";
import { FileTabFullView } from "@/components/inspector/file-tab-full-view";
import {
  BackToPeekButton,
  FileTabHeaderActions,
  getFileTabHeaderProps,
  MoveToMainButton,
} from "@/components/inspector/file-tab-header";
import type { MatterOrigin } from "@/components/inspector/file-tab-header";
import {
  FACETS,
  getFileTabDisplayState,
  shouldRunFileAnonymizationPipeline,
  shouldSurfaceEmailResolutionAlert,
} from "@/components/inspector/file-tab-panel.logic";
import { FileTabViewer } from "@/components/inspector/file-tab-viewer";
import { InspectorPdfErrorFallback } from "@/components/inspector/inspector-pdf-error-fallback";
import { InspectorTabHeader } from "@/components/inspector/inspector-tab-header";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import type { FileTab } from "@/components/inspector/inspector-tabs-store";
import { MarkdownDraftActions } from "@/components/inspector/markdown-file-viewer";
import { MeasuredPdfProvider } from "@/components/inspector/measured-pdf-provider";
import { useDocxEditorBindings } from "@/components/inspector/use-docx-editor-bindings";
import { useEmailAttachmentSelection } from "@/components/inspector/use-email-attachment-selection";
import { useFileTabEntity } from "@/components/inspector/use-file-tab-entity";
import { useMarkdownFileDraft } from "@/components/inspector/use-markdown-file-draft";
import { PeekSuspenseFallback } from "@/components/pdf/peek/peek-pdf-viewer";
import { env } from "@/env";
import type { getDesktopEditFileType } from "@/lib/desktop-edit-formats";
import { detached } from "@/lib/detached";
import type { PDFColorMode } from "@/lib/pdf/pdf-color-mode";

type FileTabPanelProps = {
  activeId: string | null;
  canUpdateEntity: boolean;
  closeAll: () => void;
  commitRename: (tab: FileTab) => void;
  docxActionsRef: RefObject<Map<string, DocxBrowserEditorActions>>;
  docxScrollTopByTab: ReadonlyMap<string, number>;
  editingDocxTabId: string | null;
  editingTabId: string | null;
  editValue: string;
  handleCloseTab: (tabId: string) => void;
  handleMinimizeFromFullView: (tab: FileTab) => void;
  handleOpenFullView: () => Promise<void>;
  handleResetZoom: (tabId: string) => void;
  handleWheelZoom: (tabId: string, deltaY: number) => void;
  handleZoom: (tabId: string, direction: "in" | "out") => void;
  matterOrigin: MatterOrigin | null;
  minimized: boolean;
  mountedPdfIds: ReadonlySet<string>;
  /** The document route's file field while its main pane is showing the
   *  review; `null` in the default arrangement. That tab reads the document
   *  itself, so it keeps its preview instead of the metadata persona. */
  documentReviewPaneFieldId: string | null;
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

/**
 * Glow the chat input under the file viewer when a reviewer opens the
 * document-review facet on a document the chat has already proposed changes
 * to, so they see the "From chat" group came from the composer right below.
 *
 * Gated on there being such a proposal: the facet is also the playbook-review
 * launcher, and pulsing the composer every time someone opens it would say
 * nothing.
 */
const pulseChatInputForReview = (facet: Facet, entityId: string): void => {
  if (facet !== "playbook") {
    return;
  }
  const store = useReviewStore.getState();
  // No entry at all means the chat has proposed nothing for this document.
  const hasChatProposal = store.sessions[entityId]?.some(
    (item) => item.origin === REVIEW_SUGGESTION_ORIGIN.chat,
  );
  if (hasChatProposal === true) {
    store.pulseChatInput(entityId);
  }
};

const getFileTabEditorState = ({
  canUpdateEntity,
  desktopEditFileType,
  editingDocxTabId,
  entityData,
  filePropertyId,
  isNativeDocxDisplay,
  isPdfDisplay,
  tab,
}: {
  canUpdateEntity: boolean;
  desktopEditFileType: ReturnType<typeof getDesktopEditFileType>;
  editingDocxTabId: string | null;
  entityData:
    | { fields: { id: string; propertyId?: string | undefined }[] }
    | undefined;
  filePropertyId: string | undefined;
  isNativeDocxDisplay: boolean;
  isPdfDisplay: boolean;
  tab: FileTabPanelProps["tab"];
}) => {
  const isEditingNativeDocx =
    isNativeDocxDisplay &&
    editingDocxTabId === tab.id &&
    filePropertyId !== undefined;
  const isCollaboratingNativeDocx =
    isEditingNativeDocx &&
    env.VITE_FEATURE_FOLIO_COLLAB &&
    env.VITE_COLLAB_URL !== undefined;
  // Both desktop hand-offs write a new version of the property's current
  // file, so neither is offered while the panel shows an older version.
  const isCurrentFileField =
    filePropertyId !== undefined &&
    entityData?.fields.some(
      (field) => field.id === tab.id && field.propertyId === filePropertyId,
    ) === true;
  return {
    desktopEditTarget:
      canUpdateEntity &&
      desktopEditFileType !== null &&
      filePropertyId !== undefined &&
      isCurrentFileField
        ? { fileType: desktopEditFileType, propertyId: filePropertyId }
        : null,
    isCollaboratingNativeDocx,
    isEditingNativeDocx,
    isMetadataLaneExpanded: (tab.metadataLane ?? "closed") === "expanded",
    pdfSignTarget:
      canUpdateEntity &&
      isPdfDisplay &&
      filePropertyId !== undefined &&
      isCurrentFileField
        ? { propertyId: filePropertyId }
        : null,
  };
};

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
  docxScrollTopByTab,
  editingDocxTabId,
  editingTabId,
  editValue,
  handleCloseTab,
  handleMinimizeFromFullView,
  handleOpenFullView,
  handleResetZoom,
  handleWheelZoom,
  handleZoom,
  matterOrigin,
  minimized,
  mountedPdfIds,
  documentReviewPaneFieldId,
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
  const [pdfColorMode, setPDFColorMode] = useState<PDFColorMode>("system");
  const setFileFacet = useInspectorTabsStore((s) => s.setFileFacet);
  const display = getFileTabDisplayState({
    activeId,
    minimized,
    scaleOffsets,
    tab,
  });
  const {
    desktopEditFileType,
    isActive,
    isEmailDisplay,
    isMarkdownDisplay,
    isNativeDocxDisplay,
    isOfficeDisplay,
    isPdfDisplay,
    renderId,
    requiresPdfMeasurement,
    scaleOffset,
  } = display;
  // This tab is the route's document while the route's own pane is showing the
  // review: the inspector is where the document is read, so the fullscreen
  // persona keeps its preview.
  const readsDocumentInInspector = documentReviewPaneFieldId === tab.id;
  const fullViewFacet =
    tab.facet ?? (readsDocumentInInspector ? "preview" : "metadata");
  useFileAnonymizationPipeline({
    enabled: shouldRunFileAnonymizationPipeline({
      facet: fullViewFacet,
      isActive,
      isFullView: tab.metadataLane === "expanded",
      isMinimized: minimized,
      isMounted: mountedPdfIds.has(tab.id),
      isNativeDocxDisplay,
    }),
    fieldId: tab.id,
    mimeType: tab.mimeType,
    workspaceId: tab.workspaceId,
    entityId: tab.entityId,
  });
  const entity = useFileTabEntity({
    canUpdateEntity,
    desktopEditFileType,
    isActive,
    isEmailViewerActive: display.isEmailViewerActive,
    isPdfDisplay,
    minimized,
    needsPropertyResolution: display.needsPropertyResolution,
    tab,
  });
  const { emailChatMode, filePropertyId } = entity;
  const emailAttachments = useEmailAttachmentSelection({
    handleResetZoom,
    handleZoom,
    isActive,
    scaleOffsets,
    tab,
  });
  const markdown = useMarkdownFileDraft({
    filePropertyId,
    isMarkdownDisplay,
    tab,
  });

  const handleViewerError = () => {
    stellaToast.add({
      title: t("errors.actionFailed"),
      type: "error",
    });
  };

  const docxEditor = useDocxEditorBindings({
    docxActionsRef,
    onError: handleViewerError,
    setDocxCompatibilityByTab,
    setDocxScrollTopByTab,
    setEditingDocxTabId,
    setScaleOffsets,
    tabId: tab.id,
  });

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
    desktopEditTarget,
    isCollaboratingNativeDocx,
    isEditingNativeDocx,
    isMetadataLaneExpanded,
    pdfSignTarget,
  } = getFileTabEditorState({
    canUpdateEntity,
    desktopEditFileType,
    editingDocxTabId,
    entityData: entity.query.data,
    filePropertyId,
    isNativeDocxDisplay,
    isPdfDisplay,
    tab,
  });

  // Entering edit mode happens in the document itself: clicking or typing
  // into a locked DOCX unlocks it. The header carries only the exit — Save
  // or Create version — while editing. It is gated on the Preview facet
  // because switching facets unmounts the editor.
  const { canOpenFullView, isPreviewFacet, isPreviewOverlayVisible } =
    getFileTabChromeState({
      isEditingNativeDocx,
      isEmailDisplay,
      isMarkdownDisplay,
      isOfficeDisplay,
      tab,
    });
  const editExit = isMarkdownDisplay ? (
    <MarkdownDraftActions draft={markdown} />
  ) : (
    isEditingNativeDocx && (
      <DocxFinalizeButton
        docxActionsRef={docxActionsRef}
        isCollaborating={isCollaboratingNativeDocx}
        isCollaborationPublishable={docxEditor.isCollaborationPublishable}
        tabId={tab.id}
      />
    )
  );

  const tabHeader = getFileTabHeaderProps({
    commitRename,
    editingTabId,
    editValue,
    handleCloseTab,
    matterOrigin,
    ribbonLabelContextMenuOpenAt,
    setEditingTabId,
    setEditValue,
    startRename,
    tab,
  });

  const changeFacet = (next: Facet) => {
    setFileFacet(tab.id, next);
    pulseChatInputForReview(next, tab.entityId);
  };

  const viewerContent = (
    <FileTabViewer
      canUpdateEntity={canUpdateEntity}
      closeAll={closeAll}
      desktopEditTarget={desktopEditTarget}
      display={display}
      docxEditor={docxEditor}
      docxInitialScrollTop={docxScrollTopByTab.get(tab.id)}
      emailAttachments={emailAttachments}
      entity={entity}
      handleResetZoom={handleResetZoom}
      handleWheelZoom={handleWheelZoom}
      handleZoom={handleZoom}
      isEditingNativeDocx={isEditingNativeDocx}
      isZoomOverlayVisible={isPreviewOverlayVisible}
      markdown={markdown}
      onPdfColorModeChange={setPDFColorMode}
      onViewerError={handleViewerError}
      pdfColorMode={pdfColorMode}
      peekPdfViewId={peekPdfViewId}
      tab={tab}
    />
  );
  const facetContentProps = {
    emailAttachments: isEmailDisplay ? emailAttachments : null,
    emailChatMode,
    filePropertyId,
    pdfRouteJustification,
    peekPdfViewId,
    tab,
  };

  if (isMetadataLaneExpanded) {
    return (
      <FileTabFullView
        facet={fullViewFacet}
        facetContent={
          <FileTabFacetContent
            {...facetContentProps}
            facet={fullViewFacet}
            persona={{ type: "fullView", isActive }}
          />
        }
        header={
          <InspectorTabHeader
            actions={
              <FileTabHeaderActions
                desktopEditTarget={desktopEditTarget}
                downloadRenditions={entity.downloadRenditions}
                pdfSignTarget={pdfSignTarget}
                tab={tab}
              >
                <BackToPeekButton
                  onMinimize={() => handleMinimizeFromFullView(tab)}
                />
              </FileTabHeaderActions>
            }
            {...tabHeader}
          />
        }
        isActive={isActive}
        key={renderId}
        onFacetChange={changeFacet}
        readsDocumentInInspector={readsDocumentInInspector}
        tab={tab}
        viewer={viewerContent}
      />
    );
  }

  const sidepeekFacet = tab.facet ?? "preview";
  return (
    <FileTabSidepeek
      email={
        isEmailDisplay
          ? {
              chatMode: emailChatMode,
              onRetryChatResolution: () => {
                detached(entity.query.refetch(), "file-tab-panel.refetch");
              },
              overlayActivation:
                emailAttachments.emailSidepeekOverlayActivation,
              resolutionFailed: entity.shouldSurfaceEmailResolutionError,
            }
          : null
      }
      facet={sidepeekFacet}
      facetContent={
        <FileTabFacetContent
          {...facetContentProps}
          facet={sidepeekFacet}
          persona={{
            type: "sidepeek",
            onOpenFullView: () => {
              detached(handleOpenFullView(), "file-tab-panel.open-full-view");
            },
          }}
        />
      }
      header={
        <InspectorTabHeader
          actions={
            <FileTabHeaderActions
              desktopEditTarget={desktopEditTarget}
              downloadRenditions={entity.downloadRenditions}
              pdfSignTarget={pdfSignTarget}
              tab={tab}
            >
              {isPreviewFacet && editExit}
              {canOpenFullView && (
                <MoveToMainButton onOpenFullView={handleOpenFullView} />
              )}
            </FileTabHeaderActions>
          }
          {...tabHeader}
        />
      }
      isActive={isActive}
      key={renderId}
      measured={requiresPdfMeasurement}
      onFacetChange={changeFacet}
      onViewerError={handleViewerError}
      scaleOffset={scaleOffset}
      tab={tab}
      viewer={viewerContent}
    />
  );
};

type DocxFinalizeButtonProps = {
  docxActionsRef: RefObject<Map<string, DocxBrowserEditorActions>>;
  isCollaborating: boolean;
  isCollaborationPublishable: boolean;
  tabId: string;
};

/** The exit from DOCX editing: Save, or Create version while collaborating. */
const DocxFinalizeButton = ({
  docxActionsRef,
  isCollaborating,
  isCollaborationPublishable,
  tabId,
}: DocxFinalizeButtonProps) => {
  const t = useTranslations();
  return (
    <Button
      className={cn(isCollaborating && "min-h-11")}
      disabled={isCollaborating && !isCollaborationPublishable}
      onClick={() => {
        const finalize = docxActionsRef.current.get(tabId)?.finalize();
        if (finalize) {
          detached(finalize, "file-tab-panel.finalize-docx");
        }
      }}
      size="xs"
    >
      {isCollaborating ? (
        <GitCommitHorizontalIcon className="size-3.5" />
      ) : (
        <CheckIcon className="size-3.5" />
      )}
      {isCollaborating ? t("folio.createVersion") : t("common.save")}
    </Button>
  );
};

type FileTabSidepeekEmail = {
  chatMode: EmailChatMode;
  onRetryChatResolution: () => void;
  overlayActivation: FileChatOverlayActivation;
  resolutionFailed: boolean;
};

type FileTabSidepeekProps = {
  /** `null` when the tab is not an email. */
  email: FileTabSidepeekEmail | null;
  facet: Facet;
  /** The non-preview facets, rendered for `facet`. */
  facetContent: ReactNode;
  header: ReactNode;
  isActive: boolean;
  /** Whether the viewer sits under a measured PDF. */
  measured: boolean;
  onFacetChange: (facet: Facet) => void;
  onViewerError: () => void;
  scaleOffset: number;
  tab: FileTab;
  viewer: ReactNode;
};

/** The inspector tab beside the route's own content. */
const FileTabSidepeek = ({
  email,
  facet,
  facetContent,
  header,
  isActive,
  measured,
  onFacetChange,
  onViewerError,
  scaleOffset,
  tab,
  viewer,
}: FileTabSidepeekProps) => {
  // Facet bar stays visible during edit. The viewer (with the
  // live editor) is kept mounted via CSS hide on facet switches
  // (see `sidepeekBody` below) so unsaved session state survives a
  // pop-out to Metadata / Versions / etc. and is restored intact
  // when the user returns to Preview.
  const facetBar = (
    <TabFacetBar
      baseFacets={FACETS}
      entityId={tab.entityId}
      facet={facet}
      fieldId={tab.id}
      fileName={tab.fileName}
      mimeType={tab.mimeType}
      onChange={onFacetChange}
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
  const isPreviewVisible = facet === "preview";
  const sidepeekBody = (
    <>
      <div
        className={cn(
          "min-h-0 min-w-0 flex-1",
          isPreviewVisible ? "flex" : "hidden",
        )}
      >
        {viewer}
      </div>
      {!isPreviewVisible && (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {facetContent}
        </div>
      )}
    </>
  );
  const sidepeekContent =
    email !== null ? (
      <EmailViewerWithAI
        chatMode={email.chatMode}
        entityId={tab.entityId}
        fieldId={tab.id}
        fileName={tab.fileName}
        overlayActivation={email.overlayActivation}
        workspaceId={tab.workspaceId}
      >
        {sidepeekBody}
        {shouldSurfaceEmailResolutionAlert({
          isEmailDisplay: true,
          isPreviewVisible,
          resolutionFailed: email.resolutionFailed,
        }) ? (
          <EmailChatResolutionAlert onRetry={email.onRetryChatResolution} />
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
    >
      {header}
      {facetBar}
      <FileTabMeasurementBoundary
        active={isActive}
        fieldId={tab.id}
        measured={measured}
        onError={onViewerError}
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
