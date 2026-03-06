import { useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { produce } from "immer";
import {
  ArrowBigLeftDashIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  PanelRightIcon,
  SunMoonIcon,
  XIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "lucide-react";
import { useDebouncedCallback } from "use-debounce";
import { useTranslations } from "use-intl";
import { useShallow } from "zustand/react/shallow";

import { Button } from "@stella/ui/components/button";
import { Separator } from "@stella/ui/components/separator";

import { useTheme } from "@/components/theme-provider";
import Tooltip from "@/components/tooltip";
import { usePdfStore } from "@/lib/pdf/pdf-store";
import { captureScrollPosition } from "@/lib/pdf/utils";
import { useWorkspaceStore } from "@/routes/_protected.workspaces/$workspaceId/-store";

const SCALE_OFFSET_STEP = 0.2;

const getScrollViewport = () =>
  document.querySelector<HTMLElement>(
    '#pdf-viewer-container [data-slot="scroll-area-viewport"]',
  );

export const PdfViewerControls = () => {
  const t = useTranslations();
  const {
    fieldId,
    scaleOffset,
    pageNumber: currentPage,
  } = useSearch({
    from: "/_protected/workspaces/$workspaceId/pdf",
    select: (s) => s.file,
  });

  const entityId = useSearch({
    from: "/_protected/workspaces/$workspaceId/pdf",
    select: (s) => s.entity.id,
  });

  // Detect if the current file was converted from an image.
  // Inverting colors on image-origin PDFs always produces wrong
  // results, so we hide the dark-mode toggle for them.
  const isImageOrigin = useWorkspaceStore((s) => {
    const entity = s.data.find((e) => e.entityId === entityId);
    if (!entity) {
      return false;
    }
    const field = entity.fields[fieldId];
    if (!field || field.content.type !== "file") {
      return false;
    }
    return field.content.mimeType.startsWith("image/");
  });

  const { resolvedTheme } = useTheme();
  const pageIds = usePdfStore(useShallow((s) => s.pdfs.get(fieldId)?.pageIds));
  const invertPages = usePdfStore((s) => s.invertPages);
  const toggleInvertPages = usePdfStore((s) => s.toggleInvertPages);
  const [editingPage, setEditingPage] = useState<number | null>(null);
  const pageInputValue = editingPage ?? currentPage;
  const setScrollTo = usePdfStore((s) => s.setScrollTo);
  const updateScale = usePdfStore((s) => s.updateScale);
  const navigate = useNavigate({
    from: "/workspaces/$workspaceId/pdf",
  });

  const totalPages = pageIds?.length ?? 0;

  const updatePdfScale = useDebouncedCallback((offset: number) => {
    updateScale({
      fileId: fieldId,
      scaleOffset: Math.round(offset * 10) / 10,
      currentPageNumber: currentPage,
    });
  }, 100);

  return (
    <div className="ml-auto flex items-center justify-between">
      <Tooltip
        content={t("workspaces.pdf.goBack")}
        render={
          <Button
            onClick={() =>
              navigate({
                to: "/workspaces/$workspaceId",
              })
            }
            size="icon"
            variant="ghost"
          />
        }
      >
        <ArrowBigLeftDashIcon />
      </Tooltip>
      <Separator className="mx-1 h-4" orientation="vertical" />
      <Tooltip
        content={t("workspaces.pdf.zoomOut")}
        render={
          <Button
            disabled={scaleOffset <= -0.8}
            onClick={async () => {
              const viewport = getScrollViewport();
              const restoreScroll = viewport
                ? captureScrollPosition(viewport)
                : null;

              await navigate({
                replace: true,
                search: (prev) =>
                  produce(prev, (s) => {
                    if (!s.file) {
                      return;
                    }

                    s.file.scaleOffset =
                      Math.round(
                        (s.file.scaleOffset - SCALE_OFFSET_STEP) * 10,
                      ) / 10;
                  }),
              });

              restoreScroll?.();
              updatePdfScale(scaleOffset - SCALE_OFFSET_STEP);
            }}
            size="icon"
            variant="ghost"
          />
        }
      >
        <ZoomOutIcon />
      </Tooltip>
      <Tooltip
        content={t("workspaces.pdf.zoomIn")}
        render={
          <Button
            disabled={scaleOffset >= 2}
            onClick={async () => {
              const viewport = getScrollViewport();
              const restoreScroll = viewport
                ? captureScrollPosition(viewport)
                : null;

              await navigate({
                replace: true,
                search: (prev) =>
                  produce(prev, (s) => {
                    if (!s.file) {
                      return;
                    }

                    s.file.scaleOffset =
                      Math.round(
                        (s.file.scaleOffset + SCALE_OFFSET_STEP) * 10,
                      ) / 10;
                  }),
              });

              restoreScroll?.();
              updatePdfScale(scaleOffset + SCALE_OFFSET_STEP);
            }}
            size="icon"
            variant="ghost"
          />
        }
      >
        <ZoomInIcon />
      </Tooltip>
      <Tooltip
        content={t("workspaces.pdf.resetZoom")}
        render={
          <Button
            disabled={scaleOffset === 0}
            onClick={async () => {
              const viewport = getScrollViewport();
              const restoreScroll = viewport
                ? captureScrollPosition(viewport)
                : null;

              await navigate({
                replace: true,
                search: (prev) =>
                  produce(prev, (s) => {
                    if (!s.file) {
                      return;
                    }

                    s.file.scaleOffset = 0;
                  }),
              });

              restoreScroll?.();
              updatePdfScale(0);
            }}
            size="icon"
            variant="ghost"
          />
        }
      >
        <XIcon />
      </Tooltip>
      <Separator className="mx-1 h-4" orientation="vertical" />
      <Tooltip
        content={t("workspaces.pdf.previousPage")}
        render={
          <Button
            disabled={currentPage <= 1}
            onClick={() => {
              setEditingPage(null);
              setScrollTo(fieldId, {
                pageNumber: currentPage - 1,
              });
            }}
            size="icon"
            variant="ghost"
          />
        }
      >
        <ChevronUpIcon />
      </Tooltip>
      <Tooltip
        content={t("workspaces.pdf.nextPage")}
        render={
          <Button
            disabled={currentPage >= totalPages}
            onClick={() => {
              setEditingPage(null);
              setScrollTo(fieldId, {
                pageNumber: currentPage + 1,
              });
            }}
            size="icon"
            variant="ghost"
          />
        }
      >
        <ChevronDownIcon />
      </Tooltip>
      <div className="mr-2 ml-1.5 flex gap-x-1.5 text-sm">
        <input
          aria-label={t("common.currentPage")}
          autoComplete="off"
          className="mr-1 w-14 rounded border px-1 text-end"
          inputMode="numeric"
          onBlur={() => {
            if (
              editingPage !== null &&
              editingPage >= 1 &&
              editingPage <= totalPages
            ) {
              setScrollTo(fieldId, {
                pageNumber: editingPage,
              });
            }
            setEditingPage(null);
          }}
          onChange={(e) => {
            const value = +e.target.value;

            if (Number.isNaN(value)) {
              return;
            }

            setEditingPage(value);
          }}
          onKeyDown={(e) => {
            if (e.key !== "Enter") {
              return;
            }
            e.currentTarget.blur();
          }}
          value={pageInputValue}
        />
        <span>{"/"}</span>
        <span>{totalPages}</span>
      </div>
      {resolvedTheme === "dark" && !isImageOrigin && (
        <>
          <Separator className="mx-1 h-4" orientation="vertical" />
          <Tooltip
            content={
              invertPages
                ? t("workspaces.pdf.showOriginal")
                : t("workspaces.pdf.adjustForDarkMode")
            }
            render={
              <Button
                onClick={toggleInvertPages}
                size="icon"
                variant={invertPages ? "secondary" : "ghost"}
              />
            }
          >
            <SunMoonIcon />
          </Tooltip>
        </>
      )}
      <Separator className="mx-1 h-4" orientation="vertical" />
      <Tooltip
        content={t("workspaces.pdf.toggleSidebar")}
        render={
          <Button
            onClick={() =>
              navigate({
                replace: true,
                to: ".",
                search: (prev) =>
                  produce(prev, (s) => {
                    s.entity.visible = !s.entity.visible;
                  }),
              })
            }
            size="icon"
            variant="ghost"
          />
        }
      >
        <PanelRightIcon />
      </Tooltip>
    </div>
  );
};
