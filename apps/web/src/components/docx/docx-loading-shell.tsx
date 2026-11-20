import { useDocxFitZoom } from "@/components/docx-preview-zoom";
import {
  DOCX_LOADING_SURFACE_CLASS,
  DocxLoadingPage,
} from "@/components/docx/docx-loading-sheet.pending";
import {
  DOCX_PAGE_HEIGHT,
  DOCX_PAGE_WIDTH,
} from "@/components/docx/docx-page.logic";

type DocxLoadingShellProps = {
  scaleOffset?: number | undefined;
  zoom?: number | undefined;
};

/** The loading sheet, its page fitted by the editor's rule to the box it measures. */
export const DocxLoadingShell = ({
  scaleOffset = 0,
  zoom,
}: DocxLoadingShellProps) => {
  const { containerRef, fitZoom } = useDocxFitZoom({
    fit: { type: "editor" },
    scaleOffset,
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
