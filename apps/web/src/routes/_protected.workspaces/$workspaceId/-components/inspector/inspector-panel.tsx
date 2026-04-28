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

import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useMatch, useNavigate } from "@tanstack/react-router";
import {
  AlertTriangleIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  FileTextIcon,
  LoaderCircleIcon,
  PencilIcon,
  PrinterIcon,
  XIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";
import { useShallow } from "zustand/shallow";

import { Button } from "@stella/ui/components/button";
import { ScrollArea } from "@stella/ui/components/scroll-area";
import { toastManager } from "@stella/ui/components/toast";
import { cn } from "@stella/ui/lib/utils";

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
import { EntityKindIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/entity-kind-icon";
import { InlineEdit } from "@/routes/_protected.workspaces/$workspaceId/-components/inline-edit";
import { clearAnonymization } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/anonymize-pdf";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import type {
  InspectorTab,
  PdfTab,
} from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import { PeekJustification } from "@/routes/_protected.workspaces/$workspaceId/-components/peek/peek-justification";
import {
  PeekPdfControls,
  PeekPdfViewer,
  PeekPrintButton,
  PeekSuspenseFallback,
} from "@/routes/_protected.workspaces/$workspaceId/-components/peek/peek-pdf-viewer";
import { TaskDetailPanel } from "@/routes/_protected.workspaces/$workspaceId/-components/tasks/task-detail-panel";
import { useRenameEntity } from "@/routes/_protected.workspaces/$workspaceId/-mutations/entities";
import { entityOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import { propertiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";
import { workspaceKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/workspace";
import { useWorkspaceStore } from "@/routes/_protected.workspaces/$workspaceId/-store";

type InspectorPanelProps = {
  workspaceId: string;
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
  const navigate = useNavigate({
    from: "/workspaces/$workspaceId/$viewId",
  });
  const setPdfViewerState = useWorkspaceStore((s) => s.setPdfViewerState);

  const viewMatch = useMatch({
    from: "/_protected/workspaces/$workspaceId/$viewId",
    shouldThrow: false,
  });
  const peekPdfViewId = viewMatch?.params.viewId ?? "all";

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
  const docxPrintActionsRef = useRef(new Map<string, () => void>());
  const [docxScrollTopByTab, setDocxScrollTopByTab] = useState<
    Map<string, number>
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
    [editingDocxTabId],
  );

  const flashDocxEditButton = useCallback((tabId: string) => {
    if (flashDocxEditTimerRef.current !== null) {
      clearTimeout(flashDocxEditTimerRef.current);
    }
    setFlashingDocxEditTabId(tabId);
    flashDocxEditTimerRef.current = setTimeout(() => {
      setFlashingDocxEditTabId(null);
      flashDocxEditTimerRef.current = null;
    }, 900);
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
        { workspaceId, entityId: tab.entityId, name: newName },
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
    [editValue, workspaceId, renameEntity, t],
  );

  const handleOpenFullView = useCallback(async () => {
    if (!activeTab || activeTab.type !== "pdf") {
      return;
    }
    const previousPdfViewer = {
      ...useWorkspaceStore.getState().pdfViewer,
    };
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
        to: "/workspaces/$workspaceId/$viewId/pdf",
        params: { workspaceId, viewId: "all" },
        search: {
          entity: activeTab.entityId,
          field: activeTab.id,
          justification: undefined,
          justificationPage: undefined,
        },
      });
    } catch (error) {
      setPdfViewerState(previousPdfViewer);
      throw error;
    } finally {
      closeAll();
    }
  }, [activeTab, closeAll, navigate, setPdfViewerState, workspaceId]);

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

  return (
    <div className="bg-background flex h-full border-s shadow-lg">
      {/* Vertical tab bar */}
      {tabs.length > 0 && (
        <div className="bg-muted/50 flex w-10 shrink-0 flex-col border-e">
          <ScrollArea className="flex-1">
            <div className="flex flex-col">
              {tabs.map((tab) => (
                <VerticalTab
                  active={tab.id === activeId}
                  key={tab.id}
                  onActivate={() => setActive(tab.id)}
                  onClose={() => {
                    handleCloseTab(tab.id);
                  }}
                  tab={tab}
                />
              ))}
            </div>
          </ScrollArea>
        </div>
      )}

      {/* Task content */}
      {activeTab?.type === "task" && (
        <TaskDetailPanel taskId={activeTab.id} workspaceId={workspaceId} />
      )}

      {/* PDF content — render all open PDF tabs, show only the active one.
         Keeping inactive viewers mounted avoids the blink on tab switch
         (no unmount → Suspense fallback → remount cycle). */}
      {pdfTabs.map((tab) => {
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

        const contextBar = (
          <div
            className={cn(
              "flex shrink-0 items-center justify-between border-b px-3",
              TOOLBAR_ROW_HEIGHT,
            )}
          >
            <div className="flex items-center overflow-hidden">
              {editingTabId === tab.id ? (
                <InlineEdit
                  inputClassName="w-40 text-xs"
                  onCancel={() => setEditingTabId(null)}
                  onChange={setEditValue}
                  onCommit={() => commitRename(tab)}
                  value={editValue}
                />
              ) : (
                <span
                  className="truncate text-xs font-medium"
                  onDoubleClick={() => startRename(tab)}
                >
                  {stripExtension(tab.label)}
                </span>
              )}
            </div>

            <div className="flex shrink-0 items-center gap-1 ps-4">
              {isEditingNativeDocx ? (
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
                  <Tooltip
                    content={t("common.print")}
                    render={
                      <Button
                        onClick={() => {
                          docxActionsRef.current.get(tab.id)?.print();
                        }}
                        size="icon-xs"
                        variant="ghost"
                      >
                        <PrinterIcon className="size-3.5" />
                      </Button>
                    }
                  />
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
                  {canUpdateEntity &&
                    isNativeDocxDisplay &&
                    tab.propertyId !== undefined &&
                    !isEditingNativeDocx && (
                      <Tooltip
                        content={t("common.edit")}
                        render={
                          <Button
                            className={cn(
                              flashingDocxEditTabId === tab.id &&
                                "bg-primary/10 text-primary ring-primary/60 animate-pulse ring-2",
                            )}
                            onClick={() => {
                              void handleStartDocxEdit(tab.id);
                            }}
                            size="icon-xs"
                            variant="ghost"
                          >
                            <PencilIcon className="size-3.5" />
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
                  {isNativeDocxDisplay ? (
                    <Tooltip
                      content={t("common.print")}
                      render={
                        <Button
                          onClick={() => {
                            if (tab.propertyId !== undefined) {
                              docxActionsRef.current.get(tab.id)?.print();
                              return;
                            }
                            docxPrintActionsRef.current.get(tab.id)?.();
                          }}
                          size="icon-xs"
                          variant="ghost"
                        >
                          <PrinterIcon className="size-3.5" />
                        </Button>
                      }
                    />
                  ) : (
                    <PeekPrintButton />
                  )}
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
                        <ExternalLinkIcon className="size-3.5" />
                      </Button>
                    }
                  />
                </>
              )}
              <Button
                onClick={() => {
                  handleCloseTab(tab.id);
                }}
                size="icon-xs"
                variant="ghost"
              >
                <XIcon className="size-3.5" />
              </Button>
            </div>
          </div>
        );

        const viewerContent = (
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
                  workspaceId={workspaceId}
                />
              </Suspense>
            )}
            {isNativeDocxDisplay && tab.propertyId !== undefined ? (
              <Suspense fallback={<PeekSuspenseFallback />}>
                <DocxBrowserEditor
                  actionsKey={tab.id}
                  actionsMapRef={docxActionsRef}
                  entityId={tab.entityId}
                  fieldId={tab.id}
                  initialScrollTop={docxScrollTopByTab.get(tab.id)}
                  isEditing={isEditingNativeDocx}
                  onClose={() => {
                    docxActionsRef.current.delete(tab.id);
                    setEditingDocxTabId(null);
                  }}
                  onPreviewDoubleClick={() => {
                    if (
                      canUpdateEntity &&
                      isNativeDocxDisplay &&
                      tab.propertyId !== undefined &&
                      !isEditingNativeDocx
                    ) {
                      flashDocxEditButton(tab.id);
                    }
                  }}
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
                  onScrollTopChange={(scrollTop) => {
                    setDocxScrollTopByTab((prev) => {
                      const next = new Map(prev);
                      next.set(tab.id, scrollTop);
                      return next;
                    });
                  }}
                  propertyId={tab.propertyId}
                  scaleOffset={scaleOffsets.get(tab.id) ?? 0}
                  showActionBar={false}
                  workspaceId={workspaceId}
                />
              </Suspense>
            ) : (
              <Suspense fallback={<PeekSuspenseFallback />}>
                <PeekPdfViewer
                  activePropertyId={tab.propertyId ?? ""}
                  entityId={tab.entityId}
                  fieldId={tab.id}
                  filePurpose={
                    isNativeDocxDisplay ? "native-display" : "display"
                  }
                  docxPrintActionsRef={docxPrintActionsRef}
                  mimeType={tab.mimeType ?? undefined}
                  onDocxScrollTopChange={(scrollTop) => {
                    setDocxScrollTopByTab((prev) => {
                      const next = new Map(prev);
                      next.set(tab.id, scrollTop);
                      return next;
                    });
                  }}
                  onPeekNavigate={closeAll}
                  scaleOffset={scaleOffsets.get(tab.id) ?? 0}
                  viewId={peekPdfViewId}
                  workspaceId={workspaceId}
                />
              </Suspense>
            )}
          </div>
        );

        return (
          <div
            className={cn(
              "flex flex-1 flex-col overflow-hidden",
              !isActive && "hidden",
            )}
            key={tab.id}
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
                onError={() => {
                  toastManager.add({
                    title: t("errors.actionFailed"),
                    type: "error",
                  });
                }}
              >
                {contextBar}
                {viewerContent}
              </MeasuredPdfProvider>
            )}
          </div>
        );
      })}
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

// ── Error fallback ────────────────────────────────

const InspectorPdfErrorFallback = ({ onClose }: { onClose: () => void }) => {
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
            onClick={() =>
              prevSlot &&
              openPdf({
                id: activeTab.id,
                entityId: activeTab.entityId,
                label: activeTab.label,
                workspaceId: activeTab.workspaceId,
                mimeType: activeTab.mimeType,
                pdfFileId: activeTab.pdfFileId,
                justificationFieldId: prevSlot.fieldId,
                propertyId: prevSlot.property.id,
              })
            }
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
            onClick={() =>
              nextSlot &&
              openPdf({
                id: activeTab.id,
                entityId: activeTab.entityId,
                label: activeTab.label,
                workspaceId: activeTab.workspaceId,
                mimeType: activeTab.mimeType,
                pdfFileId: activeTab.pdfFileId,
                justificationFieldId: nextSlot.fieldId,
                propertyId: nextSlot.property.id,
              })
            }
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
          type="button"
        />
      }
      side="left"
    >
      {tab.type === "task" ? (
        <EntityKindIcon className="size-3.5" kind="task" status={tab.status} />
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
  );
};
