import { useDocxFitZoom } from "@/components/docx-preview-zoom";

export const DOCX_DOCUMENT_SHELL_WIDTH = "min(72vw, 52rem)";

const DOCX_PAGE_WIDTH = 816;
const DOCX_PAGE_HEIGHT = 1056;

type DocxLoadingShellProps = {
  scaleOffset?: number | undefined;
  zoom?: number | undefined;
};

export const DocxLoadingShell = ({
  scaleOffset = 0,
  zoom,
}: DocxLoadingShellProps) => {
  const { containerRef, fitZoom } = useDocxFitZoom(scaleOffset, 0.85);
  const effectiveZoom = zoom ?? fitZoom;
  const pageWidth = DOCX_PAGE_WIDTH * effectiveZoom;
  const pageHeight = DOCX_PAGE_HEIGHT * effectiveZoom;

  return (
    <div
      ref={containerRef}
      className="folio-docx-preview flex min-h-0 flex-1 justify-center overflow-auto px-4 py-6"
    >
      <div
        className="shrink-0"
        style={{
          backgroundColor: "var(--document-preview-page, var(--doc-page))",
          width: pageWidth,
          height: pageHeight,
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
};
