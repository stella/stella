import { Suspense, useCallback, useEffect, useMemo, useRef } from "react";

import { useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  MinusIcon,
  PlusIcon,
  PrinterIcon,
  SparklesIcon,
  XIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";
import { useShallow } from "zustand/shallow";

import { Button } from "@stella/ui/components/button";
import { ScrollArea } from "@stella/ui/components/scroll-area";
import { cn } from "@stella/ui/lib/utils";

import Tooltip from "@/components/tooltip";
import type { WorkspaceProperty } from "@/lib/types";
import { PDF_MIME_TYPE, TEXT_PLAIN_MIME_TYPE } from "@/consts";
import { TOOLBAR_ROW_HEIGHT } from "@/lib/consts";
import { usePdfStore } from "@/lib/pdf/pdf-store";
import { DocumentIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/document-icon";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import type {
  PdfTab,
  TaskTab,
} from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import { PeekJustification } from "@/routes/_protected.workspaces/$workspaceId/-components/peek/peek-justification";
import { PeekPdfViewer } from "@/routes/_protected.workspaces/$workspaceId/-components/peek/peek-pdf-viewer";
import { entityOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import { propertiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";
import { useWorkspaceStore } from "@/routes/_protected.workspaces/$workspaceId/-store";

type InspectorTab = PdfTab | TaskTab;

type InspectorPanelProps = {
  workspaceId: string;
};

const ZOOM_STEP = 0.2;
const MIN_OFFSET = -0.8;
const MAX_OFFSET = 2;

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
  const navigate = useNavigate({
    from: "/workspaces/$workspaceId/$viewId",
  });

  const activeTab = tabs.find((tab) => tab.id === activeId);

  // -- PDF zoom --
  const scaleOffsets = useRef(new Map<string, number>());

  const handleZoom = useCallback(
    (direction: "in" | "out") => {
      if (!activeId || activeTab?.type !== "pdf") {
        return;
      }
      const offsets = scaleOffsets.current;
      const current = offsets.get(activeId) ?? 0;
      const delta = direction === "in" ? ZOOM_STEP : -ZOOM_STEP;
      const next = Math.round((current + delta) * 10) / 10;

      if (next < MIN_OFFSET || next > MAX_OFFSET) {
        return;
      }

      offsets.set(activeId, next);
      usePdfStore.getState().updateScale({
        fileId: activeId,
        scaleOffset: next,
      });
    },
    [activeId, activeTab?.type],
  );

  const isMounted = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  const handlePrint = useCallback(() => {
    if (!activeId || activeTab?.type !== "pdf") {
      return;
    }
    const store = usePdfStore.getState();
    const pdf = store.pdfs.get(activeId);
    if (!pdf) {
      return;
    }

    pdf.document
      .getData()
      .then((data) => {
        if (!isMounted.current) {
          return;
        }
        // oxlint-disable-next-line typescript-eslint/no-explicit-any, typescript-eslint/no-unsafe-type-assertion
        const blob = new Blob([data as any], {
          type: PDF_MIME_TYPE,
        });
        const url = URL.createObjectURL(blob);
        const frame = document.createElement("iframe");
        frame.style.display = "none";
        frame.src = url;
        document.body.append(frame);
        frame.addEventListener("load", () => {
          const cleanup = () => {
            frame.remove();
            URL.revokeObjectURL(url);
          };
          if (!frame.contentWindow) {
            cleanup();
            return;
          }
          frame.contentWindow.addEventListener("afterprint", cleanup);
          frame.contentWindow.print();
        });
      })
      .catch((error: unknown) => {
        // oxlint-disable-next-line no-console
        console.error("Print failed:", error);
      });
  }, [activeId, activeTab?.type]);

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
      closeTab(activeTab.id);
    }
  }, [activeTab, navigate, closeTab, workspaceId]);

  // Pinch-to-zoom for PDF tabs
  const pdfContentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = pdfContentRef.current;
    if (!el || activeTab?.type !== "pdf") {
      return;
    }

    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        handleZoom(e.deltaY < 0 ? "in" : "out");
      }
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [handleZoom, activeTab?.type]);

  return (
    <div className="bg-background flex h-full flex-col border-s shadow-lg">
      {/* Header with horizontal tabs */}
      <div className="flex h-10 shrink-0 items-center justify-between border-b px-2">
        <div className="flex h-full flex-1 gap-px overflow-x-auto">
          {tabs.map((tab) => (
            <VerticalTab
              active={tab.id === activeId}
              key={tab.id}
              onActivate={() => setActive(tab.id)}
              onClose={() => closeTab(tab.id)}
              tab={tab}
            />
          ))}
        </div>
      </div>

      <div
        className="relative flex min-h-0 flex-1 overflow-hidden"
        ref={pdfContentRef}
      >
        {!activeTab ? (
          <div className="text-muted-foreground flex flex-1 items-center justify-center p-8 text-center">
            <div className="space-y-2">
              <DocumentIcon
                className="mx-auto size-12 opacity-20"
                mimeType={PDF_MIME_TYPE}
              />
              <p className="text-sm">{t("workspaces.pdf.selectATab")}</p>
            </div>
          </div>
        ) : (
          <div className="flex flex-1 flex-col overflow-hidden">
            {/* Context bar (PDF only) */}
            {activeTab.type === "pdf" && (
              <div className="flex h-10 shrink-0 items-center justify-between border-b px-3">
                <div className="flex items-center gap-2 overflow-hidden">
                  <DocumentIcon
                    className="text-muted-foreground size-4 shrink-0"
                    mimeType={activeTab.mimeType ?? PDF_MIME_TYPE}
                  />
                  <span className="truncate text-xs font-medium">
                    {activeTab.label}
                  </span>
                </div>

                <div className="flex shrink-0 items-center gap-1 ps-4">
                  <div className="flex items-center rounded-md border p-0.5">
                    <Tooltip
                      content={t("workspaces.pdf.zoomOut")}
                      render={
                        <Button
                          onClick={() => handleZoom("out")}
                          size="icon-xs"
                          variant="ghost"
                        >
                          <MinusIcon className="size-3" />
                        </Button>
                      }
                    />
                    <Tooltip
                      content={t("workspaces.pdf.zoomIn")}
                      render={
                        <Button
                          onClick={() => handleZoom("in")}
                          size="icon-xs"
                          variant="ghost"
                        >
                          <PlusIcon className="size-3" />
                        </Button>
                      }
                    />
                  </div>

                  <div className="bg-border mx-1 h-4 w-px" />

                  <Tooltip
                    content={t("workspaces.pdf.print")}
                    render={
                      <Button
                        onClick={handlePrint}
                        size="icon-xs"
                        variant="ghost"
                      >
                        <PrinterIcon className="size-3.5" />
                      </Button>
                    }
                  />
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
                </div>
              </div>
            )}

            {/* Justification Bar (PDF with justification ID) */}
            {activeTab.type === "pdf" && activeTab.justificationFieldId && (
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
                  activeTab={activeTab}
                  fieldId={activeTab.justificationFieldId}
                  workspaceId={workspaceId}
                />
              </Suspense>
            )}

            {/* Scrollable PDF content */}
            <ScrollArea className="flex-1">
              {activeTab.type === "pdf" ? (
                <Suspense
                  fallback={
                    <div className="flex h-full items-center justify-center p-12">
                      <SparklesIcon className="text-muted-foreground/30 size-8 animate-pulse" />
                    </div>
                  }
                >
                  <PeekPdfViewer
                    fieldId={activeTab.id}
                    workspaceId={workspaceId}
                  />
                </Suspense>
              ) : (
                <div className="text-muted-foreground flex h-full items-center justify-center p-12 text-center">
                  <div className="space-y-4">
                    <SparklesIcon className="mx-auto size-12 opacity-20" />
                    <div className="space-y-1">
                      <p className="text-sm font-medium">
                        {activeTab.label || t("workspaces.pdf.aiTask")}
                      </p>
                      <p className="text-xs">
                        {t("workspaces.pdf.detailViewConstruction")}
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </ScrollArea>
          </div>
        )}
      </div>
    </div>
  );
};

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
    return (
      Object.values(entity.fields)
        .map((f) => {
          const prop = properties.find((p) => p.id === f.propertyId);
          if (!prop || prop.tool.type !== "ai-model") {
            return null;
          }
          return { fieldId: f.id, property: prop };
        })
        .filter(
          (s): s is { fieldId: string; property: WorkspaceProperty } =>
            s !== null,
        )
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

  // Flash the tab when it becomes active (including
  // re-activation when the user opens the same file).
  const activationSeq = useInspectorStore((s) => {
    const item_ = s.tabs.find((it) => it.id === tab.id);
    return item_?.type === "pdf" ? item_.activationSeq : 0;
  });
  const prevSeq = useRef(activationSeq);
  useEffect(() => {
    const el = tabRef.current;
    if (el && active && activationSeq !== prevSeq.current) {
      el.animate(
        [
          { backgroundColor: "var(--amber-100)" },
          { backgroundColor: "transparent" },
        ],
        { duration: 1000, easing: "ease-out" },
      );
    }
    prevSeq.current = activationSeq;
  }, [active, activationSeq]);

  return (
    <div
      className={cn(
        "group relative flex h-full max-w-48 min-w-32 items-center gap-2 border-e px-3 transition-colors",
        active ? "bg-background" : "bg-muted/50 hover:bg-muted/80",
      )}
    >
      <button
        className="flex h-full flex-1 items-center gap-2 overflow-hidden text-start focus:outline-none"
        onClick={onActivate}
        ref={tabRef}
        type="button"
      >
        <DocumentIcon
          className={cn(
            "size-3.5 shrink-0",
            active ? "text-primary" : "text-muted-foreground",
          )}
          mimeType={
            tab.type === "pdf"
              ? (tab.mimeType ?? PDF_MIME_TYPE)
              : TEXT_PLAIN_MIME_TYPE
          }
        />
        <span
          className={cn(
            "truncate text-xs font-medium",
            active ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {tooltipLabel}
        </span>
      </button>

      <button
        className="hover:bg-accent invisible absolute end-1 rounded-sm p-0.5 opacity-60 group-hover:visible hover:opacity-100"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        type="button"
      >
        <XIcon className="size-3" />
      </button>

      {active && (
        <div className="bg-primary absolute start-0 bottom-0 h-0.5 w-full" />
      )}
    </div>
  );
};
