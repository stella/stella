import {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { PropsWithChildren, RefObject } from "react";

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
  CopyIcon,
  ExternalLinkIcon,
  FileTextIcon,
  LoaderCircleIcon,
  LockOpenIcon,
  LaptopIcon,
  Maximize2Icon,
  MessageSquareIcon,
  Minimize2Icon,
  MessageSquarePlusIcon,
  PanelRightIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";
import { useShallow } from "zustand/shallow";

import type { DocxCompatibility } from "@stll/folio";
import { Button } from "@stll/ui/components/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/components/dialog";
import { Input } from "@stll/ui/components/input";
import { ScrollArea } from "@stll/ui/components/scroll-area";
import { Skeleton } from "@stll/ui/components/skeleton";
import { stellaToast } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";

import { MessageResponse } from "@/components/ai-elements/message";
import { FileViewerWithAI } from "@/components/ai-suggestions/file-viewer-with-ai";
import { useReviewStore } from "@/components/ai-suggestions/review-store";
import { useExternalSourceStore } from "@/components/chat/external-source-store";
import Tooltip from "@/components/tooltip";
import { env } from "@/env";
import { usePermissions } from "@/hooks/use-permissions";
import { getAnalytics, useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { getFreshLinkedAccount } from "@/lib/auth-session";
import { createChatThreadId } from "@/lib/chat-thread-ref";
import type { Citation } from "@/lib/citations";
import { iterateJustificationCitations } from "@/lib/citations";
import { DOCX_MIME, TOOLBAR_ROW_HEIGHT } from "@/lib/consts";
import { openDocxInDesktop } from "@/lib/desktop-bridge";
import { APIError, isUnauthorizedError, toAPIError } from "@/lib/errors";
import { resolveMatterColor } from "@/lib/matter-colors";
import { getCachedAnonymization } from "@/lib/pdf/anonymization-cache";
import {
  PDFProvider,
  getPDFPageIdByNumber,
  useOptionalPDFStore,
} from "@/lib/pdf/pdf-context";
import { PDFPage } from "@/lib/pdf/pdf-page";
import type { PDFPageFallback } from "@/lib/pdf/pdf-page";
import { PDFViewport } from "@/lib/pdf/pdf-viewport";
import { renderJustificationContent } from "@/lib/render-justification-content";
import { toSafeId } from "@/lib/safe-id";
import { sanitizeHref } from "@/lib/sanitize-href";
import { mcpConnectorsOptions } from "@/routes/_protected.knowledge/-queries";
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
import { SuggestionsFacet } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/suggestions-facet";
import { useRailContextMenu } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/use-rail-context-menu";
import { useTabContextMenu } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/use-tab-context-menu";
import { VersionsFacet } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/versions-facet";
import {
  PeekPdfControls,
  PeekPdfViewer,
  PeekSuspenseFallback,
} from "@/routes/_protected.workspaces/$workspaceId/-components/peek/peek-pdf-viewer";
import { TaskDetailPanel } from "@/routes/_protected.workspaces/$workspaceId/-components/tasks/task-detail-panel";
import { useSyncJustifications } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-sync-justifications";
import { useRenameEntity } from "@/routes/_protected.workspaces/$workspaceId/-mutations/entities";
import { entityOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import { entityVersionsOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/entity-versions";
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

// Only treat 5xx as a "something is broken upstream" toast trigger.
// 4xx (e.g. 422 unsupported content type) is an expected fallback.
const SERVER_PREVIEW_ERROR_THRESHOLD = 500;

// Module-scoped so dedupe survives the inspector tab unmount/remount
// cycle that happens when users flip between sources.
const toastedPreviewFailures = new Set<string>();

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
  const setPdfFacet = useInspectorStore((s) => s.setPdfFacet);
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
      if (flashDocxEditTimerRef.current !== null) {
        clearTimeout(flashDocxEditTimerRef.current);
      }
      if (flashMinimizeTimerRef.current !== null) {
        clearTimeout(flashMinimizeTimerRef.current);
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
            stellaToast.add({
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
      useInspectorStore.getState().setPdfMetadataLane(activeTab.id, "expanded");
    } catch (error) {
      setPdfViewerState(previousPdfViewer);
      useInspectorStore
        .getState()
        .setPdfMetadataLane(activeTab.id, previousMetadataLane);
      throw error;
    }
  }, [activeTab, editingDocxTabId, navigate, setPdfViewerState]);

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
      {/* Vertical tab bar — always mounted, even with zero tabs,
          so the user has a consistent right-side anchor: top
          houses the pane toggle button (with no tabs it doubles as
          "open new chat"), the middle scrolls the open tabs, the
          bottom hosts the new-chat affordance. */}
      <div className="bg-muted/50 flex w-10 shrink-0 flex-col border-e">
        <div
          className={cn(
            "flex w-full shrink-0 items-center justify-center border-b",
            TOOLBAR_ROW_HEIGHT,
          )}
        >
          <Tooltip
            content={
              tabs.length === 0
                ? t("inspector.openChat")
                : minimized
                  ? t("inspector.showPane")
                  : t("inspector.hidePane")
            }
            render={
              <button
                aria-label={
                  tabs.length === 0
                    ? t("inspector.openChat")
                    : minimized
                      ? t("inspector.showPane")
                      : t("inspector.hidePane")
                }
                className="text-muted-foreground hover:bg-accent hover:text-foreground flex size-7 items-center justify-center rounded-md transition-colors"
                onClick={() => {
                  // No tabs yet — clicking "open" creates the
                  // first chat instead of expanding an empty pane.
                  if (tabs.length === 0) {
                    openChat(
                      workspaceId === undefined
                        ? {}
                        : {
                            workspaceId,
                            contextMatterIds: [workspaceId],
                          },
                    );
                    return;
                  }
                  setMinimized(!minimized);
                }}
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
            matterColor={matterColor}
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

      {/* Document content — render all open document tabs, show only the active one.
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
                setPdfFacet={setPdfFacet}
                tabId={tab.id}
              />
              <InspectorTabHeader
                actions={
                  <>
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
                  setPdfFacet(tab.id, next);
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
        const editToggle = isEditingNativeDocx ? (
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
        ) : canUnlockNativeDocx ? (
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
        ) : null;

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

        const fileViewer =
          isNativeDocxDisplay && tab.propertyId !== undefined ? (
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
          );

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
              setPdfFacet(tab.id, next);
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
        const sidepeekBody =
          sidepeekFacet === "preview" ? (
            viewerContent
          ) : (
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
              {sidepeekFacet === "metadata" && (
                <Suspense fallback={<MetadataPanelSkeleton />}>
                  <EntityMetadataPanel
                    activeJustificationFieldId={pdfRouteJustification}
                    currentFilePropertyId={tab.propertyId ?? null}
                    entityId={tab.entityId}
                    fileFieldId={tab.id}
                    onAiFieldClick={({ fieldId, propertyId }) => {
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
                          setPdfFacet(tab.id, "suggestions");
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
      })}
      {ribbonContextMenu.element}
    </div>
  );
};

const DocxDesktopOpenButton = ({
  entityId,
  propertyId,
  workspaceId,
}: {
  entityId: string;
  propertyId: string;
  workspaceId: string;
}) => {
  const t = useTranslations();
  const [isOpening, setIsOpening] = useState(false);
  const label = t("workspaces.files.desktopEdit.openAction");

  const handleOpen = async () => {
    if (isOpening) {
      return;
    }

    setIsOpening(true);
    try {
      const linkedAccount = await getFreshLinkedAccount();
      await openDocxInDesktop({
        apiBaseUrl: env.VITE_API_URL,
        entityId,
        linkedAccount,
        propertyId,
        workspaceId,
      });

      stellaToast.add({
        description: t("workspaces.files.desktopEdit.openedDescription"),
        title: t("workspaces.files.desktopEdit.openedTitle"),
        type: "success",
      });
    } catch (error) {
      if (error instanceof Error && isUnauthorizedError(error)) {
        stellaToast.add({
          description: t(
            "workspaces.files.desktopEdit.authRequiredDescription",
          ),
          title: t("workspaces.files.desktopEdit.authRequiredTitle"),
          type: "error",
        });
        return;
      }

      getAnalytics().captureError(error);
      stellaToast.add({
        description: t("workspaces.files.desktopEdit.unavailableDescription"),
        title: t("workspaces.files.desktopEdit.unavailableTitle"),
        type: "error",
      });
    } finally {
      setIsOpening(false);
    }
  };

  return (
    <Tooltip
      content={label}
      render={
        <Button
          aria-label={label}
          disabled={isOpening}
          onClick={() => {
            void handleOpen();
          }}
          size="icon-xs"
          variant="ghost"
        >
          <LaptopIcon
            className={cn("size-3.5", isOpening && "animate-pulse")}
          />
        </Button>
      }
    />
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

// ── Facet bar (PdfTab sub-views) ──────────────────

type Facet = NonNullable<PdfTab["facet"]>;

type FacetBarProps = {
  facet: Facet;
  facets: readonly Facet[];
  /**
   * Facets rendered but not interactive. Used for the AI
   * suggestions chip when the document hasn't received any AI
   * proposals yet — the chip stays visible (so users can find it)
   * but clicking does nothing until there's something to review.
   */
  disabledFacets?: ReadonlySet<Facet> | undefined;
  pulseSeq?: number | undefined;
  /**
   * Suffix appended to the active facet's label, e.g. `"v1"` →
   * "Preview (v1)". Hidden on inactive chips so the row stays
   * scannable. Omit when no version is meaningful.
   */
  activeBadge?: string | undefined;
  onChange: (next: Facet) => void;
};

// Sidepeek shows every facet, including Preview (the file viewer
// itself). Fullscreen drops Preview entirely — the main view IS
// the preview, so a duplicate chip would be confusing; the
// FullViewPreviewGuard handles users who land in Full view with a
// stale "preview" facet by swapping to Metadata + flashing the
// Minimize button.
const FACETS: readonly Facet[] = [
  "preview",
  "metadata",
  "versions",
  "suggestions",
];
const FULLVIEW_FACETS: readonly Facet[] = [
  "metadata",
  "versions",
  "suggestions",
];

/**
 * Mounted only inside the fullscreen branch. If the user enters Full
 * view while their tab still holds `facet: "preview"` (carried over
 * from sidepeek), silently swap to Metadata, drop a one-line toast,
 * and pulse the header's Minimize button so they know that's how to
 * get a side-by-side preview again.
 */
type FullViewPreviewGuardProps = {
  tabId: string;
  facet: PdfTab["facet"];
  setPdfFacet: (tabId: string, facet: NonNullable<PdfTab["facet"]>) => void;
  flashMinimize: (tabId: string) => void;
};

const FullViewPreviewGuard = ({
  tabId,
  facet,
  setPdfFacet,
  flashMinimize,
}: FullViewPreviewGuardProps) => {
  const t = useTranslations();
  useEffect(() => {
    if (facet !== "preview") {
      return;
    }
    setPdfFacet(tabId, "metadata");
    stellaToast.info(t("inspector.facet.previewInFullViewToast"));
    flashMinimize(tabId);
  }, [facet, tabId, setPdfFacet, flashMinimize, t]);
  return null;
};

const FacetBar = ({
  facet,
  facets,
  disabledFacets,
  pulseSeq,
  activeBadge,
  onChange,
}: FacetBarProps) => {
  const t = useTranslations();
  const [pulsing, setPulsing] = useState(false);
  const lastPulseSeq = useRef<number | undefined>(pulseSeq);

  useEffect(() => {
    if (pulseSeq === undefined || pulseSeq === lastPulseSeq.current) {
      return undefined;
    }
    lastPulseSeq.current = pulseSeq;
    setPulsing(true);
    const timer = window.setTimeout(() => setPulsing(false), 1400);
    return () => window.clearTimeout(timer);
  }, [pulseSeq]);

  const labels: Record<Facet, string> = {
    preview: t("inspector.facet.preview"),
    metadata: t("common.metadata"),
    versions: t("fileDetail.versionHistory"),
    suggestions: t("docxReview.title"),
  };

  return (
    <div
      className={cn(
        "bg-background/85 supports-[backdrop-filter]:bg-background/65 sticky top-0 z-10 flex shrink-0 items-center gap-1 border-b px-2 backdrop-blur",
        TOOLBAR_ROW_HEIGHT,
      )}
    >
      {facets.map((value) => {
        const active = value === facet;
        const disabled = disabledFacets?.has(value) ?? false;
        return (
          <button
            className={cn(
              "rounded-md px-2 py-1 text-xs font-medium transition-colors",
              active
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
              active &&
                pulsing &&
                "ring-foreground-disabled animate-pulse ring-2",
              disabled && "cursor-not-allowed opacity-40 hover:bg-transparent",
            )}
            disabled={disabled}
            key={value}
            onClick={() => onChange(value)}
            type="button"
          >
            {labels[value]}
            {active && activeBadge !== undefined && (
              <span className="text-background/70 ms-1 font-normal">
                ({activeBadge})
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
};

/**
 * Per-tab wrapper around `FacetBar`. Three jobs:
 *  - Resolve the active version label ("v1", "v3", …) for the
 *    current field id and feed it as `activeBadge`.
 *  - Hide the AI-suggestions chip on tabs where the chat can't
 *    produce one (PDFs, files without DOCX-edit support).
 *  - Mark the AI-suggestions chip as inactive on DOCX tabs that
 *    haven't received any AI proposals yet, so the affordance is
 *    visible without inviting clicks that would land on an empty
 *    panel.
 *
 * Lives as its own component so the version + review-store reads
 * stay scoped per tab — no conditional hooks inside the parent's
 * pdfTabs.map.
 */
type TabFacetBarProps = Omit<
  FacetBarProps,
  "activeBadge" | "facets" | "disabledFacets"
> & {
  workspaceId: string;
  entityId: string;
  fieldId: string;
  mimeType: string | undefined;
  /**
   * Base list before this component drops/disables the
   * suggestions chip. Sidepeek passes the full list (preview,
   * metadata, versions, suggestions); fullscreen passes the
   * preview-less variant.
   */
  baseFacets: readonly Facet[];
};

const TabFacetBar = ({
  workspaceId,
  entityId,
  fieldId,
  mimeType,
  baseFacets,
  ...rest
}: TabFacetBarProps) => {
  const { data } = useQuery(entityVersionsOptions({ workspaceId, entityId }));
  const version = data?.versions.find((v) => v.file?.fieldId === fieldId);
  const activeBadge = version ? `v${String(version.versionNumber)}` : undefined;
  const suggestionCount = useReviewStore(
    (state) => state.sessions[entityId]?.length ?? 0,
  );
  const isDocx = mimeType === DOCX_MIME;

  const { facets, disabledFacets } = useMemo(() => {
    if (!isDocx) {
      return {
        facets: baseFacets.filter((f) => f !== "suggestions"),
        disabledFacets: undefined,
      };
    }
    if (suggestionCount === 0) {
      return {
        facets: baseFacets,
        disabledFacets: new Set<Facet>(["suggestions"]),
      };
    }
    return { facets: baseFacets, disabledFacets: undefined };
  }, [baseFacets, isDocx, suggestionCount]);

  return (
    <FacetBar
      activeBadge={activeBadge}
      disabledFacets={disabledFacets}
      facets={facets}
      {...rest}
    />
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
        <AlertTriangleIcon className="text-foreground-disabled size-8" />
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

// ── Document AI source bar ─────────────────────────

const DocumentAiSourceBar = ({
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
  useSyncJustifications({
    workspaceId,
    entityIds: [activeTab.entityId],
  });

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

  const setActiveJustification = useWorkspaceStore(
    (s) => s.setActiveJustification,
  );
  const requestBlockScroll = useInspectorStore((s) => s.requestBlockScroll);
  const [isAnswerExpanded, setIsAnswerExpanded] = useState(false);

  // Eagerly generate bboxes when the justification bar mounts.
  const queryClient = useQueryClient();
  const analytics = useAnalytics();
  const [isGeneratingBoxes, setIsGeneratingBoxes] = useState(false);
  const setScrollTo = useOptionalPDFStore((s) => s.setScrollTo);
  const pages = useOptionalPDFStore((s) => s.pages);

  const justificationId = justification?.id;
  const boundingBoxes = justification?.boundingBoxes;
  const activeDocumentJustificationContent = useMemo(
    () =>
      justification
        ? {
            ...justification.content,
            blocks: justification.content.blocks.filter(
              (block) => block.fileFieldId === activeTab.id,
            ),
          }
        : null,
    [activeTab.id, justification],
  );
  const citations = useMemo(
    () =>
      activeDocumentJustificationContent
        ? [...iterateJustificationCitations(activeDocumentJustificationContent)]
        : [],
    [activeDocumentJustificationContent],
  );
  const hasBoundingBoxCitations = citations.some(
    (citation) => citation.kind === "pdf-bates",
  );

  useEffect(() => {
    if (
      !justificationId ||
      !isActiveTab ||
      !hasBoundingBoxCitations ||
      boundingBoxes
    ) {
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
    hasBoundingBoxCitations,
    boundingBoxes,
    isActiveTab,
    workspaceId,
    queryClient,
    analytics,
  ]);

  useEffect(() => {
    setIsAnswerExpanded(false);
  }, [fieldId]);

  useEffect(() => {
    if (!isGeneratingBoxes) {
      return undefined;
    }

    const interval = window.setInterval(() => {
      void queryClient.invalidateQueries({
        queryKey: workspaceKeys.justifications(workspaceId),
      });
    }, 1000);

    return () => window.clearInterval(interval);
  }, [isGeneratingBoxes, queryClient, workspaceId]);

  useEffect(() => {
    if (!boundingBoxes || !isActiveTab || !pages || !setScrollTo) {
      return;
    }

    const firstBox = boundingBoxes.boxes
      .toSorted((a, b) => a.pageNumber - b.pageNumber)
      .at(0);

    if (!firstBox) {
      return;
    }

    const pageId = getPDFPageIdByNumber({
      fieldId: activeTab.id,
      pages,
      pageNumber: firstBox.pageNumber,
    });
    if (pageId && justificationId) {
      setScrollTo({
        pageId,
        target: { kind: "justification", id: justificationId },
      });
    }
  }, [
    activeTab.id,
    boundingBoxes,
    justificationId,
    isActiveTab,
    pages,
    setScrollTo,
  ]);

  // Sync activeJustification before paint so PageCitation can
  // render bboxes without waiting for PeekJustification's effect.
  // Only set for the ACTIVE tab — inactive tabs stay mounted but
  // hidden, and their effects must not overwrite the active tab's
  // justification.
  useLayoutEffect(() => {
    if (justificationId && isActiveTab && hasBoundingBoxCitations) {
      setActiveJustification({ id: justificationId, pageNumber: 1 });
    }
    return () => {
      if (isActiveTab) {
        setActiveJustification(null);
      }
    };
  }, [
    justificationId,
    hasBoundingBoxCitations,
    isActiveTab,
    setActiveJustification,
  ]);

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
  const handleCitationClick = (citation: Citation) => {
    if (citation.kind === "docx-folio") {
      requestBlockScroll(activeTab.id, citation.blockId);
      return;
    }

    setActiveJustification({
      id: justification.id,
      pageNumber: citation.pageNumber,
    });
    if (!pages || !setScrollTo) {
      return;
    }
    const pageId = getPDFPageIdByNumber({
      fieldId: activeTab.id,
      pages,
      pageNumber: citation.pageNumber,
    });
    if (!pageId) {
      return;
    }
    setScrollTo({
      pageId,
      target: { kind: "justification", id: justification.id },
    });
  };
  const justificationNodes = activeDocumentJustificationContent
    ? renderJustificationContent({
        content: activeDocumentJustificationContent,
        renderCitation: ({ citation, key }) => (
          <SourceCitationChip
            citation={citation}
            key={key}
            onClick={() => handleCitationClick(citation)}
          />
        ),
      }).nodes
    : [];

  return (
    <div className="bg-muted/30 flex shrink-0 flex-col border-b px-3">
      <div
        className={cn(
          "flex w-full min-w-0 items-center gap-2 text-xs",
          TOOLBAR_ROW_HEIGHT,
        )}
      >
        {isGeneratingBoxes && (
          <LoaderCircleIcon className="text-muted-foreground size-3 shrink-0 animate-spin" />
        )}
        <button
          aria-expanded={isAnswerExpanded}
          className="min-w-0 flex-1 truncate text-start"
          onClick={() => setIsAnswerExpanded((expanded) => !expanded)}
          title={shortAnswer ?? undefined}
          type="button"
        >
          {propertyName && (
            <span className="text-muted-foreground">{propertyName}: </span>
          )}
          <span className="font-medium">
            {shortAnswer ?? t("workspaces.pdf.evidence")}
          </span>
        </button>
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
      {isAnswerExpanded && shortAnswer !== null && (
        <div className="text-foreground-strong-muted max-h-32 min-w-0 overflow-y-auto pb-2 text-xs leading-relaxed break-words">
          {justificationNodes}
        </div>
      )}
    </div>
  );
};

const DOCX_SOURCE_PREVIEW_CHARS = 28;

const SourceCitationChip = ({
  citation,
  onClick,
}: {
  citation: Citation;
  onClick: () => void;
}) => {
  if (citation.kind === "pdf-bates") {
    return (
      <button
        className="bg-primary/10 text-primary hover:bg-primary/20 inline-flex shrink-0 items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium transition-colors"
        onClick={onClick}
        type="button"
      >
        p.&nbsp;{citation.pageNumber}
      </button>
    );
  }

  const trimmed = citation.text.trim();
  const preview =
    trimmed.length > DOCX_SOURCE_PREVIEW_CHARS
      ? `${trimmed.slice(0, DOCX_SOURCE_PREVIEW_CHARS).trimEnd()}...`
      : trimmed || "Text";

  return (
    <button
      className="bg-primary/10 text-primary hover:bg-primary/20 inline-flex max-w-36 shrink-0 items-center truncate rounded-md px-1.5 py-0.5 text-[11px] font-medium transition-colors"
      onClick={onClick}
      title={trimmed || undefined}
      type="button"
    >
      "{preview}"
    </button>
  );
};

type ExternalReferencePanelProps = {
  onClose: () => void;
  tab: Extract<InspectorTab, { type: "external" }>;
  workspaceId?: string | undefined;
};

type InspectorFindOptions = {
  contentRef: RefObject<HTMLElement | null>;
  enabled: boolean;
  highlightKey: string;
};

const useInspectorFind = ({
  contentRef,
  enabled,
  highlightKey,
}: InspectorFindOptions) => {
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [matchCount, setMatchCount] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const allHighlightName = `stella-inspector-find-${highlightKey}`;
  const activeHighlightName = `stella-inspector-find-active-${highlightKey}`;

  const clearFind = useCallback(() => {
    setFindQuery("");
    setMatchCount(0);
    setActiveIndex(0);
    CSS.highlights?.delete(allHighlightName);
    CSS.highlights?.delete(activeHighlightName);
  }, [activeHighlightName, allHighlightName]);

  const closeFind = useCallback(() => {
    setFindOpen(false);
  }, []);

  const openFind = useCallback(() => {
    if (!enabled) {
      return;
    }
    setFindOpen(true);
  }, [enabled]);

  const nextMatch = useCallback(() => {
    setActiveIndex((current) =>
      matchCount === 0 ? 0 : (current + 1) % matchCount,
    );
  }, [matchCount]);

  const previousMatch = useCallback(() => {
    setActiveIndex((current) =>
      matchCount === 0 ? 0 : (current - 1 + matchCount) % matchCount,
    );
  }, [matchCount]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!enabled) {
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setFindOpen(true);
        return;
      }

      if (event.key === "Escape" && findOpen) {
        event.preventDefault();
        setFindOpen(false);
      }
    };

    document.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => {
      document.removeEventListener("keydown", handleKeyDown, { capture: true });
    };
  }, [enabled, findOpen]);

  useLayoutEffect(() => {
    CSS.highlights?.delete(allHighlightName);
    CSS.highlights?.delete(activeHighlightName);

    const root = contentRef.current;
    const query = findQuery.trim();
    if (!enabled || !root || query.length === 0) {
      setMatchCount(0);
      setActiveIndex(0);
      return undefined;
    }

    const ranges = collectTextRanges(root, query);
    setMatchCount(ranges.length);

    if (ranges.length === 0) {
      setActiveIndex(0);
      return undefined;
    }

    const safeActiveIndex = activeIndex >= ranges.length ? 0 : activeIndex;
    if (safeActiveIndex !== activeIndex) {
      setActiveIndex(safeActiveIndex);
      return undefined;
    }

    CSS.highlights?.set(allHighlightName, new Highlight(...ranges));
    const activeRange = ranges.at(safeActiveIndex);
    if (activeRange) {
      CSS.highlights?.set(activeHighlightName, new Highlight(activeRange));
      scrollRangeIntoView(activeRange);
    }

    return () => {
      CSS.highlights?.delete(allHighlightName);
      CSS.highlights?.delete(activeHighlightName);
    };
  }, [
    activeHighlightName,
    activeIndex,
    allHighlightName,
    contentRef,
    enabled,
    findQuery,
  ]);

  return {
    activeMatchNumber: matchCount === 0 ? 0 : activeIndex + 1,
    clearFind,
    closeFind,
    findOpen,
    findQuery,
    matchCount,
    nextMatch,
    openFind,
    previousMatch,
    setFindQuery,
  };
};

const collectTextRanges = (root: HTMLElement, query: string): Range[] => {
  const ranges: Range[] = [];
  const normalizedQuery = query.toLocaleLowerCase();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);

  while (walker.nextNode()) {
    const node = walker.currentNode;
    const text = node.textContent ?? "";
    const normalizedText = text.toLocaleLowerCase();
    let from = 0;

    while (from < normalizedText.length) {
      const index = normalizedText.indexOf(normalizedQuery, from);
      if (index === -1) {
        break;
      }

      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + query.length);
      ranges.push(range);
      from = index + Math.max(query.length, 1);
    }
  }

  return ranges;
};

const scrollRangeIntoView = (range: Range): void => {
  const rect = firstVisibleRangeRect(range);
  const root =
    range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
  const scrollContainer =
    root instanceof HTMLElement
      ? root.closest<HTMLElement>('[data-slot="scroll-area-viewport"]')
      : null;

  if (rect && scrollContainer) {
    const containerRect = scrollContainer.getBoundingClientRect();
    const targetTop =
      rect.top -
      containerRect.top +
      scrollContainer.scrollTop -
      scrollContainer.clientHeight / 2 +
      rect.height / 2;

    scrollContainer.scrollTo({
      behavior: "smooth",
      top: Math.max(0, targetTop),
    });
    return;
  }

  const container = range.commonAncestorContainer;
  const element =
    container.nodeType === Node.ELEMENT_NODE
      ? container
      : container.parentElement;
  if (element instanceof HTMLElement) {
    element.scrollIntoView({ block: "center", behavior: "smooth" });
  }
};

const firstVisibleRangeRect = (range: Range): DOMRect | undefined => {
  for (const rect of range.getClientRects()) {
    if (rect.width > 0 && rect.height > 0) {
      return rect;
    }
  }

  const rect = range.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? rect : undefined;
};

const sanitizeHighlightKey = (value: string): string =>
  value.replaceAll(/[^a-zA-Z0-9_-]/g, "_");

const ExternalSourceLogo = ({
  className,
  iconHref,
}: {
  className?: string | undefined;
  iconHref?: string | undefined;
}) => {
  if (iconHref) {
    return (
      <span
        className={cn(
          "bg-background flex size-4 shrink-0 items-center justify-center rounded-sm border",
          className,
        )}
      >
        <img
          alt=""
          className="size-3 rounded-[2px] object-contain"
          height={12}
          src={iconHref}
          width={12}
        />
      </span>
    );
  }

  return (
    <ExternalLinkIcon
      className={cn("text-muted-foreground size-3.5 shrink-0", className)}
    />
  );
};

const findMcpConnectorIconHref = ({
  connectorSlug,
  connectors,
}: {
  connectorSlug: string;
  connectors: {
    iconUrl: string | null;
    slug: string;
    url: string;
  }[];
}): string | undefined => {
  const connector = connectors.find(
    (item) => sanitizeMcpToolNamePart(item.slug) === connectorSlug,
  );
  if (!connector) {
    return undefined;
  }

  const iconHref = connector.iconUrl ?? fallbackIconUrl(connector.url);
  return iconHref === undefined ? undefined : sanitizeHref(iconHref);
};

const sanitizeMcpToolNamePart = (value: string): string =>
  value.replaceAll(/[^a-zA-Z0-9_-]/g, "_");

const fallbackIconUrl = (rawUrl: string): string | undefined => {
  try {
    return new URL("/favicon.ico", rawUrl).toString();
  } catch {
    return undefined;
  }
};

type ExternalPdfState =
  | {
      status: "idle" | "loading" | "error";
      buffer?: undefined;
      token?: undefined;
    }
  | { status: "ready"; buffer: ArrayBuffer; token: string };

const useExternalPdfBuffer = ({
  enabled,
  url,
}: {
  enabled: boolean;
  url?: string | undefined;
}): ExternalPdfState => {
  const [state, setState] = useState<ExternalPdfState>({ status: "idle" });

  useEffect(() => {
    if (!enabled || url === undefined) {
      setState({ status: "idle" });
      return undefined;
    }

    setState({ status: "loading" });
    const controller = new AbortController();

    void (async () => {
      const response = await fetch(url, {
        credentials: "include",
        signal: controller.signal,
      });

      if (!response.ok || controller.signal.aborted) {
        if (!controller.signal.aborted) {
          setState({ status: "error" });
        }
        return;
      }

      const next = await response.arrayBuffer();
      if (controller.signal.aborted) {
        return;
      }

      // The PDF document cache (`usePDFDocument`) keys only by
      // `fileId` and ignores the buffer, so a same-URL refetch with
      // new bytes would otherwise return the stale parsed document.
      // The token rotates per buffer fetch and is folded into the
      // `fileId` so each new buffer parses from scratch.
      setState({ status: "ready", buffer: next, token: crypto.randomUUID() });
    })().catch(() => {
      if (!controller.signal.aborted) {
        setState({ status: "error" });
      }
    });

    return () => {
      controller.abort();
    };
  }, [enabled, url]);

  return state;
};

const externalPdfSuspenseFallback = (
  <div className="space-y-3 p-4">
    <Skeleton className="h-4 w-2/3" />
    <Skeleton className="h-4 w-full" />
    <Skeleton className="h-4 w-5/6" />
    <Skeleton className="h-4 w-4/5" />
  </div>
);

const ExternalPdfPreview = ({
  buffer,
  onOpenOriginal,
  status,
  url,
  token,
}: {
  buffer: ArrayBuffer | undefined;
  onOpenOriginal: () => void;
  status: "error" | "idle" | "loading" | "ready";
  url: string;
  token: string | undefined;
}) => {
  if (status === "error") {
    return (
      <ExternalPreviewUnavailable
        canOpenOriginal
        onOpenOriginal={onOpenOriginal}
      />
    );
  }

  if (buffer === undefined || token === undefined || status !== "ready") {
    return externalPdfSuspenseFallback;
  }

  // Token rotates per buffer fetch so the PDF document cache (which
  // keys by fileId only) parses fresh bytes instead of returning the
  // stale parsed document. The `key` on MeasuredPdfProvider forces
  // the underlying store to remount whenever a new buffer arrives.
  const fileId = `external:${url}:${token}`;
  const fallback: PDFPageFallback = {
    suspense: externalPdfSuspenseFallback,
    error: (
      <ExternalPreviewUnavailable
        canOpenOriginal
        onOpenOriginal={onOpenOriginal}
      />
    ),
  };

  return (
    <MeasuredPdfProvider
      active
      fallback={fallback}
      fieldId={fileId}
      initialScaleOffset={0}
      key={fileId}
    >
      <PDFViewport
        buffer={buffer}
        className="document-preview-surface h-full"
        contentClassName="relative space-y-2 px-2 pt-2"
        fileId={fileId}
        renderPage={(props) => <PDFPage {...props} />}
      />
    </MeasuredPdfProvider>
  );
};

const ExternalPreviewUnavailable = ({
  canOpenOriginal,
  onOpenOriginal,
}: {
  canOpenOriginal: boolean;
  onOpenOriginal: () => void;
}) => {
  const t = useTranslations();

  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="max-w-sm text-center">
        <ExternalLinkIcon className="text-muted-foreground mx-auto size-6" />
        <p className="text-muted-foreground mt-3 text-sm">
          {t("inspector.external.unavailable")}
        </p>
        {canOpenOriginal && (
          <Button
            className="mt-4"
            aria-label={t("inspector.external.openOriginal")}
            onClick={onOpenOriginal}
            size="sm"
            variant="outline"
          >
            <ExternalLinkIcon className="size-3.5" />
            {t("inspector.external.openOriginal")}
          </Button>
        )}
      </div>
    </div>
  );
};

const ExternalReferencePanel = ({
  onClose,
  tab,
  workspaceId,
}: ExternalReferencePanelProps) => {
  const t = useTranslations();
  const fallbackChatThreadIdRef = useRef(createChatThreadId());
  const safeHref = sanitizeHref(tab.url);
  const [confirmHref, setConfirmHref] = useState<string | undefined>();
  const canPreview =
    safeHref !== undefined &&
    (safeHref.startsWith("https://") || safeHref.startsWith("http://"));
  const storedSource = useExternalSourceStore((state) =>
    safeHref === undefined ? undefined : state.sourcesByUrl[safeHref],
  );
  const shouldFetchPreview =
    canPreview &&
    tab.text === undefined &&
    storedSource?.text === undefined &&
    (tab.connectorSlug !== undefined ||
      tab.sourceToolName !== undefined ||
      storedSource?.connectorSlug !== undefined ||
      storedSource?.sourceToolName !== undefined);
  const {
    data: fetchedPreview,
    isLoading: previewLoading,
    error: previewError,
  } = useQuery({
    queryKey: ["external-preview", tab.url],
    queryFn: async ({ signal }) => {
      const response = await api["external-preview"].get({
        query: { url: tab.url },
        fetch: { signal },
      });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    enabled: shouldFetchPreview,
    retry: false,
    staleTime: 1000 * 60 * 10,
  });

  // Surface upstream-induced failures (e.g. the source returned 5xx)
  // as a toast — without this the panel just falls through to the
  // generic "preview unavailable" view and the user has no signal
  // that anything went wrong.
  //
  // Two filters keep this from being noisy:
  // 1. Only 5xx — 4xx errors (422 unsupported content type / too
  //    little readable text) are expected outcomes the fallback
  //    already handles.
  // 2. Dedupe by (url, status) across the inspector's lifetime so
  //    flipping between tabs doesn't re-toast a cached error.
  useEffect(() => {
    if (!previewError || !APIError.is(previewError)) {
      return;
    }
    if (previewError.status < SERVER_PREVIEW_ERROR_THRESHOLD) {
      return;
    }
    const key = `${tab.url}|${previewError.status}`;
    if (toastedPreviewFailures.has(key)) {
      return;
    }
    toastedPreviewFailures.add(key);
    stellaToast.add({
      title: t("common.somethingWentWrong"),
      description: previewError.message,
      type: "error",
    });
  }, [previewError, tab.url, t]);
  const previewTitle = fetchedPreview?.title ?? storedSource?.title;
  const previewText = tab.text ?? storedSource?.text ?? fetchedPreview?.text;
  const previewSnippet = tab.snippet ?? storedSource?.snippet;
  const provider = tab.provider ?? storedSource?.provider;
  const connectorSlug = tab.connectorSlug ?? storedSource?.connectorSlug;
  const storedIconHref = tab.iconHref ?? storedSource?.iconHref;
  const sourceToolName = tab.sourceToolName ?? storedSource?.sourceToolName;
  const externalFilePreviewUrl =
    safeHref === undefined
      ? undefined
      : `${env.VITE_API_URL}/v1/external-preview/file?url=${encodeURIComponent(safeHref)}`;
  const shouldLoadExternalPdf =
    fetchedPreview?.format === "pdf" && externalFilePreviewUrl !== undefined;
  const externalPdfPreview = useExternalPdfBuffer({
    enabled: shouldLoadExternalPdf,
    url: externalFilePreviewUrl,
  });
  const externalChatThreadId =
    tab.chatThreadId ?? fallbackChatThreadIdRef.current;
  const hasMetadata =
    provider !== undefined ||
    connectorSlug !== undefined ||
    sourceToolName !== undefined;
  const activeExternal = useMemo(
    () =>
      canPreview
        ? {
            connectorSlug,
            provider,
            snippet: previewSnippet,
            sourceToolName,
            text: previewText,
            title: previewTitle ?? tab.label,
            url: safeHref,
          }
        : undefined,
    [
      canPreview,
      connectorSlug,
      provider,
      previewText,
      previewTitle,
      previewSnippet,
      safeHref,
      tab.label,
      sourceToolName,
    ],
  );
  const highlightKey = useMemo(() => sanitizeHighlightKey(tab.id), [tab.id]);
  const contentRef = useRef<HTMLElement | null>(null);
  const findInputRef = useRef<HTMLInputElement | null>(null);
  const {
    activeMatchNumber,
    clearFind,
    closeFind,
    findOpen,
    findQuery,
    matchCount,
    nextMatch,
    openFind,
    previousMatch,
    setFindQuery,
  } = useInspectorFind({
    contentRef,
    enabled: previewText !== undefined,
    highlightKey,
  });
  const { data: mcpConnectorsData } = useQuery({
    ...mcpConnectorsOptions(),
    enabled: connectorSlug !== undefined,
  });
  const iconHref =
    storedIconHref ??
    (connectorSlug === undefined
      ? undefined
      : findMcpConnectorIconHref({
          connectorSlug,
          connectors: mcpConnectorsData?.connectors ?? [],
        }));
  const requestOpenExternal = useCallback((href: string) => {
    setConfirmHref(href);
  }, []);
  const requestSafeExternalOpen = useCallback(() => {
    if (safeHref === undefined) {
      return;
    }

    requestOpenExternal(safeHref);
  }, [requestOpenExternal, safeHref]);
  const openConfirmedExternal = useCallback(() => {
    if (confirmHref === undefined) {
      return;
    }

    window.open(confirmHref, "_blank", "noopener,noreferrer");
    setConfirmHref(undefined);
  }, [confirmHref]);
  const copyConfirmHref = useCallback(async () => {
    if (confirmHref === undefined) {
      return;
    }

    try {
      await navigator.clipboard.writeText(confirmHref);
      void stellaToast.success(t("common.copied"));
    } catch {
      void stellaToast.error(t("common.error"));
    }
  }, [confirmHref, t]);

  useEffect(() => {
    if (!findOpen) {
      return;
    }
    findInputRef.current?.focus();
    findInputRef.current?.select();
  }, [findOpen]);

  return (
    <div className="bg-background flex min-h-0 flex-1 flex-col overflow-hidden">
      <style>
        {`
          ::highlight(stella-inspector-find-${highlightKey}) {
            background-color: color-mix(in oklab, var(--color-primary) 22%, transparent);
            color: inherit;
          }
          ::highlight(stella-inspector-find-active-${highlightKey}) {
            background-color: color-mix(in oklab, var(--color-primary) 45%, transparent);
            color: inherit;
          }
        `}
      </style>
      <InspectorTabHeader
        actions={
          <div className="flex items-center gap-1">
            {previewText && (
              <Button
                aria-label={t("folio.findReplace.find")}
                onClick={openFind}
                size="xs"
                title="Cmd+F"
                variant="ghost"
              >
                <SearchIcon className="size-3.5" />
                {t("folio.findReplace.find")}
              </Button>
            )}
            {canPreview && (
              <Button
                aria-label={t("inspector.external.openOriginal")}
                onClick={() => {
                  requestOpenExternal(safeHref);
                }}
                size="xs"
                variant="ghost"
              >
                <ExternalLinkIcon className="size-3.5" />
                {t("inspector.external.openOriginal")}
              </Button>
            )}
          </div>
        }
        label={tab.label}
        onClose={onClose}
      />
      <FileViewerWithAI
        activeExternal={activeExternal}
        chatThreadId={externalChatThreadId}
        className="min-h-0 flex-1"
        workspaceId={workspaceId}
      >
        <div className="flex h-full min-h-0 flex-col overflow-hidden">
          <div className="flex h-12 flex-col justify-center overflow-hidden border-b px-3">
            {hasMetadata && (
              <div className="flex min-w-0 items-center gap-1.5">
                <ExternalSourceLogo iconHref={iconHref} />
                {provider && (
                  <p className="text-muted-foreground truncate text-xs">
                    {provider}
                  </p>
                )}
                {connectorSlug && (
                  <span
                    className="bg-muted text-muted-foreground max-w-24 truncate rounded px-1.5 py-0.5 font-mono text-[10px]"
                    title={connectorSlug}
                  >
                    {connectorSlug}
                  </span>
                )}
                {sourceToolName && (
                  <span
                    className="bg-muted text-muted-foreground min-w-0 truncate rounded px-1.5 py-0.5 font-mono text-[10px]"
                    title={sourceToolName}
                  >
                    {sourceToolName}
                  </span>
                )}
              </div>
            )}
            {canPreview && (
              <button
                className={cn(
                  "text-muted-foreground hover:text-foreground truncate text-start text-xs underline-offset-2 hover:underline",
                  hasMetadata && "mt-1",
                )}
                onClick={() => {
                  requestOpenExternal(safeHref);
                }}
                type="button"
              >
                {safeHref}
              </button>
            )}
          </div>
          {findOpen && (
            <div className="flex h-10 shrink-0 items-center gap-1 border-b px-2">
              <SearchIcon className="text-muted-foreground size-3.5 shrink-0" />
              <Input
                aria-label={t("folio.findReplace.findText")}
                className="h-7 flex-1 rounded-md"
                nativeInput
                onChange={(event) => {
                  setFindQuery(event.currentTarget.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    clearFind();
                    closeFind();
                    return;
                  }
                  if (event.key !== "Enter") {
                    return;
                  }
                  event.preventDefault();
                  if (event.shiftKey) {
                    previousMatch();
                    return;
                  }
                  nextMatch();
                }}
                placeholder={t("folio.findReplace.findPlaceholder")}
                ref={findInputRef}
                size="sm"
                type="search"
                value={findQuery}
              />
              <span className="text-muted-foreground min-w-14 text-end text-xs tabular-nums">
                {findQuery
                  ? matchCount > 0
                    ? t("folio.findReplace.matchCounter", {
                        current: String(activeMatchNumber),
                        total: String(matchCount),
                      })
                    : t("folio.findReplace.noResults")
                  : ""}
              </span>
              <Button
                aria-label={t("folio.findReplace.previous")}
                disabled={matchCount === 0}
                onClick={previousMatch}
                size="icon-xs"
                title={t("folio.findReplace.previousShortcut")}
                variant="ghost"
              >
                <ChevronLeftIcon className="size-3.5" />
              </Button>
              <Button
                aria-label={t("folio.findReplace.next")}
                disabled={matchCount === 0}
                onClick={nextMatch}
                size="icon-xs"
                title={t("folio.findReplace.nextShortcut")}
                variant="ghost"
              >
                <ChevronRightIcon className="size-3.5" />
              </Button>
              <Button
                aria-label={t("folio.findReplace.close")}
                onClick={() => {
                  clearFind();
                  closeFind();
                }}
                size="icon-xs"
                variant="ghost"
              >
                <XIcon className="size-3.5" />
              </Button>
            </div>
          )}
          {previewLoading ? (
            <div className="space-y-3 p-4">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-5/6" />
              <Skeleton className="h-4 w-4/5" />
            </div>
          ) : shouldLoadExternalPdf && externalFilePreviewUrl !== undefined ? (
            <ExternalPdfPreview
              buffer={externalPdfPreview.buffer}
              onOpenOriginal={requestSafeExternalOpen}
              status={externalPdfPreview.status}
              token={externalPdfPreview.token}
              url={externalFilePreviewUrl}
            />
          ) : previewText || tab.snippet ? (
            <ScrollArea className="min-h-0 flex-1">
              <article className="max-w-none px-4 py-3" ref={contentRef}>
                {previewSnippet && (
                  <p className="text-muted-foreground border-b pb-3 text-sm">
                    {previewSnippet}
                  </p>
                )}
                {previewText && (
                  <div className="text-foreground text-sm leading-6">
                    {previewTitle && previewTitle !== tab.label ? (
                      <h2 className="mb-3 font-medium">{previewTitle}</h2>
                    ) : null}
                    {fetchedPreview?.format === "markdown" ? (
                      <MessageResponse className="text-sm">
                        {previewText}
                      </MessageResponse>
                    ) : (
                      <div className="whitespace-pre-wrap">{previewText}</div>
                    )}
                  </div>
                )}
              </article>
            </ScrollArea>
          ) : (
            <ExternalPreviewUnavailable
              canOpenOriginal={canPreview}
              onOpenOriginal={requestSafeExternalOpen}
            />
          )}
        </div>
      </FileViewerWithAI>
      <Dialog
        onOpenChange={(open) => {
          if (!open) {
            setConfirmHref(undefined);
          }
        }}
        open={confirmHref !== undefined}
      >
        <DialogPopup className="sm:max-w-md">
          <DialogHeader className="pe-12">
            <DialogTitle className="flex items-center gap-2">
              <ExternalLinkIcon className="size-5" />
              {t("inspector.external.confirmTitle")}
            </DialogTitle>
            <DialogDescription>
              {t("inspector.external.confirmDescription")}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="bg-muted rounded-md px-3 py-3 font-mono text-sm break-all">
              {confirmHref}
            </div>
          </DialogPanel>
          <DialogFooter
            className="grid grid-cols-2 gap-2 sm:grid-cols-2"
            variant="bare"
          >
            <Button
              onClick={() => {
                void copyConfirmHref();
              }}
              variant="outline"
            >
              <CopyIcon className="size-4" />
              {t("common.copyLink")}
            </Button>
            <Button onClick={openConfirmedExternal}>
              <ExternalLinkIcon className="size-4" />
              {t("inspector.external.openLink")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
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
  const externalConnectorSlug =
    tab.type === "external" ? tab.connectorSlug : undefined;
  const storedExternalIconHref =
    tab.type === "external" ? tab.iconHref : undefined;
  const { data: mcpConnectorsData } = useQuery({
    ...mcpConnectorsOptions(),
    enabled:
      externalConnectorSlug !== undefined &&
      storedExternalIconHref === undefined,
  });
  const externalIconHref =
    storedExternalIconHref ??
    (externalConnectorSlug === undefined
      ? undefined
      : findMcpConnectorIconHref({
          connectorSlug: externalConnectorSlug,
          connectors: mcpConnectorsData?.connectors ?? [],
        }));

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
              "group/tab relative flex min-h-8 w-full items-center justify-center border-b transition-colors",
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
        ) : tab.type === "external" ? (
          <ExternalSourceLogo
            className="size-3.5 border-0"
            iconHref={externalIconHref}
          />
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
