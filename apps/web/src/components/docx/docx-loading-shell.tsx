import type { CSSProperties } from "react";

import {
  DOCX_PAGE_HEIGHT,
  DOCX_PAGE_WIDTH,
  docxFitPageWidthCss,
  useDocxFitZoom,
} from "@/components/docx-preview-zoom";

type DocxLoadingShellProps = {
  scaleOffset?: number | undefined;
  zoom?: number | undefined;
};

/** The largest zoom the loading sheet fits the page to on its own. */
const DOCX_LOADING_MAX_AUTO_ZOOM = 0.85;

/** The scroll surface the sheet's page sits in. */
const DOCX_LOADING_SURFACE_CLASS =
  "folio-docx-preview flex min-h-0 flex-1 justify-center overflow-auto px-4 py-6";

const DocxLoadingPage = ({ style }: { style: CSSProperties }) => (
  <div
    className="shrink-0"
    style={{
      backgroundColor: "var(--document-preview-page, var(--doc-page))",
      ...style,
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
);

export const DocxLoadingShell = ({
  scaleOffset = 0,
  zoom,
}: DocxLoadingShellProps) => {
  const { containerRef, fitZoom } = useDocxFitZoom({
    scaleOffset,
    maxAutoZoom: DOCX_LOADING_MAX_AUTO_ZOOM,
  });
  const effectiveZoom = zoom ?? fitZoom;

  return (
    <div ref={containerRef} className={DOCX_LOADING_SURFACE_CLASS}>
      <DocxLoadingPage
        style={{
          width: DOCX_PAGE_WIDTH * effectiveZoom,
          height: DOCX_PAGE_HEIGHT * effectiveZoom,
        }}
      />
    </div>
  );
};

/**
 * The loading sheet as a view drawn before the app can measure draws it:
 * the same surface and page, with the page fitted by CSS to the width the
 * shell would measure, so the shell that replaces it keeps the page's box.
 */
export const DocxLoadingSheetPending = () => (
  <div className="@container flex min-h-0 flex-1 flex-col">
    <div aria-hidden="true" className={DOCX_LOADING_SURFACE_CLASS}>
      <DocxLoadingPage
        style={{
          aspectRatio: `${String(DOCX_PAGE_WIDTH)} / ${String(DOCX_PAGE_HEIGHT)}`,
          width: docxFitPageWidthCss(DOCX_LOADING_MAX_AUTO_ZOOM),
        }}
      />
    </div>
  </div>
);
