import { useEffect, useRef } from "react";
import type { CSSProperties } from "react";

import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import { useShallow } from "zustand/shallow";

import { Skeleton } from "@stella/ui/components/skeleton";
import { cn } from "@stella/ui/lib/utils";

import { useTheme } from "@/components/theme-provider";
import { EOC_CLASS_NAME, TEXT_LAYER_ATTRIBUTE } from "@/lib/pdf/consts";
import { PDF_WIDTH, usePdfStore } from "@/lib/pdf/pdf-store";
import { approximateFraction } from "@/lib/pdf/pdfjs-utils";
import { getDevicePixelRatio } from "@/lib/pdf/utils";
import { fileOptions } from "@/routes/_protected.workspaces/$workspaceId/-components/files/queries";
import { CreatingBBoxes } from "@/routes/_protected.workspaces/$workspaceId/-components/pdf/creating-citations";
import { PdfPage } from "@/routes/_protected.workspaces/$workspaceId/-components/pdf/pdf-page";
import { PdfPasswordDialog } from "@/routes/_protected.workspaces/$workspaceId/-components/pdf/pdf-password-dialog";
import { useUpdateCurrentPage } from "@/routes/_protected.workspaces/$workspaceId/-hooks/pdf/use-pdf-current-page";
import { useDelayedLoading } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-delayed-loading";
import { entityOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";

const [, roundY] = approximateFraction(getDevicePixelRatio());

const routeApi = getRouteApi("/_protected/workspaces/$workspaceId/$viewId/pdf");

const PdfViewer = () => {
  const t = useTranslations();
  const setPdf = usePdfStore((s) => s.setPdf);
  const workspaceId = routeApi.useParams({ select: (p) => p.workspaceId });
  const fileSearch = routeApi.useSearch({ select: (s) => s.file });

  const { data: file } = useSuspenseQuery(
    fileOptions({
      workspaceId,
      fieldId: fileSearch.fieldId,
    }),
  );
  useQuery({
    queryKey: ["pdfs", fileSearch.fieldId],
    queryFn: async ({ signal }) => {
      const fileBuffer = await file.arrayBuffer();

      await setPdf({
        signal,
        fileId: fileSearch.fieldId,
        fileBuffer,
        startPageNumber: fileSearch.pageNumber,
        scaleOffset: fileSearch.scaleOffset,
      });

      return null;
    },
    staleTime: 0,
    retry: false,
  });
  const pdfEntry = usePdfStore(
    useShallow((s) => s.pdfs.get(fileSearch.fieldId)),
  );
  const pageIds = pdfEntry?.pageIds;
  const attachmentLabels = pdfEntry?.attachmentLabels;
  const isXfa = pdfEntry?.isXfa;
  const scale = usePdfStore((s) => s.scale);
  // Active pages = rendered (in LRU buffer) + currently rendering.
  // Subscribed once here so individual PdfPage components don't
  // need hot store subscriptions.
  const renderedPages = usePdfStore((s) => s.renderedPages);
  const renderingPageIds = usePdfStore(
    useShallow((s) => s.renderMap.get(fileSearch.fieldId)?.renderingPageIds),
  );
  const containerRef = useRef<HTMLDivElement>(null);
  useUpdateCurrentPage({
    fileId: fileSearch.fieldId,
    pageIds,
    containerRef,
  });

  useEffect(() => {
    let prevRange: Range | null = null;
    const abortController = new AbortController();

    document.addEventListener(
      "selectionchange",
      () => {
        const selection = document.getSelection();

        const textLayers =
          containerRef.current?.querySelectorAll<HTMLDivElement>(
            `[${TEXT_LAYER_ATTRIBUTE}]`,
          );

        if (!textLayers) {
          return;
        }

        if (!selection || selection.rangeCount === 0) {
          for (const textLayer of textLayers) {
            const eoc = textLayer.querySelector<HTMLDivElement>(
              `.${EOC_CLASS_NAME}`,
            );
            if (eoc) {
              eoc.style.display = "none";
              textLayer.append(eoc);
            }
          }
          return;
        }

        const activeTextLayers = new Set();

        for (let i = 0; i < selection.rangeCount; i++) {
          const range = selection.getRangeAt(i);
          for (const textLayer of textLayers) {
            if (
              !activeTextLayers.has(textLayer) &&
              range.intersectsNode(textLayer)
            ) {
              activeTextLayers.add(textLayer);
            }
          }
        }

        for (const textLayer of textLayers) {
          const eoc = textLayer.querySelector<HTMLDivElement>(
            `.${EOC_CLASS_NAME}`,
          );

          if (!eoc) {
            continue;
          }

          if (activeTextLayers.has(textLayer)) {
            eoc.style.display = "block";
          } else {
            eoc.style.display = "none";
            textLayer.append(eoc);
          }
        }

        const range = selection.getRangeAt(0);
        const modifyStart =
          prevRange &&
          (range.compareBoundaryPoints(Range.END_TO_END, prevRange) === 0 ||
            range.compareBoundaryPoints(Range.START_TO_END, prevRange) === 0);

        let anchor: Node = modifyStart
          ? range.startContainer
          : range.endContainer;

        if (anchor.nodeType === Node.TEXT_NODE && anchor.parentNode) {
          anchor = anchor.parentNode;
        }

        if (!modifyStart && range.endOffset === 0) {
          do {
            while (!anchor.previousSibling) {
              if (!anchor.parentNode) {
                break;
              }

              anchor = anchor.parentNode;
            }

            if (!anchor.previousSibling) {
              break;
            }

            anchor = anchor.previousSibling;
          } while (!anchor.childNodes.length);
        }

        const parentTextLayer = anchor.parentElement?.closest(
          `[${TEXT_LAYER_ATTRIBUTE}]`,
        );
        const eoc = parentTextLayer?.querySelector<HTMLDivElement>(
          `.${EOC_CLASS_NAME}`,
        );

        if (eoc) {
          anchor.parentElement?.insertBefore(
            eoc,
            modifyStart ? anchor : anchor.nextSibling,
          );
        }

        prevRange = range.cloneRange();
      },
      { signal: abortController.signal },
    );

    return () => {
      abortController.abort();
    };
  }, []);

  const entityId = routeApi.useSearch({ select: (s) => s.entity.id });

  // Image-origin PDFs should never be inverted: the invert+hue-rotate
  // filter produces garbled colours on rasterized content.
  const { data: isImageOrigin } = useSuspenseQuery({
    ...entityOptions(workspaceId, entityId),
    select: (entity) => {
      const field = entity.fields.find((f) => f.id === fileSearch.fieldId);
      if (!field || field.content.type !== "file") {
        return false;
      }
      return field.content.mimeType.startsWith("image/");
    },
  });

  const { resolvedTheme } = useTheme();
  const invertPages = usePdfStore((s) => s.invertPages);

  const isLoading = useDelayedLoading({
    isLoading: !pageIds,
    timeout: 100,
  });

  return (
    <>
      <PdfPasswordDialog />
      {pageIds && <CreatingBBoxes />}
      <div
        className="relative mt-2 h-full space-y-2 px-2"
        ref={containerRef}
        style={
          {
            "--scale-factor": scale + fileSearch.scaleOffset,
            // this follows what mozilla pdf viewer does
            "--scale-round-x": `${roundY}px`,
            "--scale-round-y": `${roundY}px`,
            ...(resolvedTheme === "dark" &&
              invertPages &&
              !isImageOrigin && {
                filter: "invert(1) hue-rotate(180deg)",
              }),
          } as CSSProperties
        }
      >
        {isXfa && (
          <PdfBanner label={t("workspaces.files.xfaFormNotSupported")} />
        )}
        {pageIds?.map((pageId) => (
          <PdfPageWithBanner
            attachmentLabel={attachmentLabels?.get(pageId)}
            fileId={fileSearch.fieldId}
            isActive={
              renderedPages.has(pageId) ||
              (renderingPageIds?.includes(pageId) ?? false)
            }
            key={pageId}
            pageId={pageId}
          />
        ))}
        <PdfViewerSkeleton className={isLoading ? "block" : "hidden"} />
        {/* this div is for space-y to work */}
        <div className="h-px" />
      </div>
    </>
  );
};

export default PdfViewer;

const PdfBanner = ({ label }: { label: string }) => (
  <div
    className="bg-muted text-muted-foreground mx-auto flex items-center justify-center rounded-md px-4 py-2 text-center text-sm"
    style={{ maxWidth: PDF_WIDTH }}
  >
    {label}
  </div>
);

const PdfPageWithBanner = ({
  attachmentLabel,
  ...props
}: {
  attachmentLabel?: string | undefined;
  fileId: string;
  isActive: boolean;
  pageId: string;
}) => (
  <>
    {attachmentLabel && <PdfBanner label={attachmentLabel} />}
    <PdfPage {...props} />
  </>
);

const PdfViewerSkeleton = ({ className }: { className: string }) =>
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => (
    <Skeleton
      className={cn("mx-auto min-h-screen", className)}
      key={i}
      style={{ width: PDF_WIDTH }}
    />
  ));
