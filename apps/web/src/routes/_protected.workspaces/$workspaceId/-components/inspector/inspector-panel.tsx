import {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { PropsWithChildren } from "react";

import type { DocxCompatibility } from "@stll/folio";
import { Button } from "@stll/ui/components/button";
import { ScrollArea } from "@stll/ui/components/scroll-area";
import { Skeleton } from "@stll/ui/components/skeleton";
import { toast, toastManager } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";
import {
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useMatch, useNavigate } from "@tanstack/react-router";
import {
  AlertTriangleIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  FileTextIcon,
  LoaderCircleIcon,
  LockOpenIcon,
  Maximize2Icon,
  MessageSquareIcon,
  Minimize2Icon,
  MessageSquarePlusIcon,
  PanelRightIcon,
  XIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";
import { useShallow } from "zustand/shallow";

import Tooltip from "@/components/tooltip";
import { usePermissions } from "@/hooks/use-permissions";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { DOCX_MIME, TOOLBAR_ROW_HEIGHT } from "@/lib/consts";
import { getCachedAnonymization } from "@/lib/pdf/anonymization-cache";
import { PDFProvider, usePDFStore } from "@/lib/pdf/pdf-context";
import type { PDFPageFallback } from "@/lib/pdf/pdf-page";
import { toSafeId } from "@/lib/safe-id";
import { DocumentIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/document-icon";
import { DocxBrowserEditor } from "@/routes/_protected.workspaces/$workspaceId/-components/docx/docx-browser-editor";
import type { DocxBrowserEditorActions } from "@/routes/_protected.workspaces/$workspaceId/-components/docx/docx-browser-editor";
import { getDocxEditBlockReason } from "@/routes/_protected.workspaces/$workspaceId/-components/docx/docx-browser-editor.logic";
import { EntityKindIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/entity-kind-icon";
import { clearAnonymization } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/anonymize-pdf";
import {
  ChatTabPanel,
  ChatTabPanelShell,
} from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/chat-tab-panel";
import { EntityMetadataPanel } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/entity-metadata-panel";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import type {
  InspectorTab,
  PdfTab,
} from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import {
  InspectorTabHeader,
  MatterOriginLink,
} from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-tab-header";
import { buildMaximizeTabAction } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/maximize-tab";
import { useRailContextMenu } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/use-rail-context-menu";
import { useTabContextMenu } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/use-tab-context-menu";
import { PeekJustification } from "@/routes/_protected.workspaces/$workspaceId/-components/peek/peek-justification";
import {
  PeekPdfControls,
  PeekPdfViewer,
  PeekSuspenseFallback,
} from "@/routes/_protected.workspaces/$workspaceId/-components/peek/peek-pdf-viewer";
import { TaskDetailPanel } from "@/routes/_protected.workspaces/$workspaceId/-components/tasks/task-detail-panel";
import { useRenameEntity } from "@/routes/_protected.workspaces/$workspaceId/-mutations/entities";
import { entityOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import { propertiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";
import { workspaceKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/workspace";
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

/** Strip the file extension (e.g. ".pdf", ".docx") from a filename. */
const stripExtension = (name: string): string => {
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex <= 0) {
    return name;
  }
  return name.slice(0, dotIndex);
};

const ZOOM_STEP = 0.2;
const MIN_OFFSET = -0.8;
const MAX_OFFSET = 2;
const PINCH_ZOOM_SENSITIVITY = 0.005;

const hasInAppHistoryEntry = (): boolean => {
  const state: unknown = window.history.state;
  if (typeof state !== "object" || state === null) {
    return false;
  }
  const idx: unknown = Reflect.get(state, "idx");
  return typeof idx === "number" && idx > 0;
};

export const InspectorPanel = ({ workspaceId }: InspectorPanelProps) => {
  const t = useTranslations();
  const canUpdateEntity = usePermissions({ entity: ["update"] });
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
  const openPdf = useInspectorStore((s) => s.openPdf);
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

  // -- PDF zoom --
  const [scaleOffsets, setScaleOffsets] = useState<Map<string, number>>(
    () => new Map(),
  );
  const handleZoom = useCallback((tabId: string, direction: "in" | "out") => {
    setScaleOffsets((prev) => {
      const current = prev.get(tabId) ?? 0;
      const delta = direction === "in" ? ZOOM_STEP : -ZOOM_STEP;
      const next = Math.round((current + delta) * 10) / 10;

      if (next < MIN_OFFSET || next > MAX_OFFSET) {
        return prev;
      }

      const updated = new Map(prev);
      updated.set(tabId, next);
      return updated;
    });
  }, []);

  const handleResetZoom = useCallback((tabId: string) => {
    setScaleOffsets((prev) => {
      const updated = new Map(prev);
      updated.set(tabId, 0);
      return updated;
    });
  }, []);

  // -- Inline rename --
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editingDocxTabId, setEditingDocxTabId] = useState<string | null>(null);
  const [flashingDocxEditTabId, setFlashingDocxEditTabId] = useState<
    string | null
  >(null);
  const flashDocxEditTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const docxActionsRef = useRef(new Map<string, DocxBrowserEditorActions>());
  const [docxScrollTopByTab, setDocxScrollTopByTab] = useState<
    Map<string, number>
  >(() => new Map());
  const [docxCompatibilityByTab, setDocxCompatibilityByTab] = useState<
    Map<string, DocxCompatibility>
  >(() => new Map());
  const [editValue, setEditValue] = useState("");
  const renameEntity = useRenameEntity();

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
    [closeTab, editingDocxTabId],
  );

  const handleStartDocxEdit = useCallback(
    async (tabId: string) => {
      const compatibility = docxCompatibilityByTab.get(tabId);
      const blockReason = getDocxEditBlockReason({
        canSafelyEdit: compatibility?.canSafelyEdit,
      });
      if (blockReason === "pendingCompatibility") {
        toast.info(t("folio.checkingDocxEditTitle"), {
          description: t("folio.checkingDocxEditDescription"),
        });
        return;
      }

      if (blockReason === "unsafe") {
        toast.warning(t("folio.unsupportedDocxEditTitle"), {
          description: t("folio.unsupportedDocxEditDescription"),
        });
        return;
      }

      if (editingDocxTabId !== null && editingDocxTabId !== tabId) {
        const currentAction = docxActionsRef.current.get(editingDocxTabId);
        if (currentAction !== undefined) {
          await currentAction.cancel();
        }
        docxActionsRef.current.delete(editingDocxTabId);
        setEditingDocxTabId((current) =>
          current === editingDocxTabId ? null : current,
        );
      }

      setEditingDocxTabId(tabId);
      docxActionsRef.current.get(tabId)?.unlock();
    },
    [docxCompatibilityByTab, editingDocxTabId, t],
  );

  const flashDocxEditButton = useCallback((tabId: string) => {
    if (flashDocxEditTimerRef.current !== null) {
      clearTimeout(flashDocxEditTimerRef.current);
    }
    setFlashingDocxEditTabId(tabId);
    flashDocxEditTimerRef.current = setTimeout(() => {
      setFlashingDocxEditTabId(null);
      flashDocxEditTimerRef.current = null;
    }, 2200);
  }, []);

  useEffect(
    () => () => {
      if (flashDocxEditTimerRef.current !== null) {
        clearTimeout(flashDocxEditTimerRef.current);
      }
    },
    [],
  );

  const startRename = useCallback((tab: PdfTab) => {
    const dotIndex = tab.label.lastIndexOf(".");
    setEditValue(dotIndex > 0 ? tab.label.slice(0, dotIndex) : tab.label);
    setEditingTabId(tab.id);
  }, []);

  // Honour rename requests coming from the rail's right-click menu.
  // The rail can't reach into the ribbon's edit state directly; it
  // sets `pendingRenameTabId`, we pick it up here for the matching
  // PDF tab and clear the flag once consumed. Chat tabs do the
  // same in their own component.
  const pendingRenameTabId = useInspectorStore((s) => s.pendingRenameTabId);
  const clearRenameRequest = useInspectorStore((s) => s.clearRenameRequest);
  useEffect(() => {
    if (pendingRenameTabId === null) {
      return;
    }
    const target = tabs.find(
      (candidate): candidate is PdfTab =>
        candidate.type === "pdf" && candidate.id === pendingRenameTabId,
    );
    if (target) {
      startRename(target);
      clearRenameRequest();
    }
  }, [pendingRenameTabId, tabs, startRename, clearRenameRequest]);

  const commitRename = useCallback(
    (tab: PdfTab) => {
      const trimmed = editValue.trim();
      if (!trimmed) {
        setEditingTabId(null);
        return;
      }

      const dotIndex = tab.label.lastIndexOf(".");
      const ext = dotIndex > 0 ? tab.label.slice(dotIndex) : "";
      const newName = trimmed + ext;

      setEditingTabId(null);

      if (newName === tab.label) {
        return;
      }

      const previousLabel = tab.label;
      useInspectorStore.getState().updateLabel(tab.id, newName);
      renameEntity.mutate(
        { workspaceId: tab.workspaceId, entityId: tab.entityId, name: newName },
        {
          onError: () => {
            useInspectorStore.getState().updateLabel(tab.id, previousLabel);
            toastManager.add({
              title: t("errors.actionFailed"),
              type: "error",
            });
          },
        },
      );
    },
    [editValue, renameEntity, t],
  );

  const handleOpenFullView = useCallback(async () => {
    if (!activeTab || activeTab.type !== "pdf") {
      return;
    }
    const previousPdfViewer = {
      ...useWorkspaceStore.getState().pdfViewer,
    };
    const previousMetadataLane = activeTab.metadataLane ?? "closed";
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
        },
      });
      // Switch the surviving tab into "metadata-only" persona only
      // after full-view navigation succeeds; otherwise side peek stays
      // visually intact on rejected or aborted transitions.
      useInspectorStore.getState().setPdfMetadataLane(activeTab.id, "expanded");
    } catch (error) {
      setPdfViewerState(previousPdfViewer);
      useInspectorStore
        .getState()
        .setPdfMetadataLane(activeTab.id, previousMetadataLane);
      throw error;
    }
  }, [activeTab, navigate, setPdfViewerState]);

  const handleMinimizeFromFullView = useCallback(
    (tab: PdfTab) => {
      // Drop back to side-peek persona and return to the screen
      // where the file was maximized from. Full-view internal file
      // switches use replace navigation, so browser back lands on
      // the original table/overview/filesystem context.
      useInspectorStore.getState().setPdfMetadataLane(tab.id, "closed");
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
  const [recentPdfIds, setRecentPdfIds] = useState<string[]>([]);

  const pdfTabs = useMemo(
    () => tabs.filter((tab): tab is PdfTab => tab.type === "pdf"),
    [tabs],
  );

  // Update recency order when the active PDF changes.
  useEffect(() => {
    if (!activeId || activeTab?.type !== "pdf") {
      return;
    }
    setRecentPdfIds((prev) => {
      const next = prev.filter((id) => id !== activeId);
      next.unshift(activeId);
      if (next.length > MAX_MOUNTED_PDFS) {
        next.length = MAX_MOUNTED_PDFS;
      }
      return next;
    });
  }, [activeId, activeTab?.type]);

  // Also prune closed tabs from the recency list.
  useEffect(() => {
    const openIds = new Set(pdfTabs.map((tab) => tab.id));
    setRecentPdfIds((prev) => {
      const next = prev.filter((id) => openIds.has(id));
      return next.length === prev.length ? prev : next;
    });
  }, [pdfTabs]);

  const mountedPdfIds = useMemo(() => {
    const set = new Set(recentPdfIds);
    // Always include the active PDF.
    if (activeId && activeTab?.type === "pdf") {
      set.add(activeId);
    }
    return set;
  }, [recentPdfIds, activeId, activeTab?.type]);

  // Pinch-to-zoom for PDF tabs
  const pdfContentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = pdfContentRef.current;
    if (!el || activeTab?.type !== "pdf") {
      return undefined;
    }

    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey || !activeId) {
        return;
      }
      e.preventDefault();

      setScaleOffsets((prev) => {
        const current = prev.get(activeId) ?? 0;
        const delta = -e.deltaY * PINCH_ZOOM_SENSITIVITY;
        const next =
          Math.round(
            Math.max(MIN_OFFSET, Math.min(MAX_OFFSET, current + delta)) * 100,
          ) / 100;

        if (next === current) {
          return prev;
        }

        const updated = new Map(prev);
        updated.set(activeId, next);
        return updated;
      });
    };

    el.addEventListener("wheel", onWheel, {
      passive: false,
    });
    return () => el.removeEventListener("wheel", onWheel);
  }, [activeId, activeTab?.type]);

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
          navigate,
          queryClient: panelQueryClient,
        })
      : undefined,
  });

  // Right-click in the rail's empty space (below the tabs) opens
  // a "New chat" affordance. Mirrors the chrome topbar's right-
  // click context menu but lives next to the tab list itself.
  const railContextMenu = useRailContextMenu({ workspaceId });

  return (
    <div className="bg-background flex h-full border-s shadow-lg">
      {/* Vertical tab bar — top houses the pane toggle button
          (replaces the chrome topbar PanelRightIcon while the
          rail is mounted); the middle scrolls the open tabs; the
          bottom hosts the new-chat affordance. All affordances
          stay inside the rail so the active tab content keeps
          the full vertical space to the right of the rail. */}
      {tabs.length > 0 && (
        <div className="bg-muted/50 flex w-10 shrink-0 flex-col border-e">
          <div
            className={cn(
              "flex w-full shrink-0 items-center justify-center border-b",
              TOOLBAR_ROW_HEIGHT,
            )}
          >
            <Tooltip
              content={
                minimized ? t("inspector.showPane") : t("inspector.hidePane")
              }
              render={
                <button
                  aria-label={
                    minimized
                      ? t("inspector.showPane")
                      : t("inspector.hidePane")
                  }
                  className="text-muted-foreground hover:bg-accent hover:text-foreground flex size-7 items-center justify-center rounded-md transition-colors"
                  onClick={() => setMinimized(!minimized)}
                  type="button"
                />
              }
              side="left"
            >
              <PanelRightIcon className="size-4" />
            </Tooltip>
          </div>
          <ScrollArea className="flex-1">
            {/* Right-clicking in the rail's empty space (below
                the last tab) offers "New chat" so users can
                spawn a chat without aiming at the small icon
                button at the bottom of the rail. */}
            <div
              className="flex h-full flex-col"
              onContextMenu={(e) => {
                e.preventDefault();
                railContextMenu.openAt(e);
              }}
            >
              {tabs.map((tab) => (
                <VerticalTab
                  active={tab.id === activeId}
                  key={tab.id}
                  onActivate={() => {
                    setActive(tab.id);
                    setMinimized(false);
                  }}
                  onClose={() => {
                    handleCloseTab(tab.id);
                  }}
                  tab={tab}
                />
              ))}
            </div>
          </ScrollArea>
          {railContextMenu.element}
          <div
            className={cn(
              "flex w-full shrink-0 items-center justify-center border-t",
              TOOLBAR_ROW_HEIGHT,
            )}
          >
            <Tooltip
              content={t("chat.newChat")}
              render={
                <button
                  aria-label={t("chat.newChat")}
                  className="text-muted-foreground hover:bg-accent hover:text-foreground flex size-7 items-center justify-center rounded-md transition-colors"
                  onClick={() =>
                    openChat(
                      workspaceId === undefined
                        ? {}
                        : { workspaceId, contextMatterIds: [workspaceId] },
                    )
                  }
                  type="button"
                />
              }
              side="left"
            >
              <MessageSquarePlusIcon className="size-4" />
            </Tooltip>
          </div>
        </div>
      )}

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
        // header, empty state with stock prompts, prompt-bar
        // shape — so the user sees the expected interface
        // immediately and the data hydrates a frame later, no
        // spinner.
        <Suspense fallback={<ChatTabPanelShell tab={activeTab} />}>
          <ChatTabPanel
            onClose={() => handleCloseTab(activeTab.id)}
            onLabelContextMenu={ribbonContextMenu.openAt}
            tab={activeTab}
          />
        </Suspense>
      )}

      {/* PDF content — render all open PDF tabs, show only the active one.
         Keeping inactive viewers mounted avoids the blink on tab switch
         (no unmount → Suspense fallback → remount cycle). */}
      {pdfTabs.map((tab) => {
        if (minimized) {
          return null;
        }
        const isActive = tab.id === activeId;
        if (!mountedPdfIds.has(tab.id)) {
          return null;
        }
        const isNativeDocxDisplay =
          tab.mimeType === DOCX_MIME &&
          (tab.pdfFileId === null || !tab.justificationFieldId);
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
              <div
                className={cn(
                  "flex shrink-0 items-center justify-between border-b px-3",
                  TOOLBAR_ROW_HEIGHT,
                )}
              >
                <div className="flex min-w-0 items-center gap-2 overflow-hidden">
                  <span className="text-foreground text-xs font-medium">
                    {t("common.metadata")}
                  </span>
                  <span
                    aria-hidden="true"
                    className="text-muted-foreground/50 text-xs"
                  >
                    ·
                  </span>
                  <span
                    className="text-muted-foreground truncate text-xs"
                    title={tab.label}
                  >
                    {stripExtension(tab.label)}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-1 ps-4">
                  <Tooltip
                    content={t("workspaces.pdf.backToPeek")}
                    render={
                      <Button
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
                  <Button
                    onClick={() => handleCloseTab(tab.id)}
                    size="icon-xs"
                    variant="ghost"
                  >
                    <XIcon className="size-3.5" />
                  </Button>
                </div>
              </div>
              <div className="flex min-h-0 flex-1 flex-col">
                <Suspense fallback={<MetadataPanelSkeleton />}>
                  <EntityMetadataPanel
                    activeJustificationFieldId={pdfRouteJustification}
                    currentFilePropertyId={tab.propertyId ?? null}
                    entityId={tab.entityId}
                    fileFieldId={tab.id}
                    onAiFieldClick={({ fieldId, propertyId }) => {
                      // Keep the inspector tab in sync so peek-back
                      // lands on the same selection.
                      openPdf({
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
                          justification: fieldId,
                          justificationPage: 1,
                        }),
                      });
                    }}
                    workspaceId={tab.workspaceId}
                  />
                </Suspense>
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
            toast.info(t("folio.checkingDocxEditTitle"), {
              description: t("folio.checkingDocxEditDescription"),
            });
            return;
          }

          if (blockReason === "unsafe") {
            toast.warning(t("folio.unsupportedDocxEditTitle"), {
              description: t("folio.unsupportedDocxEditDescription"),
            });
            return;
          }
          if (canUnlockNativeDocx) {
            flashDocxEditButton(tab.id);
          }
        };

        const fileActions = isEditingNativeDocx ? (
          <>
            <div className="flex items-center rounded-md border p-0.5">
              <PeekPdfControls
                canResetZoom={scaleOffsets.get(tab.id) !== 0}
                onResetZoom={() => handleResetZoom(tab.id)}
                onZoomIn={() => handleZoom(tab.id, "in")}
                onZoomOut={() => handleZoom(tab.id, "out")}
                scaleOffset={scaleOffsets.get(tab.id) ?? 0}
              />
            </div>
            <Button
              onClick={() => {
                docxActionsRef.current.get(tab.id)?.finalize();
              }}
              size="sm"
            >
              <CheckIcon />
              {t("common.save")}
            </Button>
          </>
        ) : (
          <>
            {canUnlockNativeDocx && (
              <Tooltip
                content={t("folio.editFile")}
                render={
                  <Button
                    className={cn(
                      "transition-all",
                      isPromptingDocxUnlock &&
                        "bg-primary/10 text-primary ring-primary/60 animate-pulse ring-2",
                    )}
                    onClick={() => {
                      void handleStartDocxEdit(tab.id);
                    }}
                    size={isPromptingDocxUnlock ? "sm" : "icon-xs"}
                    variant="ghost"
                  >
                    <LockOpenIcon className="size-3.5" />
                    {isPromptingDocxUnlock && (
                      <span className="whitespace-nowrap">
                        {t("folio.editFile")}
                      </span>
                    )}
                  </Button>
                }
              />
            )}
            <div className="flex items-center rounded-md border p-0.5">
              <PeekPdfControls
                canResetZoom={scaleOffsets.get(tab.id) !== 0}
                onResetZoom={() => handleResetZoom(tab.id)}
                onZoomIn={() => handleZoom(tab.id, "in")}
                onZoomOut={() => handleZoom(tab.id, "out")}
                scaleOffset={scaleOffsets.get(tab.id) ?? 0}
              />
            </div>
            <Tooltip
              content={t("workspaces.pdf.openFullView")}
              render={
                <Button
                  onClick={() => {
                    handleOpenFullView().catch(() => {
                      /* fire-and-forget */
                    });
                  }}
                  size="icon-xs"
                  variant="ghost"
                >
                  <Maximize2Icon className="size-3.5" />
                </Button>
              }
            />
          </>
        );

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
            onClose={() => handleCloseTab(tab.id)}
            onLabelContextMenu={ribbonContextMenu.openAt}
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
          toastManager.add({
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

        const viewerPane = (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            {!isNativeDocxDisplay && tab.justificationFieldId && (
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
                <JustificationBar
                  activeTab={tab}
                  fieldId={tab.justificationFieldId}
                  isActiveTab={isActive}
                  workspaceId={tab.workspaceId}
                />
              </Suspense>
            )}
            {isNativeDocxDisplay && tab.propertyId !== undefined ? (
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
                    useInspectorStore
                      .getState()
                      .replacePdfFieldId(tab.id, fieldId);
                  }
                }}
                onScrollTopChange={handleDocxScrollTopChange}
                propertyId={tab.propertyId}
                scaleOffset={scaleOffsets.get(tab.id) ?? 0}
                showActionBar={false}
                workspaceId={tab.workspaceId}
              />
            ) : (
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
            )}
          </div>
        );

        const viewerContent = (
          <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
            {viewerPane}
          </div>
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
                {viewerContent}
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
                {viewerContent}
              </MeasuredPdfProvider>
            )}
          </div>
        );
      })}
      {ribbonContextMenu.element}
    </div>
  );
};

type MeasuredPdfProviderProps = PropsWithChildren<{
  active: boolean;
  fallback?: PDFPageFallback | undefined;
  fieldId: string;
  initialScaleOffset: number;
  onError?: ((error: Error) => void) | undefined;
}>;

const MeasuredPdfProvider = ({
  active,
  children,
  fallback,
  fieldId,
  initialScaleOffset,
  onError,
}: MeasuredPdfProviderProps) => {
  const [initialFitWidth, setInitialFitWidth] = useState<number | undefined>();
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!active || initialFitWidth !== undefined) {
      return undefined;
    }

    const container = containerRef.current;
    if (!container) {
      return undefined;
    }

    const updateWidth = (width: number) => {
      if (width > 0) {
        setInitialFitWidth(width);
      }
    };

    updateWidth(container.clientWidth);

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }

      updateWidth(entry.contentRect.width);
    });

    observer.observe(container);

    return () => {
      observer.disconnect();
    };
  }, [active, initialFitWidth]);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col" ref={containerRef}>
      {initialFitWidth === undefined ? (
        (fallback?.suspense ?? null)
      ) : (
        <PDFProvider
          fieldId={fieldId}
          fitToWidth={initialFitWidth}
          initialScaleOffset={initialScaleOffset}
          startPage={1}
          fallback={fallback}
          onError={onError}
        >
          {children}
        </PDFProvider>
      )}
    </div>
  );
};

// ── Metadata panel skeleton ───────────────────────

const MetadataPanelSkeleton = () => (
  <div className="flex min-h-0 flex-1 flex-col">
    <div className="flex flex-col gap-px p-2">
      {[0, 1, 2, 3].map((i) => (
        <div className="flex flex-col gap-1.5 px-2 py-2" key={i}>
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-4 w-full" />
        </div>
      ))}
    </div>
  </div>
);

// ── Error fallback ────────────────────────────────

const InspectorPdfErrorFallback = ({
  onClose,
  onRetry,
}: {
  onClose: () => void;
  onRetry?: (() => void) | undefined;
}) => {
  const t = useTranslations();

  return (
    <div className="flex h-full flex-col">
      <div
        className={cn(
          "flex shrink-0 items-center justify-end border-b px-3",
          TOOLBAR_ROW_HEIGHT,
        )}
      >
        <Button onClick={onClose} size="icon-xs" variant="ghost">
          <XIcon className="size-3.5" />
        </Button>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <AlertTriangleIcon className="text-muted-foreground/40 size-8" />
        <p className="text-muted-foreground text-sm">
          {t("common.somethingWentWrong")}
        </p>
        {onRetry && (
          <Button onClick={onRetry} size="sm" variant="outline">
            {t("common.tryAgain")}
          </Button>
        )}
      </div>
    </div>
  );
};

// ── Justification bar ──────────────────────────────

const JustificationBar = ({
  activeTab,
  fieldId,
  isActiveTab,
  workspaceId,
}: {
  activeTab: PdfTab;
  fieldId: string;
  isActiveTab: boolean;
  workspaceId: string;
}) => {
  const t = useTranslations();
  const openPdf = useInspectorStore((s) => s.openPdf);

  const { data: properties } = useSuspenseQuery(propertiesOptions(workspaceId));
  const { data: entity } = useSuspenseQuery(
    entityOptions(workspaceId, activeTab.entityId),
  );

  const justification = useWorkspaceStore((s) =>
    s.justifications.find((j) => j.fieldId === fieldId),
  );

  const slots = useMemo(() => {
    if (!justification) {
      return [];
    }
    return Object.values(entity.fields)
      .map((f) => {
        const prop = properties.find((p) => p.id === f.propertyId);
        if (!prop || prop.tool.type !== "ai-model") {
          return null;
        }
        return { fieldId: f.id, property: prop };
      })
      .filter((s) => s !== null);
  }, [entity, justification, properties]);

  const currentIdx = slots.findIndex((s) => s.fieldId === fieldId);
  const prevSlot = currentIdx > 0 ? slots[currentIdx - 1] : null;
  const nextSlot =
    currentIdx !== -1 && currentIdx < slots.length - 1
      ? slots[currentIdx + 1]
      : null;

  const [isExpanded, setIsExpanded] = useState(false);
  const setActiveJustification = useWorkspaceStore(
    (s) => s.setActiveJustification,
  );

  // Eagerly generate bboxes when the justification bar mounts.
  const queryClient = useQueryClient();
  const analytics = useAnalytics();
  const [isGeneratingBoxes, setIsGeneratingBoxes] = useState(false);
  const setScrollTo = usePDFStore((s) => s.setScrollTo);
  const pages = usePDFStore((s) => s.pages);

  const justificationId = justification?.id;
  const boundingBoxes = justification?.boundingBoxes;

  useEffect(() => {
    if (!justificationId || !isActiveTab || boundingBoxes) {
      return undefined;
    }

    let cancelled = false;
    setIsGeneratingBoxes(true);

    void (async () => {
      try {
        const response = await api
          .workspaces({ workspaceId: toSafeId<"workspace">(workspaceId) })
          ["bounding-boxes"].post({
            justificationId: toSafeId<"justification">(justificationId),
            queryKey: workspaceKeys.justifications(workspaceId),
          });

        if (cancelled) {
          return;
        }

        if (!response.error) {
          await queryClient.invalidateQueries({
            queryKey: workspaceKeys.justifications(workspaceId),
          });
        }
      } catch (error) {
        if (!cancelled) {
          analytics.captureError(error);
        }
      } finally {
        if (!cancelled) {
          setIsGeneratingBoxes(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    justificationId,
    boundingBoxes,
    isActiveTab,
    workspaceId,
    queryClient,
    analytics,
  ]);

  // Scroll to the first bbox page when boxes become available.
  // Use a ref for `pages` so viewport/zoom changes don't re-trigger
  // the scroll (the effect should run once when boxes appear).
  const pagesRef = useRef(pages);
  pagesRef.current = pages;

  useEffect(() => {
    if (!boundingBoxes || !isActiveTab) {
      return;
    }

    const firstBox = boundingBoxes.boxes
      .toSorted((a, b) => a.pageNumber - b.pageNumber)
      .at(0);

    if (!firstBox) {
      return;
    }

    const pageIds = [...pagesRef.current.keys()];
    const pageId = pageIds[firstBox.pageNumber - 1];
    if (pageId && justificationId) {
      setScrollTo({
        pageId,
        target: { kind: "justification", id: justificationId },
      });
    }
  }, [boundingBoxes, justificationId, isActiveTab, setScrollTo]);

  // Sync activeJustification before paint so PageCitation can
  // render bboxes without waiting for PeekJustification's effect.
  // Only set for the ACTIVE tab — inactive tabs stay mounted but
  // hidden, and their effects must not overwrite the active tab's
  // justification.
  useLayoutEffect(() => {
    if (justificationId && isActiveTab) {
      setActiveJustification({ id: justificationId, pageNumber: 1 });
    }
    return () => {
      if (isActiveTab) {
        setActiveJustification(null);
      }
    };
  }, [justificationId, isActiveTab, setActiveJustification]);

  if (!justification) {
    return null;
  }

  const currentSlot = currentIdx !== -1 ? slots[currentIdx] : undefined;
  const propertyName = currentSlot?.property.name;

  const shortAnswer = (() => {
    if (!currentSlot) {
      return null;
    }
    // entity.fields is Record<propertyId, WorkspaceField>
    const field = Object.values(entity.fields).find(
      (f) => f.id === currentSlot.fieldId,
    );
    if (!field) {
      return null;
    }
    const c = field.content;
    if ("value" in c) {
      const v = c.value;
      if (Array.isArray(v)) {
        return v.join(", ");
      }
      return v !== null && v !== undefined ? String(v) : null;
    }
    return null;
  })();

  return (
    <div className="bg-muted/30 flex shrink-0 flex-col border-b px-3">
      <div
        className={cn("flex items-center justify-between", TOOLBAR_ROW_HEIGHT)}
      >
        <button
          className="flex flex-1 cursor-pointer items-center gap-2 overflow-hidden text-start text-xs"
          onClick={() => setIsExpanded((prev) => !prev)}
          type="button"
        >
          <div className="flex items-center gap-1.5 truncate">
            {isGeneratingBoxes && (
              <LoaderCircleIcon className="text-muted-foreground size-3 shrink-0 animate-spin" />
            )}
            {propertyName && (
              <span className="text-muted-foreground">{propertyName}: </span>
            )}
            <span className="font-medium">
              {shortAnswer ?? t("workspaces.pdf.evidence")}
            </span>
          </div>
        </button>

        <div className="flex shrink-0 items-center gap-1 ps-4">
          <Button
            disabled={!prevSlot}
            onClick={() => {
              if (!prevSlot) {
                return;
              }
              openPdf({
                id: activeTab.id,
                entityId: activeTab.entityId,
                label: activeTab.label,
                workspaceId: activeTab.workspaceId,
                mimeType: activeTab.mimeType,
                pdfFileId: activeTab.pdfFileId,
                justificationFieldId: prevSlot.fieldId,
                propertyId: prevSlot.property.id,
              });
            }}
            size="icon-xs"
            variant="ghost"
          >
            <ChevronLeftIcon className="size-3.5" />
          </Button>
          <span className="text-muted-foreground min-w-8 text-center text-[10px] tabular-nums">
            {currentIdx + 1} / {slots.length}
          </span>
          <Button
            disabled={!nextSlot}
            onClick={() => {
              if (!nextSlot) {
                return;
              }
              openPdf({
                id: activeTab.id,
                entityId: activeTab.entityId,
                label: activeTab.label,
                workspaceId: activeTab.workspaceId,
                mimeType: activeTab.mimeType,
                pdfFileId: activeTab.pdfFileId,
                justificationFieldId: nextSlot.fieldId,
                propertyId: nextSlot.property.id,
              });
            }}
            size="icon-xs"
            variant="ghost"
          >
            <ChevronRightIcon className="size-3.5" />
          </Button>
        </div>
      </div>
      {isExpanded && (
        <div className="max-h-40 overflow-y-auto pb-2 text-xs">
          <p className="text-muted-foreground mb-1 font-semibold">
            {t("workspaces.pdf.evidence")}:
          </p>
          <PeekJustification
            activeFileFieldId={activeTab.id}
            justification={justification}
          />
        </div>
      )}
    </div>
  );
};

// ── Vertical tab ───────────────────────────────────

/** Extract a short abbreviation from a filename (stem, not extension). */
const getTabAbbrev = (label: string): string => {
  const dot = label.lastIndexOf(".");
  const stem = dot === -1 ? label : label.slice(0, dot);
  return stem.slice(0, 3);
};

type VerticalTabProps = {
  tab: InspectorTab;
  active: boolean;
  onActivate: () => void;
  onClose: () => void;
};

const VerticalTab = ({
  tab,
  active,
  onActivate,
  onClose,
}: VerticalTabProps) => {
  const tooltipLabel = tab.label || tab.id.slice(0, 6);
  const tabRef = useRef<HTMLButtonElement>(null);
  const tabNavigate = useNavigate();
  const tabQueryClient = useQueryClient();

  const contextMenu = useTabContextMenu({
    tabId: tab.id,
    onClose,
    onMaximize: buildMaximizeTabAction(tab, {
      navigate: tabNavigate,
      queryClient: tabQueryClient,
    }),
  });

  // Flash the tab on (re-)activation.
  const activationSeq = useInspectorStore((s) => s.activationSeq);
  const prevSeq = useRef(activationSeq);
  useEffect(() => {
    const el = tabRef.current;
    if (el && active && activationSeq !== prevSeq.current) {
      el.animate(
        [
          {
            backgroundColor: "var(--color-primary)",
            opacity: 0.7,
          },
          {
            backgroundColor: "transparent",
            opacity: 1,
          },
        ],
        { duration: 400, easing: "ease-out" },
      );
    }
    prevSeq.current = activationSeq;
  }, [active, activationSeq]);

  return (
    <>
      <Tooltip
        content={tooltipLabel}
        render={
          <button
            ref={tabRef}
            className={cn(
              "group/tab relative flex w-full items-center justify-center border-b transition-colors",
              "text-muted-foreground hover:bg-accent hover:text-foreground",
              TOOLBAR_ROW_HEIGHT,
              active &&
                "bg-background text-foreground before:bg-primary before:absolute before:inset-y-0 before:inset-s-0 before:w-0.5",
            )}
            onAuxClick={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                onClose();
              }
            }}
            onClick={onActivate}
            onContextMenu={contextMenu.openAt}
            type="button"
          />
        }
        side="left"
      >
        {tab.type === "task" ? (
          <EntityKindIcon
            className="size-3.5"
            kind="task"
            status={tab.status}
          />
        ) : tab.type === "chat" ? (
          <MessageSquareIcon className="size-3.5" />
        ) : active && tab.mimeType ? (
          <DocumentIcon className="size-3.5" mimeType={tab.mimeType} />
        ) : active ? (
          <FileTextIcon className="size-3.5" />
        ) : (
          <span className="text-[9px] leading-none font-semibold tracking-tight uppercase">
            {getTabAbbrev(tab.label)}
          </span>
        )}
      </Tooltip>
      {contextMenu.element}
    </>
  );
};
