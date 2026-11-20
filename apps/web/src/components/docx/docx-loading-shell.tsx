import type { RefCallback } from "react";

import {
  DOCX_FIT_PADDING,
  DOCX_MIN_ZOOM,
  DOCX_PAGE_HEIGHT,
  DOCX_PAGE_WIDTH,
  DOCX_TEXT_AREA_WIDTH,
  useDocxFitZoom,
} from "@/components/docx-preview-zoom";

const LOADING_MAX_ZOOM = 0.85;

// The scroller's clientWidth includes px-4 on both sides, while 100cqi uses
// its content box. Match the editor's text-area fit before hydration.
const fittedPageWidth = `calc((100cqi + 8 * var(--spacing) - ${DOCX_FIT_PADDING * 2}px) * ${DOCX_PAGE_WIDTH / DOCX_TEXT_AREA_WIDTH})`;
// The measured viewer rounds zoom to hundredths before calculating the page width.
const DEFAULT_PAGE_WIDTH = `clamp(${DOCX_PAGE_WIDTH * DOCX_MIN_ZOOM}px, round(nearest, ${fittedPageWidth}, ${DOCX_PAGE_WIDTH / 100}px), ${DOCX_PAGE_WIDTH * LOADING_MAX_ZOOM}px)`;

type DocxLoadingShellProps = {
  scaleOffset?: number | undefined;
  zoom?: number | undefined;
};

const DocxLoadingPage = ({
  zoom,
  containerRef,
}: {
  zoom?: number;
  containerRef?: RefCallback<HTMLDivElement>;
}) => (
  <div
    ref={containerRef}
    className="folio-docx-preview @container flex min-h-0 flex-1 justify-center overflow-auto px-4 py-6"
  >
    <div
      className="shrink-0 self-start"
      style={{
        backgroundColor: "var(--document-preview-page, var(--doc-page))",
        aspectRatio: `${DOCX_PAGE_WIDTH} / ${DOCX_PAGE_HEIGHT}`,
        height: zoom === undefined ? undefined : DOCX_PAGE_HEIGHT * zoom,
        width: zoom === undefined ? DEFAULT_PAGE_WIDTH : DOCX_PAGE_WIDTH * zoom,
      }}
    >
      <div className="mx-auto mt-[17%] flex w-[68%] flex-col gap-3">
        <div className="bg-muted-foreground/18 h-4 w-2/5 rounded-sm" />
        <div className="bg-muted-foreground/14 h-3 w-full rounded-sm" />
        <div className="bg-muted-foreground/14 h-3 w-11/12 rounded-sm" />
        <div className="bg-muted-foreground/14 h-3 w-10/12 rounded-sm" />
        <div className="mt-5 space-y-2">
          <div className="bg-muted-foreground/10 h-3 w-full rounded-sm" />
          <div className="bg-muted-foreground/10 h-3 w-[94%] rounded-sm" />
          <div className="bg-muted-foreground/10 h-3 w-[88%] rounded-sm" />
        </div>
      </div>
    </div>
  </div>
);

const OffsetDocxLoadingPage = ({ scaleOffset }: { scaleOffset: number }) => {
  const { containerRef, fitZoom } = useDocxFitZoom({
    scaleOffset,
    maxAutoZoom: LOADING_MAX_ZOOM,
  });
  return <DocxLoadingPage containerRef={containerRef} zoom={fitZoom} />;
};

export const DocxLoadingShell = ({
  scaleOffset = 0,
  zoom,
}: DocxLoadingShellProps) => {
  if (zoom !== undefined) {
    return <DocxLoadingPage zoom={zoom} />;
  }
  if (scaleOffset !== 0) {
    return <OffsetDocxLoadingPage scaleOffset={scaleOffset} />;
  }
  return <DocxLoadingPage />;
};
