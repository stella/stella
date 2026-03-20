import { useCallback } from "react";

import { useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { produce } from "immer";

import { StellaMark } from "@/components/stella-mark";
import { useTheme } from "@/components/theme-provider";
import { usePDFStore } from "@/lib/pdf/pdf-context";
import { PDFPage } from "@/lib/pdf/pdf-page";
import { PDFViewport } from "@/lib/pdf/pdf-viewport";
import { fileOptions } from "@/routes/_protected.workspaces/$workspaceId/-components/files/queries";
import { CreatingBBoxes } from "@/routes/_protected.workspaces/$workspaceId/-components/pdf/creating-citations";
import { PageAnonymisation } from "@/routes/_protected.workspaces/$workspaceId/-components/pdf/page-anonymisation";
import { PageCitation } from "@/routes/_protected.workspaces/$workspaceId/-components/pdf/page-citation";
import { entityOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import { useWorkspaceStore } from "@/routes/_protected.workspaces/$workspaceId/-store";

const routeApi = getRouteApi("/_protected/workspaces/$workspaceId/$viewId/pdf");

const FullscreenPdfViewer = () => {
  const workspaceId = routeApi.useParams({
    select: (p) => p.workspaceId,
  });
  const fileSearch = routeApi.useSearch({
    select: (s) => s.file,
  });
  const entityId = routeApi.useSearch({
    select: (s) => s.entity.id,
  });
  const setPdfPageCount = useWorkspaceStore((s) => s.setPdfPageCount);

  const { data: file } = useSuspenseQuery(
    fileOptions({
      workspaceId,
      fieldId: fileSearch.fieldId,
    }),
  );

  // Entity query is cached from route beforeLoad;
  // won't actually suspend.
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
  const invertColors = resolvedTheme === "dark" && !isImageOrigin;

  const navigate = useNavigate({
    from: "/workspaces/$workspaceId/$viewId/pdf",
  });

  const handlePageChanged = useCallback(
    (page: number) => {
      // eslint-disable-next-line typescript/no-floating-promises
      navigate({
        replace: true,
        search: (prev) =>
          produce(prev, (s) => {
            if (s.file?.fieldId) {
              s.file.pageNumber = page;
            }
          }),
      });
    },
    [navigate],
  );

  return (
    <>
      <CreatingBBoxes />
      <PDFViewport
        buffer={file.buffer}
        className="relative mt-2 h-full space-y-2 px-2"
        fileId={file.fileId}
        invertColors={invertColors}
        onPageChanged={handlePageChanged}
        onPageCountChanged={setPdfPageCount}
        page={fileSearch.pageNumber}
        scaleOffset={fileSearch.scaleOffset}
        renderPage={(props) => (
          <PDFPage {...props} renderOverlay={renderPageOverlay} />
        )}
      />
    </>
  );
};

export default FullscreenPdfViewer;

const renderPageOverlay = (pageId: string) => <PageOverlays pageId={pageId} />;

const PageOverlays = ({ pageId }: { pageId: string }) => {
  const page = usePDFStore((s) => s.pages.get(pageId));
  const fieldId = routeApi.useSearch({
    select: (s) => s.file.fieldId,
  });

  if (!page) {
    return null;
  }

  return (
    <>
      <PageAnonymisation
        fileId={fieldId}
        originalHeight={page.originalHeight}
        originalWidth={page.originalWidth}
        pageIndex={page.proxy.pageNumber - 1}
        scale={page.viewport.scale}
      />
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
