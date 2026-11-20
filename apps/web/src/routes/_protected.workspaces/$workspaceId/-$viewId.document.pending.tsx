import type { ReactNode } from "react";

import { useParams, useSearch } from "@tanstack/react-router";

import { cn } from "@stll/ui/utils";

import { DocxLoadingSheetPending } from "@/components/docx/docx-loading-sheet.pending";
import {
  PdfLoadingShell,
  PdfToolbarFace,
} from "@/components/pdf/pdf-viewer.pending";
import { usePendingCache } from "@/components/pending-cache";
import { TOOLBAR_ROW_HEIGHT } from "@/lib/consts";
import { framePendingView } from "@/routes/-pending-view.logic";
import { cachedDocumentPageSheet } from "@/routes/_protected.workspaces/$workspaceId/-components/document/document-page-pending.logic";
import type { DocumentPageSearch } from "@/routes/_protected.workspaces/$workspaceId/-components/document/document-page-pending.logic";

/**
 * The document page's frame: the surface the open file sits on, and the
 * column its toolbar row and its sheet stack in. The page draws its content
 * in it, and its loading view draws the same frame first.
 */
export const DocumentPageFrame = ({
  aside,
  children,
}: {
  /** What the page mounts beside the column (lifecycles, dialogs). */
  aside?: ReactNode;
  children: ReactNode;
}) => (
  <div className="bg-secondary relative flex h-full max-h-[calc(100dvh-3rem)] flex-1 overflow-hidden">
    {aside}
    <div className="flex h-full w-full min-w-0">
      <section className="flex h-full min-w-0 flex-1 flex-col">
        {children}
      </section>
    </div>
  </div>
);

/** The toolbar row above a PDF: the page's viewer controls sit in it. */
export const DocumentToolbarRow = ({ children }: { children: ReactNode }) => (
  <div
    className={cn(
      "bg-background/80 supports-[backdrop-filter]:bg-background/65 flex shrink-0 items-center justify-center gap-2 border-b px-4 backdrop-blur",
      TOOLBAR_ROW_HEIGHT,
    )}
  >
    {children}
  </div>
);

/** The box under the toolbar row the file's sheet fills. */
export const DOCUMENT_SHEET_SLOT_CLASS = "relative min-h-0 flex-1";

/** The sheet's column inside that box, which takes a new version's drop. */
export const DOCUMENT_DROP_ZONE_CLASS =
  "relative flex h-full w-full min-w-0 flex-col";

const selectDocumentSearch = (search: Record<string, unknown>) => {
  const read = (key: string) => {
    const value = search[key];
    return typeof value === "string" ? value : undefined;
  };
  const pdfPage = search["pdfPage"];
  return {
    entity: read("entity"),
    field: read("field"),
    pane: read("pane"),
    pdfMode: read("pdfMode"),
    pdfColorMode: read("pdfColorMode"),
    pdfPage: typeof pdfPage === "number" ? pdfPage : 1,
  } satisfies DocumentPageSearch & { pdfPage: number };
};

/**
 * The document page before it loads: its frame, and the sheet of the file
 * the URL opens as the cached entity says it is: a DOCX sheet for a Word
 * document or an office file, a PDF page under the PDF toolbar for the
 * rest. A file the cache does not hold, or a pane drawn from loaded data,
 * gets the frame alone, the one both kinds share, so no sheet appears that
 * the page would then take back.
 */
const DocumentPagePendingView = () => {
  const cache = usePendingCache();
  const workspaceId = useParams({
    strict: false,
    select: (params) => params.workspaceId,
  });
  const search = useSearch({ strict: false, select: selectDocumentSearch });
  const sheet = cachedDocumentPageSheet(cache, workspaceId, search);

  if (sheet.type === "pdf") {
    return (
      <DocumentPageFrame>
        <DocumentToolbarRow>
          <PdfToolbarFace colorMode={sheet.colorMode} page={search.pdfPage} />
        </DocumentToolbarRow>
        <div className={DOCUMENT_SHEET_SLOT_CLASS}>
          <div className={DOCUMENT_DROP_ZONE_CLASS}>
            <PdfLoadingShell />
          </div>
        </div>
      </DocumentPageFrame>
    );
  }
  return (
    <DocumentPageFrame>
      <div className={DOCUMENT_SHEET_SLOT_CLASS}>
        {sheet.type === "unknown" ? null : (
          <div className={DOCUMENT_DROP_ZONE_CLASS}>
            <DocxLoadingSheetPending />
          </div>
        )}
      </div>
    </DocumentPageFrame>
  );
};

export const DocumentPagePending = framePendingView(DocumentPagePendingView);
