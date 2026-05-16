import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, useMatch, useNavigate } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import { useShallow } from "zustand/shallow";

import { usePermissions } from "@/hooks/use-permissions";
import { getAnalytics } from "@/lib/analytics/provider";
import { resolveMatterColor } from "@/lib/matter-colors";
import { getCachedAnonymization } from "@/lib/pdf/anonymization-cache";
import { clearAnonymization } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/anonymize-pdf";
import {
  ChatTabPanel,
  ChatTabPanelShell,
} from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/chat-tab-panel";
import { ExternalReferencePanel } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/external-reference-panel";
import { MetadataPanelSkeleton } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/file-facets";
import { FileTabPanel } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/file-tab-panel";
import { InspectorRail } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-rail";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import type { FileTab } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import {
  InspectorTabHeader,
  MatterOriginLink,
} from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-tab-header";
import { buildMaximizeTabAction } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/maximize-tab";
import { useDocxTabEditSession } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/use-docx-tab-edit-session";
import { useFileTabRename } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/use-file-tab-rename";
import { usePdfTabZoom } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/use-pdf-tab-zoom";
import { useTabContextMenu } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/use-tab-context-menu";
import { MatterMetadataPanel } from "@/routes/_protected.workspaces/$workspaceId/-components/matter-metadata-sheet";
import { TaskDetailPanel } from "@/routes/_protected.workspaces/$workspaceId/-components/tasks/task-detail-panel";
import { entityOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import { useWorkspaceStore } from "@/routes/_protected.workspaces/$workspaceId/-store";
import { workspaceOptions } from "@/routes/_protected.workspaces/-queries";

type InspectorPanelProps = {
  /**
   * Matter context the pane was mounted under. `undefined` means
   * the pane is mounted on a non-workspace route (e.g. the global
   * /chat surface) — only chat tabs are meaningful in that mode;
   * matter-bound affordances (originating-matter ribbon, "New
   * matter chat" rail button) hide themselves.
   */
  workspaceId?: string | undefined;
};

const hasInAppHistoryEntry = (): boolean => {
  const state: unknown = window.history.state;
  if (typeof state !== "object" || state === null) {
    return false;
  }
  const idx: unknown = Reflect.get(state, "idx");
  return typeof idx === "number" && idx > 0;
};

const protectedRouteApi = getRouteApi("/_protected");

export const InspectorPanel = ({ workspaceId }: InspectorPanelProps) => {
  const t = useTranslations();
  const canUpdateEntity = usePermissions({ entity: ["update"] });
  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const { tabs, activeId } = useInspectorStore(
    useShallow((s) => ({
      tabs: s.tabs,
      activeId: s.activeId,
    })),
  );
  const setActive = useInspectorStore((s) => s.setActive);
  const closeTab = useInspectorStore((s) => s.closeTab);
  const closeAll = useInspectorStore((s) => s.closeAll);
  const minimized = useInspectorStore((s) => s.minimized);
  const setMinimized = useInspectorStore((s) => s.setMinimized);
  const openChat = useInspectorStore((s) => s.openChat);
  // The inspector pane mounts under non-workspace routes too
  // (e.g. /chat for a global chat tab). All callers below use
  // absolute `to:` paths, so we don't need a `from` template —
  // and a mismatched one would throw under TanStack Router's
  // route-typed navigation when the inspector is open off-workspace.
  const navigate = useNavigate();
  const setPdfViewerState = useWorkspaceStore((s) => s.setPdfViewerState);

  // Originating matter — surfaced in every tab header as
  // "label · Matter" so users always know which matter the tab
  // belongs to (matters can host related-matter content; chats are
  // moving to nullable matter binding in Phase D). Cache hit thanks
  // to the workspace route loader. Fetch is skipped when the pane
  // is mounted off-workspace (e.g. a global chat tab on /chat).
  const { data: workspace } = useQuery({
    ...workspaceOptions(workspaceId ?? ""),
    enabled: workspaceId !== undefined,
  });
  const matterOrigin = useMemo(
    () =>
      workspaceId !== undefined && workspace?.name
        ? {
            id: workspaceId,
            name: workspace.name,
            color: workspace.color ?? null,
            onClick: () => {
              void navigate({
                to: "/workspaces/$workspaceId",
                params: { workspaceId },
              });
            },
          }
        : null,
    [workspace?.name, workspace?.color, navigate, workspaceId],
  );
  // Resolve the matter's icon colour once so every tab header can
  // tint with the same `color-mix(... 2%)` formula the matter
  // breadcrumb uses — the inspector reads as a continuation of
  // the matter chrome, not a separate surface.
  const matterColor =
    workspaceId !== undefined
      ? resolveMatterColor(workspaceId, workspace?.color ?? null)
      : null;

  const viewMatch = useMatch({
    from: "/_protected/workspaces/$workspaceId/$viewId",
    shouldThrow: false,
  });
  const peekPdfViewId = viewMatch?.params.viewId ?? "all";

  // Detect when the inspector is mounted on the full-folio PDF
  // route so the metadata persona can drive the route's
  // `?justification=` (which controls bboxes on the route's PDF
  // viewer) instead of touching the inspector tab.
  const pdfRouteMatch = useMatch({
    from: "/_protected/workspaces/$workspaceId/$viewId/document",
    shouldThrow: false,
  });
  const pdfRouteJustification = pdfRouteMatch?.search.justification ?? null;

  const activeTab = tabs.find((tab) => tab.id === activeId);
  const activeMatterPanelColor =
    activeTab?.type === "matter"
      ? resolveMatterColor(activeTab.workspaceId, activeTab.color ?? null)
      : matterColor;

  const {
    handleResetZoom,
    handleZoom,
    pdfContentRef,
    scaleOffsets,
    setScaleOffsets,
  } = usePdfTabZoom({ activeId, activeTabType: activeTab?.type });

  // -- Inline rename --
  const {
    docxActionsRef,
    docxCompatibilityByTab,
    docxScrollTopByTab,
    editingDocxTabId,
    flashingDocxEditTabId,
    flashDocxEditButton,
    handleStartDocxEdit,
    setDocxCompatibilityByTab,
    setDocxScrollTopByTab,
    setEditingDocxTabId,
  } = useDocxTabEditSession({ tabs });
  // Pulse the fullscreen header's "Minimize" button briefly when the
  // user lands on Full view with the Preview facet active — we drop
  // them onto Metadata silently so we need a way to signal where to
  // click if they actually wanted Preview.
  const [flashingMinimizeTabId, setFlashingMinimizeTabId] = useState<
    string | null
  >(null);
  const flashMinimizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const {
    commitRename,
    editingTabId,
    editValue,
    setEditingTabId,
    setEditValue,
    startRename,
  } = useFileTabRename({ tabs });

  const handleCloseTab = useCallback(
    (tabId: string) => {
      const action = docxActionsRef.current.get(tabId);
      if (editingDocxTabId === tabId && action) {
        void action.cancel().finally(() => {
          docxActionsRef.current.delete(tabId);
          setEditingDocxTabId((current) =>
            current === tabId ? null : current,
          );
          clearAnonymization(tabId);
          closeTab(tabId);
        });
        return;
      }

      if (editingDocxTabId === tabId) {
        docxActionsRef.current.delete(tabId);
        setEditingDocxTabId(null);
      }
      clearAnonymization(tabId);
      closeTab(tabId);
    },
    [closeTab, docxActionsRef.current, editingDocxTabId, setEditingDocxTabId],
  );

  const flashMinimizeButton = useCallback((tabId: string) => {
    if (flashMinimizeTimerRef.current !== null) {
      clearTimeout(flashMinimizeTimerRef.current);
    }
    setFlashingMinimizeTabId(tabId);
    flashMinimizeTimerRef.current = setTimeout(() => {
      setFlashingMinimizeTabId(null);
      flashMinimizeTimerRef.current = null;
    }, 2200);
  }, []);

  useEffect(
    () => () => {
      if (flashMinimizeTimerRef.current !== null) {
        clearTimeout(flashMinimizeTimerRef.current);
      }
    },
    [],
  );

  const handleOpenFullView = useCallback(async () => {
    if (!activeTab || activeTab.type !== "pdf") {
      return;
    }
    const previousPdfViewer = {
      ...useWorkspaceStore.getState().pdfViewer,
    };
    const previousMetadataLane = activeTab.metadataLane ?? "closed";
    // Carry the sidepeek's edit-session state into the document
    // route so an unlocked-for-editing tab keeps editing in the
    // fullscreen view. Without this, the user would have to click
    // Edit again on a doc they're already editing.
    const carryEditing = editingDocxTabId === activeTab.id;
    if (carryEditing) {
      // Force-checkpoint any pending edits before tearing down the
      // sidepeek editor. The new fullscreen mount opens a fresh
      // session and downloads the latest checkpoint; without this
      // flush, anything typed inside the debounce window is lost.
      const action = docxActionsRef.current.get(activeTab.id);
      if (action) {
        try {
          await action.flushPendingChanges();
        } catch (error) {
          getAnalytics().captureError(error);
        }
      }
      // The edit session lives in the document route now. Drop the
      // sidepeek-local "this tab is being edited" flag so when the
      // inspector returns to sidepeek (matter overview, etc.) it
      // doesn't keep the facet row hidden by my "no facets while
      // editing" rule.
      setEditingDocxTabId(null);
    }
    try {
      const openAnonymizeSidebar =
        getCachedAnonymization(activeTab.id) !== undefined;
      setPdfViewerState({
        activePropertyId: activeTab.propertyId ?? null,
        pendingAnonymizeEntityId: null,
        scaleOffset: 0,
        sidebar: openAnonymizeSidebar ? "anonymize" : "entity",
      });
      await navigate({
        to: "/workspaces/$workspaceId/$viewId/document",
        params: { workspaceId: activeTab.workspaceId, viewId: "all" },
        search: {
          entity: activeTab.entityId,
          field: activeTab.id,
          justification: undefined,
          justificationPage: undefined,
          ...(carryEditing && { editing: true }),
        },
      });
      // Switch the surviving tab into "metadata-only" persona only
      // after full-view navigation succeeds; otherwise side peek stays
      // visually intact on rejected or aborted transitions.
      useInspectorStore
        .getState()
        .setFileMetadataLane(activeTab.id, "expanded");
    } catch (error) {
      setPdfViewerState(previousPdfViewer);
      useInspectorStore
        .getState()
        .setFileMetadataLane(activeTab.id, previousMetadataLane);
      throw error;
    }
  }, [
    activeTab,
    docxActionsRef.current,
    editingDocxTabId,
    navigate,
    setEditingDocxTabId,
    setPdfViewerState,
  ]);

  const handleMinimizeFromFullView = useCallback(
    (tab: FileTab) => {
      // Drop back to side-peek persona and return to the screen
      // where the file was maximized from. Full-view internal file
      // switches use replace navigation, so browser back lands on
      // the original table/overview/filesystem context.
      useInspectorStore.getState().setFileMetadataLane(tab.id, "closed");
      if (hasInAppHistoryEntry()) {
        window.history.back();
        return;
      }
      void navigate({
        to: "/workspaces/$workspaceId/$viewId",
        params: { workspaceId: tab.workspaceId, viewId: "all" },
      });
    },
    [navigate],
  );

  // Keep at most MAX_MOUNTED_PDFS viewers mounted to limit memory.
  // The active tab is always mounted; the rest are the most recently
  // viewed ones. Tabs beyond the limit unmount (and re-load on switch).
  const MAX_MOUNTED_PDFS = 3;

  const pdfTabs = useMemo(
    () => tabs.filter((tab): tab is FileTab => tab.type === "pdf"),
    [tabs],
  );

  // Ref-backed recency log: "most recent first", capped at
  // MAX_MOUNTED_PDFS. Mutating during render captures the order of
  // activations without the setState round-trip the old useEffect
  // pair needed; the ref is only read inside `mountedPdfIds` below,
  // which re-memoizes whenever activation or open tabs change.
  const pdfRecencyRef = useRef<string[]>([]);

  const mountedPdfIds = useMemo(() => {
    const openIds = new Set(pdfTabs.map((tab) => tab.id));
    let next = pdfRecencyRef.current.filter((id) => openIds.has(id));
    if (activeId && activeTab?.type === "pdf") {
      next = next.filter((id) => id !== activeId);
      next.unshift(activeId);
      if (next.length > MAX_MOUNTED_PDFS) {
        next.length = MAX_MOUNTED_PDFS;
      }
    }
    pdfRecencyRef.current = next;

    const set = new Set(next);
    // Always include the active PDF (in case it's not a PDF tab but
    // we want the set to mirror the union of recent + active).
    if (activeId && activeTab?.type === "pdf") {
      set.add(activeId);
    }
    return set;
  }, [activeId, activeTab?.type, pdfTabs]);

  const panelQueryClient = useQueryClient();

  // One context menu shared by every ribbon label. Only the active
  // tab's ribbon is mounted at a time so a single instance suffices,
  // and we avoid calling hooks inside the pdfTabs.map.
  const ribbonContextMenu = useTabContextMenu({
    tabId: activeTab?.id ?? "",
    onClose: () => {
      if (activeTab) {
        handleCloseTab(activeTab.id);
      }
    },
    onMaximize: activeTab
      ? buildMaximizeTabAction(activeTab, {
          activeOrganizationId,
          navigate,
          queryClient: panelQueryClient,
        })
      : undefined,
  });

  return (
    <div className="bg-background flex h-full border-s shadow-lg">
      <InspectorRail
        activeId={activeId}
        minimized={minimized}
        onActivateTab={(tabId) => {
          setActive(tabId);
          setMinimized(false);
        }}
        onCloseTab={handleCloseTab}
        onOpenChat={openChat}
        onSetMinimized={setMinimized}
        tabs={tabs}
        workspaceId={workspaceId}
      />

      {/* Task content */}
      {!minimized &&
        activeTab?.type === "task" &&
        workspaceId !== undefined && (
          <TaskDetailPanel taskId={activeTab.id} workspaceId={workspaceId} />
        )}

      {/* Chat content — sidepeek chat tab. Mounts FileAIChatHost in
          standalone layout so the bar + thread fill the panel
          instead of overlaying a file viewer. */}
      {!minimized && activeTab?.type === "chat" && (
        // Local Suspense boundary so the chat-thread fetch (cold
        // cache: a brand-new chat tab) doesn't bubble up to the
        // workspace route's pending component. The fallback is a
        // visual shell that mirrors the real panel's chrome —
        // header, empty state with saved prompts, prompt-bar
        // shape — so the user sees the expected interface
        // immediately and the data hydrates a frame later, no
        // spinner.
        <Suspense
          fallback={
            <ChatTabPanelShell matterColor={matterColor} tab={activeTab} />
          }
        >
          <ChatTabPanel
            matterColor={activeMatterPanelColor}
            onClose={() => handleCloseTab(activeTab.id)}
            onLabelContextMenu={ribbonContextMenu.openAt}
            tab={activeTab}
          />
        </Suspense>
      )}

      {!minimized && activeTab?.type === "external" && (
        <ExternalReferencePanel
          onClose={() => handleCloseTab(activeTab.id)}
          tab={activeTab}
          workspaceId={workspaceId}
        />
      )}

      {!minimized && activeTab?.type === "matter" && (
        <div className="bg-background flex flex-1 flex-col overflow-hidden">
          <InspectorTabHeader
            label={t("workspaces.matterInfo")}
            matter={
              <MatterOriginLink
                color={activeTab.color ?? null}
                id={activeTab.workspaceId}
                name={activeTab.label}
                onClick={() => {
                  void navigate({
                    to: "/workspaces/$workspaceId",
                    params: { workspaceId: activeTab.workspaceId },
                  });
                }}
              />
            }
            matterColor={activeMatterPanelColor}
            onClose={() => handleCloseTab(activeTab.id)}
          />
          <Suspense fallback={<MetadataPanelSkeleton />}>
            <MatterMetadataPanel
              onDeleted={() => handleCloseTab(activeTab.id)}
              workspaceId={activeTab.workspaceId}
            />
          </Suspense>
        </div>
      )}

      {pdfTabs.map((tab) => (
        <CurrentFileFieldSync
          key={`${tab.workspaceId}:${tab.entityId}:${tab.propertyId ?? tab.id}`}
          tab={tab}
        />
      ))}

      {/* Document content — render all open document tabs, show only the active one. */}
      {pdfTabs.map((tab) => (
        <FileTabPanel
          activeId={activeId}
          canUpdateEntity={canUpdateEntity}
          closeAll={closeAll}
          commitRename={commitRename}
          docxActionsRef={docxActionsRef}
          docxCompatibilityByTab={docxCompatibilityByTab}
          docxScrollTopByTab={docxScrollTopByTab}
          editingDocxTabId={editingDocxTabId}
          editingTabId={editingTabId}
          editValue={editValue}
          flashDocxEditButton={flashDocxEditButton}
          flashMinimizeButton={flashMinimizeButton}
          flashingDocxEditTabId={flashingDocxEditTabId}
          flashingMinimizeTabId={flashingMinimizeTabId}
          handleCloseTab={handleCloseTab}
          handleMinimizeFromFullView={handleMinimizeFromFullView}
          handleOpenFullView={handleOpenFullView}
          handleResetZoom={handleResetZoom}
          handleStartDocxEdit={handleStartDocxEdit}
          handleZoom={handleZoom}
          key={tab.renderId ?? tab.id}
          matterColor={matterColor}
          matterOrigin={matterOrigin}
          minimized={minimized}
          mountedPdfIds={mountedPdfIds}
          pdfContentRef={pdfContentRef}
          pdfRouteJustification={pdfRouteJustification}
          peekPdfViewId={peekPdfViewId}
          ribbonLabelContextMenuOpenAt={ribbonContextMenu.openAt}
          scaleOffsets={scaleOffsets}
          setDocxCompatibilityByTab={setDocxCompatibilityByTab}
          setDocxScrollTopByTab={setDocxScrollTopByTab}
          setEditingDocxTabId={setEditingDocxTabId}
          setEditingTabId={setEditingTabId}
          setEditValue={setEditValue}
          setScaleOffsets={setScaleOffsets}
          startRename={startRename}
          tab={tab}
        />
      ))}
      {ribbonContextMenu.element}
    </div>
  );
};

const CurrentFileFieldSync = ({ tab }: { tab: FileTab }) => {
  const replaceFileFieldId = useInspectorStore((s) => s.replaceFileFieldId);
  const currentFileFieldIdsByPropertyRef = useRef(new Map<string, string>());
  const { data: entity } = useQuery(
    entityOptions(tab.workspaceId, tab.entityId),
  );

  const activeFileField = entity?.fields.find((field) => {
    if (field.content.type !== "file") {
      return false;
    }
    return field.id === tab.id;
  });
  const latestFileFieldForProperty =
    tab.propertyId === undefined
      ? undefined
      : entity?.fields.findLast(
          (field) =>
            field.propertyId === tab.propertyId &&
            field.content.type === "file",
        );

  useEffect(() => {
    if (activeFileField === undefined) {
      return;
    }

    currentFileFieldIdsByPropertyRef.current.set(
      activeFileField.propertyId,
      activeFileField.id,
    );
  }, [activeFileField]);

  useEffect(() => {
    if (
      latestFileFieldForProperty === undefined ||
      latestFileFieldForProperty.id === tab.id
    ) {
      return;
    }

    const previousCurrentFieldId = currentFileFieldIdsByPropertyRef.current.get(
      latestFileFieldForProperty.propertyId,
    );
    if (previousCurrentFieldId !== tab.id) {
      return;
    }

    const latestFileContent = latestFileFieldForProperty.content;
    if (latestFileContent.type !== "file") {
      return;
    }

    currentFileFieldIdsByPropertyRef.current.set(
      latestFileFieldForProperty.propertyId,
      latestFileFieldForProperty.id,
    );
    replaceFileFieldId(tab.id, {
      id: latestFileFieldForProperty.id,
      label: latestFileContent.fileName,
      mimeType: latestFileContent.mimeType,
      pdfFileId: latestFileContent.pdfFileId,
      propertyId: latestFileFieldForProperty.propertyId,
    });
  }, [latestFileFieldForProperty, replaceFileFieldId, tab.id]);

  return null;
};
