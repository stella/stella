import { useRef, type CSSProperties } from "react";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useShallow } from "zustand/shallow";

import { Skeleton } from "@stella/ui/components/skeleton";

import { useTheme } from "@/components/theme-provider";
import { PDF_WIDTH, usePdfStore } from "@/lib/pdf/pdf-store";
import { approximateFraction } from "@/lib/pdf/pdfjs-utils";
import { getDevicePixelRatio } from "@/lib/pdf/utils";
import { fileOptions } from "@/routes/_protected.workspaces/$workspaceId/-components/files/queries";
import { PdfPage } from "@/routes/_protected.workspaces/$workspaceId/-components/pdf/pdf-page";
import { useDelayedLoading } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-delayed-loading";

const [, roundY] = approximateFraction(getDevicePixelRatio());

type PeekPdfViewerProps = {
  workspaceId: string;
  fieldId: string;
  onInitialOffset?: (fieldId: string, offset: number) => void;
};

// Horizontal padding of the PDF container (px-2 = 8px * 2).
const CONTAINER_PADDING = 16;

export const PeekPdfViewer = ({
  workspaceId,
  fieldId,
  onInitialOffset,
}: PeekPdfViewerProps) => {
  const setPdf = usePdfStore((s) => s.setPdf);
  const updateScale = usePdfStore((s) => s.updateScale);

  const { data: file } = useSuspenseQuery(
    fileOptions({ workspaceId, fieldId }),
  );

  const containerRef = useRef<HTMLDivElement>(null);

  useQuery({
    queryKey: ["pdfs", fieldId],
    queryFn: async ({ signal }) => {
      const fileBuffer = await file.arrayBuffer();

      await setPdf({
        signal,
        fileId: fieldId,
        fileBuffer,
        startPageNumber: 1,
        scaleOffset: 0,
      });

      // Fit-to-width: measure the container and adjust
      // the scale so the PDF fills the available width.
      const containerWidth = containerRef.current?.clientWidth ?? PDF_WIDTH;
      const available = containerWidth - CONTAINER_PADDING;
      const store = usePdfStore.getState();
      const filePages = store.pages.get(fieldId);

      if (filePages && available < PDF_WIDTH) {
        const first = filePages.values().next();
        if (!first.done) {
          const { originalWidth } = first.value;
          const baseScale = PDF_WIDTH / originalWidth;
          const fitScale = available / originalWidth;
          const offset = Math.round((fitScale - baseScale) * 1000) / 1000;

          updateScale({
            fileId: fieldId,
            scaleOffset: offset,
          });
          onInitialOffset?.(fieldId, offset);
        }
      }

      return null;
    },
    staleTime: 0,
    retry: false,
  });

  const pageIds = usePdfStore(useShallow((s) => s.pdfs.get(fieldId)?.pageIds));
  // Read the effective scale from this file's first page
  // viewport rather than the global `s.scale`. The global
  // value is only the *base* scale from the last `setPdf`
  // call; `updateScale` changes per-page viewports without
  // touching it, so using it here would desync the CSS
  // `--scale-factor` from the actual canvas render scale.
  const scale = usePdfStore((s) => {
    const filePages = s.pages.get(fieldId);
    if (!filePages) {
      return s.scale;
    }
    const first = filePages.values().next();
    if (first.done) {
      return s.scale;
    }
    return first.value.viewport.scale;
  });
  const renderedPages = usePdfStore((s) => s.renderedPages);
  const renderingPageIds = usePdfStore(
    useShallow((s) => s.renderMap.get(fieldId)?.renderingPageIds),
  );

  const { resolvedTheme } = useTheme();
  const invertPages = usePdfStore((s) => s.invertPages);

  const isLoading = useDelayedLoading({
    isLoading: !pageIds,
    timeout: 100,
  });

  return (
    <div
      className="relative mt-2 h-full space-y-2 px-2"
      ref={containerRef}
      style={
        {
          "--scale-factor": scale,
          "--scale-round-x": `${roundY}px`,
          "--scale-round-y": `${roundY}px`,
          ...(resolvedTheme === "dark" &&
            invertPages && {
              filter: "invert(1) hue-rotate(180deg)",
            }),
        } as CSSProperties
      }
    >
      {pageIds?.map((pageId) => (
        <PdfPage
          fileId={fieldId}
          isActive={
            renderedPages.has(pageId) ||
            (renderingPageIds?.includes(pageId) ?? false)
          }
          key={pageId}
          pageId={pageId}
        />
      ))}
      {isLoading &&
        Array.from({ length: 3 }, (_, i) => (
          <Skeleton
            className="mx-auto min-h-screen"
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder skeletons with fixed count
            key={i}
            style={{ width: PDF_WIDTH }}
          />
        ))}
      <div className="h-px" />
    </div>
  );
};
