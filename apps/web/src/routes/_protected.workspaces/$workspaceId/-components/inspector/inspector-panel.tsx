import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { PropsWithChildren } from "react";

import { useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  FileTextIcon,
  ListIcon,
  ScanEyeIcon,
  SparklesIcon,
  SquareCheckIcon,
  XIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";
import { useShallow } from "zustand/shallow";

import { Button } from "@stella/ui/components/button";
import { ScrollArea } from "@stella/ui/components/scroll-area";
import { toastManager } from "@stella/ui/components/toast";
import { cn } from "@stella/ui/lib/utils";

import Tooltip from "@/components/tooltip";
import { TOOLBAR_ROW_HEIGHT } from "@/lib/consts";
import { PDFProvider } from "@/lib/pdf/pdf-context";
import type { PDFPageFallback } from "@/lib/pdf/pdf-page";
import type { WorkspaceProperty } from "@/lib/types";
import { DocumentIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/document-icon";
import {
  anonymisePdf,
  clearAnonymisation,
  useAnonymiseOverlayStore,
} from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/anonymise-pdf";
import { AnonymiseSidebar } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/anonymise-sidebar";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import type {
  InspectorTab,
  PdfTab,
} from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import { PeekJustification } from "@/routes/_protected.workspaces/$workspaceId/-components/peek/peek-justification";
import {
  PeekPdfControls,
  PeekPdfViewer,
  PeekSuspenseFallback,
} from "@/routes/_protected.workspaces/$workspaceId/-components/peek/peek-pdf-viewer";
import { TaskDetailPanel } from "@/routes/_protected.workspaces/$workspaceId/-components/tasks/task-detail-panel";
import { entityOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import { propertiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";
import { useWorkspaceStore } from "@/routes/_protected.workspaces/$workspaceId/-store";

type InspectorPanelProps = {
  workspaceId: string;
};

const ZOOM_STEP = 0.2;
const MIN_OFFSET = -0.8;
const MAX_OFFSET = 2;
const PINCH_ZOOM_SENSITIVITY = 0.005;

export const InspectorPanel = ({ workspaceId }: InspectorPanelProps) => {
  const t = useTranslations();
  const { tabs, activeId } = useInspectorStore(
    useShallow((s) => ({
      tabs: s.tabs,
      activeId: s.activeId,
    })),
  );
  const setActive = useInspectorStore((s) => s.setActive);
  const closeTab = useInspectorStore((s) => s.closeTab);
  const closeAll = useInspectorStore((s) => s.closeAll);
  const anonymisedFieldIds = useAnonymiseOverlayStore(
    useShallow((s) => [...s.overlays.keys()]),
  );
  const [anonymisingIds, setAnonymisingIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [anonSidebarFieldId, setAnonSidebarFieldId] = useState<string | null>(
    null,
  );
  const navigate = useNavigate({
    from: "/workspaces/$workspaceId/$viewId",
  });

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

  const handleOpenFullView = useCallback(async () => {
    if (!activeTab || activeTab.type !== "pdf") {
      return;
    }
    try {
      await navigate({
        to: "/workspaces/$workspaceId/$viewId/pdf",
        params: { workspaceId, viewId: "all" },
        search: {
          file: { fieldId: activeTab.id },
          justification: undefined,
          entity: {
            id: activeTab.entityId,
            visible: true,
            activePropertyId: activeTab.propertyId ?? "",
          },
        },
      });
    } finally {
      // Clear anonymisation data for all open tabs before
      // closing them to prevent stale store entries.
      for (const tab of tabs) {
        clearAnonymisation(tab.id);
      }
      setAnonSidebarFieldId(null);
      closeAll();
    }
  }, [activeTab, navigate, closeAll, tabs, workspaceId]);

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
      return;
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
                    clearAnonymisation(tab.id);
                    setAnonSidebarFieldId((prev) =>
                      prev === tab.id ? null : prev,
                    );
                    closeTab(tab.id);
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
        return (
          <div
            className={cn(
              "flex flex-1 flex-col overflow-hidden",
              !isActive && "hidden",
            )}
            key={tab.id}
            ref={isActive ? pdfContentRef : undefined}
          >
            {/* Context bar: filename + non-PDF actions */}
            <div
              className={cn(
                "flex shrink-0 items-center justify-between border-b px-3",
                TOOLBAR_ROW_HEIGHT,
              )}
            >
              <div className="flex items-center overflow-hidden">
                <span className="truncate text-xs font-medium">
                  {tab.label}
                </span>
              </div>

              <div className="flex shrink-0 items-center gap-1 ps-4">
                <Tooltip
                  content={t("anonymise.checkAnonymisation")}
                  render={
                    <Button
                      disabled={anonymisingIds.has(tab.id)}
                      onClick={() => {
                        const isAnon = anonymisedFieldIds.includes(tab.id);
                        if (isAnon) {
                          clearAnonymisation(tab.id);
                          setAnonSidebarFieldId((prev) =>
                            prev === tab.id ? null : prev,
                          );
                        } else {
                          setAnonymisingIds((prev) =>
                            new Set(prev).add(tab.id),
                          );
                          anonymisePdf({
                            workspaceId,
                            fieldId: tab.id,
                            mimeType: tab.mimeType ?? null,
                          })
                            .catch(() => {
                              toastManager.add({
                                title: t("errors.actionFailed"),
                                type: "error",
                              });
                            })
                            .finally(() => {
                              setAnonymisingIds((prev) => {
                                const next = new Set(prev);
                                next.delete(tab.id);
                                return next;
                              });
                            });
                        }
                      }}
                      size="icon-xs"
                      variant={
                        anonymisedFieldIds.includes(tab.id)
                          ? "default"
                          : "ghost"
                      }
                    >
                      <ScanEyeIcon className="size-3.5" />
                    </Button>
                  }
                />
                {anonymisedFieldIds.includes(tab.id) && (
                  <Tooltip
                    content={t("anonymise.entities")}
                    render={
                      <Button
                        onClick={() =>
                          setAnonSidebarFieldId(
                            anonSidebarFieldId === tab.id ? null : tab.id,
                          )
                        }
                        size="icon-xs"
                        variant={
                          anonSidebarFieldId === tab.id ? "default" : "ghost"
                        }
                      >
                        <ListIcon className="size-3.5" />
                      </Button>
                    }
                  />
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
                <Button
                  onClick={() => {
                    clearAnonymisation(tab.id);
                    setAnonSidebarFieldId((prev) =>
                      prev === tab.id ? null : prev,
                    );
                    closeTab(tab.id);
                  }}
                  size="icon-xs"
                  variant="ghost"
                >
                  <XIcon className="size-3.5" />
                </Button>
              </div>
            </div>

            {/* PDF + optional sidebar row */}
            <div className="flex min-h-0 min-w-0 flex-1">
              <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                <div className="flex h-full min-h-0 min-w-0 flex-col">
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
                      <JustificationBar
                        activeTab={tab}
                        fieldId={tab.justificationFieldId}
                        workspaceId={workspaceId}
                      />
                    </Suspense>
                  )}
                  <MeasuredPdfProvider
                    active={isActive}
                    fallback={{ suspense: <PeekSuspenseFallback /> }}
                    initialScaleOffset={scaleOffsets.get(tab.id) ?? 0}
                  >
                    <PeekPdfControls
                      canResetZoom={scaleOffsets.get(tab.id) !== 0}
                      onResetZoom={() => handleResetZoom(tab.id)}
                      onZoomIn={() => handleZoom(tab.id, "in")}
                      onZoomOut={() => handleZoom(tab.id, "out")}
                      scaleOffset={scaleOffsets.get(tab.id) ?? 0}
                    />
                    <PeekPdfViewer
                      fieldId={tab.id}
                      scaleOffset={scaleOffsets.get(tab.id) ?? 0}
                      workspaceId={workspaceId}
                    />
                  </MeasuredPdfProvider>
                </div>
              </div>

              {isActive && anonSidebarFieldId === tab.id && (
                <AnonymiseSidebar
                  fieldId={tab.id}
                  onClose={() => setAnonSidebarFieldId(null)}
                />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
};

type MeasuredPdfProviderProps = PropsWithChildren<{
  active: boolean;
  fallback?: PDFPageFallback | undefined;
  initialScaleOffset: number;
}>;

const MeasuredPdfProvider = ({
  active,
  children,
  fallback,
  initialScaleOffset,
}: MeasuredPdfProviderProps) => {
  const [initialFitWidth, setInitialFitWidth] = useState<number | undefined>();
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!active || initialFitWidth !== undefined) {
      return;
    }

    const container = containerRef.current;
    if (!container) {
      return;
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
          fitToWidth={initialFitWidth}
          initialScaleOffset={initialScaleOffset}
          startPage={1}
          fallback={fallback}
        >
          {children}
        </PDFProvider>
      )}
    </div>
  );
};

// ── Justification bar ──────────────────────────────

const JustificationBar = ({
  activeTab,
  fieldId,
  workspaceId,
}: {
  activeTab: PdfTab;
  fieldId: string;
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
      .filter(
        (
          s,
        ): s is {
          fieldId: string;
          property: WorkspaceProperty;
        } => s !== null,
      );
  }, [entity, justification, properties]);

  const currentIdx = slots.findIndex((s) => s.fieldId === fieldId);
  const prev = currentIdx > 0 ? slots[currentIdx - 1] : null;
  const next =
    currentIdx !== -1 && currentIdx < slots.length - 1
      ? slots[currentIdx + 1]
      : null;

  if (!justification) {
    return null;
  }

  return (
    <div
      className={cn(
        "bg-muted/30 flex shrink-0 items-center justify-between border-b px-3",
        TOOLBAR_ROW_HEIGHT,
      )}
    >
      <div className="flex flex-1 items-center gap-2 overflow-hidden text-xs">
        <SparklesIcon className="size-3.5 shrink-0 text-amber-500" />
        <div className="truncate">
          <span className="font-semibold">{t("workspaces.pdf.evidence")}:</span>{" "}
          <PeekJustification
            activeFileFieldId={activeTab.id}
            justification={justification}
          />
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1 ps-4">
        <Button
          disabled={!prev}
          onClick={() =>
            prev &&
            openPdf({
              id: activeTab.id,
              entityId: activeTab.entityId,
              label: activeTab.label,
              workspaceId: activeTab.workspaceId,
              justificationFieldId: prev.fieldId,
              propertyId: prev.property.id,
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
          disabled={!next}
          onClick={() =>
            next &&
            openPdf({
              id: activeTab.id,
              entityId: activeTab.entityId,
              label: activeTab.label,
              workspaceId: activeTab.workspaceId,
              justificationFieldId: next.fieldId,
              propertyId: next.property.id,
            })
          }
          size="icon-xs"
          variant="ghost"
        >
          <ChevronRightIcon className="size-3.5" />
        </Button>
      </div>
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
        <SquareCheckIcon className="size-3.5" />
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
