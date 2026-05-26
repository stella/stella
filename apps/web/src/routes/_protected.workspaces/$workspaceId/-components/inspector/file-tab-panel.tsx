import { Suspense } from "react";
import type { Dispatch, MouseEvent, RefObject, SetStateAction } from "react";

import { useNavigate } from "@tanstack/react-router";
import {
  CheckIcon,
  DownloadIcon,
  LockOpenIcon,
  Maximize2Icon,
  Minimize2Icon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import type { DocxCompatibility } from "@stll/folio";
import { Button } from "@stll/ui/components/button";
import { stellaToast } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";

import { useReviewStore } from "@/components/ai-suggestions/review-store";
import Tooltip from "@/components/tooltip";
import { DOCX_MIME, TOOLBAR_ROW_HEIGHT } from "@/lib/consts";
import { DocxBrowserEditor } from "@/routes/_protected.workspaces/$workspaceId/-components/docx/docx-browser-editor";
import type { DocxBrowserEditorActions } from "@/routes/_protected.workspaces/$workspaceId/-components/docx/docx-browser-editor";
import { getDocxEditBlockReason } from "@/routes/_protected.workspaces/$workspaceId/-components/docx/docx-browser-editor.logic";
import { AnonymizationFacet } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/anonymization-facet";
import { DocumentAiSourceBar } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/document-ai-source-bar";
import { DocxDesktopOpenButton } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/docx-desktop-open-button";
import { EntityMetadataPanel } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/entity-metadata-panel";
import { downloadTabOriginalFile } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/file-download-service";
import {
  FACETS,
  FULLVIEW_FACETS,
  FullViewPreviewGuard,
  MetadataPanelSkeleton,
  TabFacetBar,
} from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/file-facets";
import { InspectorPdfErrorFallback } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-pdf-error-fallback";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import type { FileTab } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import {
  InspectorTabHeader,
  MatterOriginLink,
} from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-tab-header";
import { MeasuredPdfProvider } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/measured-pdf-provider";
import { SuggestionsFacet } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/suggestions-facet";
import { VersionsFacet } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/versions-facet";
import {
  PeekPdfControls,
  PeekPdfViewer,
  PeekSuspenseFallback,
} from "@/routes/_protected.workspaces/$workspaceId/-components/peek/peek-pdf-viewer";

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
  handleZoom: (tabId: string, direction: "in" | "out") => void;
  matterColor: string | null;
  matterOrigin: MatterOrigin | null;
  minimized: boolean;
  mountedPdfIds: ReadonlySet<string>;
  pdfContentRef: RefObject<HTMLDivElement | null>;
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
  handleZoom,
  matterColor,
  matterOrigin,
  minimized,
  mountedPdfIds,
  pdfContentRef,
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
  const navigate = useNavigate();
  const openFile = useInspectorStore((s) => s.openFile);
  const setFileFacet = useInspectorStore((s) => s.setFileFacet);

  if (minimized) {
    return null;
  }
  const isActive = tab.id === activeId;
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
  const isNativeDocxDisplay = tab.mimeType === DOCX_MIME;
  const isEditingNativeDocx =
    isNativeDocxDisplay &&
    editingDocxTabId === tab.id &&
    tab.propertyId !== undefined;
  const canUnlockNativeDocx =
    canUpdateEntity &&
    isNativeDocxDisplay &&
    tab.propertyId !== undefined &&
    !isEditingNativeDocx;
  const isPromptingDocxUnlock = flashingDocxEditTabId === tab.id;
  const metadataLane = tab.metadataLane ?? "closed";
  const isMetadataLaneExpanded = metadataLane === "expanded";
  const desktopOpenButton =
    isNativeDocxDisplay && tab.propertyId !== undefined ? (
      <DocxDesktopOpenButton
        entityId={tab.entityId}
        propertyId={tab.propertyId}
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
            void downloadTabOriginalFile({
              fieldId: tab.id,
              fileName: tab.label,
              workspaceId: tab.workspaceId,
              onError: (message) => {
                stellaToast.add({ title: message, type: "error" });
              },
            });
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
        key={tab.renderId ?? tab.id}
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
                      "transition-all",
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
                currentFilePropertyId={tab.propertyId ?? null}
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
                  void navigate({
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
                  });
                }}
                workspaceId={tab.workspaceId}
              />
            </Suspense>
          )}
          {tab.facet === "versions" && (
            <VersionsFacet
              currentFieldId={tab.id}
              entityId={tab.entityId}
              workspaceId={tab.workspaceId}
            />
          )}
          {tab.facet === "suggestions" && (
            <SuggestionsFacet entityId={tab.entityId} />
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
      stellaToast.info(t("folio.checkingDocxEditTitle"), {
        description: t("folio.checkingDocxEditDescription"),
      });
      return;
    }

    if (blockReason === "unsafe") {
      stellaToast.warning(t("folio.unsupportedDocxEditTitle"), {
        description: t("folio.unsupportedDocxEditDescription"),
      });
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
  const isPreviewFacet = (tab.facet ?? "preview") === "preview";
  const editToggle = (() => {
    if (isEditingNativeDocx) {
      return (
        <Button
          className="transition-all"
          onClick={() => {
            docxActionsRef.current.get(tab.id)?.finalize();
          }}
          size="xs"
        >
          <CheckIcon className="size-3.5" />
          {t("common.save")}
        </Button>
      );
    }
    if (canUnlockNativeDocx) {
      return (
        <Button
          className={cn(
            "transition-all",
            isPromptingDocxUnlock &&
              "bg-primary/10 text-primary ring-primary/60 animate-pulse ring-2",
          )}
          onClick={() => {
            void handleStartDocxEdit(tab.id);
          }}
          size="xs"
          variant="ghost"
        >
          <LockOpenIcon className="size-3.5" />
          {t("folio.editFile")}
        </Button>
      );
    }
    return null;
  })();

  const fullViewButton = (
    <Button
      onClick={() => {
        handleOpenFullView().catch(() => {
          /* fire-and-forget */
        });
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
      {isPreviewFacet && editToggle}
      {fullViewButton}
    </>
  );

  // Floating preview-only toolbar mounted on top of the
  // viewer body — zoom controls only. The Edit / Save mode
  // toggle lives in the tab header (`fileActions` above) so
  // primary state changes have one stable location.
  const previewOverlay =
    (tab.facet ?? "preview") === "preview" && !isEditingNativeDocx ? (
      <div className="bg-background/80 supports-[backdrop-filter]:bg-background/65 absolute end-2 top-2 z-10 flex items-center gap-1 rounded-md border p-0.5 shadow-sm backdrop-blur">
        <PeekPdfControls
          canResetZoom={scaleOffsets.get(tab.id) !== 0}
          onResetZoom={() => handleResetZoom(tab.id)}
          onZoomIn={() => handleZoom(tab.id, "in")}
          onZoomOut={() => handleZoom(tab.id, "out")}
          scaleOffset={scaleOffsets.get(tab.id) ?? 0}
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
    <InspectorPdfErrorFallback
      onClose={() => {
        handleCloseTab(tab.id);
      }}
      onRetry={reset}
    />
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
    if (isNativeDocxDisplay && tab.propertyId !== undefined) {
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
            docxActionsRef.current.delete(tab.id);
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
                const scaleOffset = prev.get(tab.id);
                if (scaleOffset === undefined) {
                  return prev;
                }
                const next = new Map(prev);
                next.set(fieldId, scaleOffset);
                return next;
              });
              useInspectorStore.getState().replaceFileFieldId(tab.id, fieldId);
            }
          }}
          onScrollTopChange={handleDocxScrollTopChange}
          propertyId={tab.propertyId}
          scaleOffset={scaleOffsets.get(tab.id) ?? 0}
          showActionBar={false}
          workspaceId={tab.workspaceId}
        />
      );
    }
    return (
      <PeekPdfViewer
        activePropertyId={tab.propertyId ?? ""}
        entityId={tab.entityId}
        errorFallback={viewerErrorFallback}
        fieldId={tab.id}
        filePurpose={isNativeDocxDisplay ? "native-display" : "display"}
        mimeType={tab.mimeType ?? undefined}
        onDocxScrollTopChange={handleDocxScrollTopChange}
        onError={handleViewerError}
        onPeekNavigate={closeAll}
        scaleOffset={scaleOffsets.get(tab.id) ?? 0}
        viewId={peekPdfViewId}
        workspaceId={tab.workspaceId}
      />
    );
  })();

  const viewerPane = (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {tab.justificationFieldId && (
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

  // Hide the facet row while editing — switching facets
  // unmounts the live editor and would silently drop session
  // state. The tab header's Save / close buttons are the
  // only legitimate exits during an edit; once the session
  // ends the facet bar comes back.
  const facetBar = isEditingNativeDocx ? null : (
    <TabFacetBar
      baseFacets={FACETS}
      entityId={tab.entityId}
      facet={sidepeekFacet}
      fieldId={tab.id}
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
                currentFilePropertyId={tab.propertyId ?? null}
                entityId={tab.entityId}
                fileFieldId={tab.id}
                onAiFieldClick={({ fieldId, propertyId }) => {
                  openFile({
                    ...tab,
                    justificationFieldId: fieldId,
                    propertyId,
                  });
                  void navigate({
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
                  });
                }}
                workspaceId={tab.workspaceId}
              />
            </Suspense>
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
              // Quick fix: sidepeek's DOCX editor unmounts when
              // the user switches off Preview, so Accept on a
              // suggestion has no live editor to apply against.
              // Route to the DOCX main view, where the editor is
              // mounted by default and the same `<SuggestionsFacet>`
              // (rendered by the fullscreen branch above) reuses
              // the registration.
              // TODO: replace with an in-app approval flow that
              // doesn't need the full editor mounted.
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
                      void navigate({
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
                      });
                    },
                  }
                : {})}
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
                handleOpenFullView().catch(() => {
                  /* fire-and-forget */
                });
              }}
              workspaceId={tab.workspaceId}
            />
          )}
        </div>
      )}
    </>
  );

  return (
    <div
      className={cn(
        "flex flex-1 flex-col overflow-hidden",
        !isActive && "hidden",
      )}
      key={tab.renderId ?? tab.id}
      ref={isActive ? pdfContentRef : undefined}
    >
      {isNativeDocxDisplay ? (
        <>
          {contextBar}
          {facetBar}
          {sidepeekBody}
        </>
      ) : (
        <MeasuredPdfProvider
          active={isActive}
          fallback={{
            suspense: <PeekSuspenseFallback />,
            error: (
              <InspectorPdfErrorFallback
                onClose={() => {
                  handleCloseTab(tab.id);
                }}
              />
            ),
          }}
          fieldId={tab.id}
          initialScaleOffset={scaleOffsets.get(tab.id) ?? 0}
          onError={handleViewerError}
        >
          {contextBar}
          {facetBar}
          {sidepeekBody}
        </MeasuredPdfProvider>
      )}
    </div>
  );
};
