import type { CSSProperties } from "react";

import {
  DOCX_EDITOR_FIT_PAGE_WIDTH_CSS,
  DOCX_PAGE_HEIGHT,
  DOCX_PAGE_WIDTH,
} from "@/components/docx/docx-page.logic";

/**
 * The scroll surface the sheet's page sits in, as the editor's viewport is:
 * the page centred with no side padding (the fit leaves the room beside it)
 * and the viewport's top padding above it.
 */
export const DOCX_LOADING_SURFACE_CLASS =
  "folio-docx-preview flex min-h-0 flex-1 justify-center overflow-auto py-6";

/** The placeholder page, sized by its caller. */
export const DocxLoadingPage = ({ style }: { style: CSSProperties }) => (
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

/**
 * The loading sheet as a view drawn before the app can measure draws it:
 * the same surface and page, with the page fitted by CSS to the width the
 * editor's fit would give it, so the sheet that replaces it keeps the page's
 * box.
 */
export const DocxLoadingSheetPending = () => (
  <div className="@container flex min-h-0 flex-1 flex-col">
    <div aria-hidden="true" className={DOCX_LOADING_SURFACE_CLASS}>
      <DocxLoadingPage
        style={{
          aspectRatio: `${String(DOCX_PAGE_WIDTH)} / ${String(DOCX_PAGE_HEIGHT)}`,
          width: DOCX_EDITOR_FIT_PAGE_WIDTH_CSS,
        }}
      />
    </div>
  </div>
);
