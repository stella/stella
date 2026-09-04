import { useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { produce } from "immer";

import { FileViewerWithAI } from "@/components/ai-suggestions/file-viewer-with-ai";
import { CreatingBBoxes } from "@/components/pdf/creating-citations";
import { PageAnonymization } from "@/components/pdf/page-anonymization";
import { PageCitation } from "@/components/pdf/page-citation";
import { StellaMark } from "@/components/stella-mark";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { detached } from "@/lib/detached";
import { fileOptions } from "@/lib/files/queries";
import { resolvePDFInvertColors } from "@/lib/pdf/pdf-color-mode";
import { usePDFStore } from "@/lib/pdf/pdf-context";
import { PDFPage } from "@/lib/pdf/pdf-page";
import { PDFViewport } from "@/lib/pdf/pdf-viewport";
import { getPDFWheelZoomScaleOffset } from "@/lib/pdf/pdf-zoom.logic";
import { entityOptions } from "@/lib/workspaces/queries/entities";
import "@/components/pdf/peek/peek-docx.css";
import { useWorkspaceStore } from "@/lib/workspaces/store";

const routeApi = getRouteApi(
  "/_protected/workspaces/$workspaceId/$viewId/document",
);

const FullscreenPdfViewer = () => {
  const workspaceId = routeApi.useParams({
    select: (p) => p.workspaceId,
  });
  const fieldId = usePDFStore((s) => s.fieldId);
  const entityId = routeApi.useSearch({ select: (s) => s.entity ?? "" });
  const pageNumber = routeApi.useSearch({ select: (s) => s.pdfPage ?? 1 });
  const pdfColorMode = routeApi.useSearch({
    select: (s) => s.pdfColorMode ?? "system",
  });
  const setPdfPageCount = useWorkspaceStore((s) => s.setPdfPageCount);
  const setPdfScaleOffset = useWorkspaceStore((s) => s.setPdfScaleOffset);
  const scaleOffset = useWorkspaceStore((s) => s.pdfViewer.scaleOffset);
  const pageCount = usePDFStore((s) => s.pages.size);

  // The page count lives in the PDF store (scoped to this document), but the
  // toolbar that displays it (PdfViewerControls) can render outside the
  // PDFProvider tree, so it reads from the workspace store instead. Push the
  // count across on change.
  useExternalSyncEffect(() => {
    setPdfPageCount(pageCount);
  }, [pageCount, setPdfPageCount]);

  const { data: file } = useSuspenseQuery(
    fileOptions({
      workspaceId,
      fieldId,
    }),
  );

  // Entity query is cached from route beforeLoad;
  // won't actually suspend.
  const { data: isImageOrigin } = useSuspenseQuery({
    ...entityOptions(workspaceId, entityId),
    select: (entity) => {
      const field = entity.fields.find((f) => f.id === fieldId);
      if (!field || field.content.type !== "file") {
        return false;
      }
      return field.content.mimeType.startsWith("image/");
    },
  });

  const navigate = useNavigate({
    from: "/workspaces/$workspaceId/$viewId/document",
  });

  const handlePageChanged = (page: number) => {
    detached(
      navigate({
        replace: true,
        search: (prev) =>
          produce(prev, (s) => {
            s.pdfPage = page;
          }),
      }),
      "pdf-viewer.navigate",
    );
  };

  const handleWheelZoom = (deltaY: number) => {
    const currentScaleOffset =
      useWorkspaceStore.getState().pdfViewer.scaleOffset;
    const nextScaleOffset = getPDFWheelZoomScaleOffset(
      currentScaleOffset,
      deltaY,
    );

    if (nextScaleOffset !== currentScaleOffset) {
      setPdfScaleOffset(nextScaleOffset);
    }
  };

  return (
    <FileViewerWithAI
      activeFile={
        entityId
          ? { entityId, fileFieldId: fieldId, fileName: file.fileName }
          : undefined
      }
      workspaceId={workspaceId}
    >
      <CreatingBBoxes />
      <PDFViewport
        buffer={file.buffer}
        className="document-preview-surface h-full"
        contentClassName="relative mt-2 space-y-2 px-2"
        fileId={fieldId}
        invertColors={resolvePDFInvertColors({
          colorMode: pdfColorMode,
          isImageOrigin,
        })}
        onPageChanged={handlePageChanged}
        onWheelZoom={handleWheelZoom}
        page={pageNumber}
        scaleOffset={scaleOffset}
        renderPage={(props) => (
          <PDFPage {...props} renderOverlay={renderPageOverlay} />
        )}
      />
    </FileViewerWithAI>
  );
};

export default FullscreenPdfViewer;

const renderPageOverlay = (pageId: string) => <PageOverlays pageId={pageId} />;

const PageOverlays = ({ pageId }: { pageId: string }) => {
  const page = usePDFStore((s) => s.pages.get(pageId));
  const showAnonymizeOverlays = useWorkspaceStore(
    (s) => s.pdfViewer.sidebar === "anonymize",
  );

  if (!page) {
    return null;
  }

  return (
    <>
      {showAnonymizeOverlays ? (
        <PageAnonymization
          pageId={pageId}
          pageIndex={page.proxy.pageNumber - 1}
          variant="fullscreen"
        />
      ) : null}
      <PageCitation
        originalHeight={page.originalHeight}
        originalWidth={page.originalWidth}
        pageId={pageId}
        pageNumber={page.proxy.pageNumber}
        scale={page.viewport.scale}
      />
    </>
  );
};

export const PDFSuspenseFallback = () => (
  <div className="flex h-full w-full items-center justify-center">
    <StellaMark className="text-muted-foreground size-8 animate-pulse" />
  </div>
);
