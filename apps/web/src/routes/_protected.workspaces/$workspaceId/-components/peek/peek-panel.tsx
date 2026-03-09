import { Suspense, useCallback, useEffect, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  ExternalLinkIcon,
  MinusIcon,
  PlusIcon,
  PrinterIcon,
  XIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";
import { useShallow } from "zustand/shallow";

import { Button } from "@stella/ui/components/button";
import { ScrollArea } from "@stella/ui/components/scroll-area";
import { cn } from "@stella/ui/lib/utils";

import Tooltip from "@/components/tooltip";
import { PDF_MIME_TYPE } from "@/consts";
import { usePdfStore } from "@/lib/pdf/pdf-store";
import { PeekPdfViewer } from "@/routes/_protected.workspaces/$workspaceId/-components/peek/peek-pdf-viewer";
import {
  usePeekStore,
  type PeekTab,
} from "@/routes/_protected.workspaces/$workspaceId/-components/peek/peek-store";

type PeekPanelProps = {
  workspaceId: string;
};

const ZOOM_STEP = 0.2;
const MIN_OFFSET = -0.8;
const MAX_OFFSET = 2;
const PINCH_ZOOM_SENSITIVITY = 0.005;

export const PeekPanel = ({ workspaceId }: PeekPanelProps) => {
  const t = useTranslations();
  const { tabs, activeFieldId } = usePeekStore(
    useShallow((s) => ({
      tabs: s.tabs,
      activeFieldId: s.activeFieldId,
    })),
  );
  const setActive = usePeekStore((s) => s.setActive);
  const closeTab = usePeekStore((s) => s.closeTab);
  const closeAll = usePeekStore((s) => s.closeAll);
  const navigate = useNavigate({
    from: "/workspaces/$workspaceId/$viewId",
  });

  // Track per-file zoom offsets (survives tab switches).
  const scaleOffsets = useRef(new Map<string, number>());

  const activeTab = tabs.find((t) => t.fieldId === activeFieldId);

  const handleZoom = useCallback(
    (direction: "in" | "out") => {
      if (!activeFieldId) {
        return;
      }
      const offsets = scaleOffsets.current;
      const current = offsets.get(activeFieldId) ?? 0;
      const delta = direction === "in" ? ZOOM_STEP : -ZOOM_STEP;
      const next = Math.round((current + delta) * 10) / 10;

      if (next < MIN_OFFSET || next > MAX_OFFSET) {
        return;
      }

      offsets.set(activeFieldId, next);
      usePdfStore.getState().updateScale({
        fileId: activeFieldId,
        scaleOffset: next,
      });
    },
    [activeFieldId],
  );

  const handlePrint = useCallback(() => {
    if (!activeFieldId) {
      return;
    }
    const store = usePdfStore.getState();
    const pdf = store.pdfs.get(activeFieldId);
    if (!pdf) {
      return;
    }

    pdf.document
      .getData()
      .then((data) => {
        const blob = new Blob([data.slice()], {
          type: PDF_MIME_TYPE,
        });
        const url = URL.createObjectURL(blob);
        const frame = document.createElement("iframe");
        frame.style.display = "none";
        frame.src = url;
        document.body.appendChild(frame);
        frame.contentWindow?.addEventListener("afterprint", () => {
          document.body.removeChild(frame);
          URL.revokeObjectURL(url);
        });
        frame.onload = () => frame.contentWindow?.print();
      })
      .catch(() => {
        /* print failure is non-critical */
      });
  }, [activeFieldId]);

  const handleOpenFullView = useCallback(async () => {
    if (!activeTab) {
      return;
    }
    // Navigate to full PDF view, then close peek
    await navigate({
      to: "pdf",
      search: {
        file: { fieldId: activeTab.fieldId },
        justification: undefined,
        entity: {
          id: activeTab.entityId,
          visible: true,
          activePropertyId: "",
        },
      },
    });
    closeAll();
  }, [activeTab, navigate, closeAll]);

  // Intercept ctrl+wheel (macOS trackpad pinch) for
  // continuous zoom. Must be non-passive to preventDefault.
  const pdfContentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = pdfContentRef.current;
    if (!el) {
      return;
    }

    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey || !activeFieldId) {
        return;
      }
      e.preventDefault();

      const offsets = scaleOffsets.current;
      const current = offsets.get(activeFieldId) ?? 0;
      const delta = -e.deltaY * PINCH_ZOOM_SENSITIVITY;
      const next =
        Math.round(
          Math.max(MIN_OFFSET, Math.min(MAX_OFFSET, current + delta)) * 100,
        ) / 100;

      if (next === current) {
        return;
      }

      offsets.set(activeFieldId, next);
      usePdfStore.getState().updateScale({
        fileId: activeFieldId,
        scaleOffset: next,
      });
    };

    el.addEventListener("wheel", onWheel, {
      passive: false,
    });
    return () => el.removeEventListener("wheel", onWheel);
  }, [activeFieldId]);

  return (
    <div className="flex h-full bg-background">
      {/* Vertical tab bar */}
      <div className="flex w-9 shrink-0 flex-col border-r bg-muted/50">
        <ScrollArea className="flex-1">
          <div className="flex flex-col">
            {tabs.map((tab) => (
              <VerticalTab
                active={tab.fieldId === activeFieldId}
                key={tab.fieldId}
                onActivate={() => setActive(tab.fieldId)}
                onClose={() => closeTab(tab.fieldId)}
                tab={tab}
              />
            ))}
          </div>
        </ScrollArea>
      </div>

      {/* PDF content */}
      <div className="flex flex-1 flex-col overflow-hidden" ref={pdfContentRef}>
        {activeTab && (
          <div className="flex h-9 shrink-0 items-center gap-1 border-b px-2">
            <span className="flex-1 truncate text-xs font-medium">
              {activeTab.label}
            </span>
            <Tooltip
              content={t("workspaces.pdf.zoomOut")}
              render={
                <Button
                  onClick={() => handleZoom("out")}
                  size="icon-xs"
                  variant="ghost"
                />
              }
            >
              <MinusIcon className="size-3.5" />
            </Tooltip>
            <Tooltip
              content={t("workspaces.pdf.zoomIn")}
              render={
                <Button
                  onClick={() => handleZoom("in")}
                  size="icon-xs"
                  variant="ghost"
                />
              }
            >
              <PlusIcon className="size-3.5" />
            </Tooltip>
            <Tooltip
              content={t("common.print")}
              render={
                <Button onClick={handlePrint} size="icon-xs" variant="ghost" />
              }
            >
              <PrinterIcon className="size-3.5" />
            </Tooltip>
            <Tooltip
              content={t("workspaces.pdf.openFullView")}
              render={
                <Button
                  onClick={handleOpenFullView}
                  size="icon-xs"
                  variant="ghost"
                />
              }
            >
              <ExternalLinkIcon className="size-3.5" />
            </Tooltip>
            <Button
              onClick={() => closeTab(activeTab.fieldId)}
              size="icon-xs"
              variant="ghost"
            >
              <XIcon className="size-3.5" />
            </Button>
          </div>
        )}
        <ScrollArea className="flex-1">
          {activeTab && (
            <Suspense>
              <PeekPdfViewer
                fieldId={activeTab.fieldId}
                key={activeTab.fieldId}
                onInitialOffset={(id, offset) => {
                  scaleOffsets.current.set(id, offset);
                }}
                workspaceId={workspaceId}
              />
            </Suspense>
          )}
        </ScrollArea>
      </div>
    </div>
  );
};

type VerticalTabProps = {
  tab: PeekTab;
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
  return (
    <Tooltip
      content={tab.label}
      render={
        <button
          className={cn(
            "group/tab relative flex h-9 w-full items-center justify-center border-b text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
            active &&
              "bg-background text-foreground before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-primary",
          )}
          onAuxClick={(e) => {
            // Middle-click to close
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
      <span className="text-[10px] leading-tight font-medium">
        {tab.label.slice(0, 3).toUpperCase()}
      </span>
    </Tooltip>
  );
};
