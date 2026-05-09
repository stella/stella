import type { PageMargins } from "../core/layout-engine/types";
import type { HeaderFooterContent } from "../core/layout-painter/renderPage";

type EffectiveHeaderFooterMarginsInput = {
  margins: PageMargins;
  headerContent?: HeaderFooterContent | undefined;
  footerContent?: HeaderFooterContent | undefined;
  firstPageHeaderContent?: HeaderFooterContent | undefined;
  firstPageFooterContent?: HeaderFooterContent | undefined;
};

/**
 * A function that extends a `PageMargins` to clear the HF overflow computed
 * from a given set of header/footer content. Returned by
 * `computeHeaderFooterMarginExtender` and applied at every margins site:
 * the body fallback, `finalMargins`, and per-section `sectionBreak.margins`.
 *
 * Eigenpal #400 — pre-PR the extension only applied to the body fallback,
 * so a section break carrying its own `sb.margins` from `<w:sectPr>`
 * silently overrode the extension and the footer rendered on top of body
 * text.
 */
export type PageMarginsExtender = (margins: PageMargins) => PageMargins;

function headerHeight(content: HeaderFooterContent | undefined): number {
  return content ? (content.visualBottom ?? content.height) : 0;
}

function footerHeight(content: HeaderFooterContent | undefined): number {
  if (!content) {
    return 0;
  }
  return Math.max(
    (content.visualBottom ?? content.height) - (content.visualTop ?? 0),
    content.height,
  );
}

/**
 * Build a function that, applied to any `PageMargins`, extends `top`/`bottom`
 * to clear the same header/footer content the body's effective margins do.
 * Returns the identity function when no extension is needed.
 *
 * Header/footer distances are taken from the *given* margins (the source
 * paragraph's section margins), not the body's, so each section's authored
 * `w:header`/`w:footer` distances are honored.
 */
export function computeHeaderFooterMarginExtender({
  headerContent,
  footerContent,
  firstPageHeaderContent,
  firstPageFooterContent,
}: Omit<EffectiveHeaderFooterMarginsInput, "margins">): PageMarginsExtender {
  const headerContentHeight = Math.max(
    headerHeight(headerContent),
    headerHeight(firstPageHeaderContent),
  );
  const footerContentHeight = Math.max(
    footerHeight(footerContent),
    footerHeight(firstPageFooterContent),
  );

  return (margins: PageMargins): PageMargins => {
    const headerDistance = margins.header ?? 48;
    const footerDistance = margins.footer ?? 48;
    const availableHeaderSpace = margins.top - headerDistance;
    const availableFooterSpace = margins.bottom - footerDistance;

    if (
      headerContentHeight <= availableHeaderSpace &&
      footerContentHeight <= availableFooterSpace
    ) {
      return margins;
    }

    const out = { ...margins };
    if (headerContentHeight > availableHeaderSpace) {
      out.top = Math.max(margins.top, headerDistance + headerContentHeight);
    }
    if (footerContentHeight > availableFooterSpace) {
      out.bottom = Math.max(
        margins.bottom,
        footerDistance + footerContentHeight,
      );
    }
    return out;
  };
}

export function computeEffectiveHeaderFooterMargins({
  margins,
  headerContent,
  footerContent,
  firstPageHeaderContent,
  firstPageFooterContent,
}: EffectiveHeaderFooterMarginsInput): PageMargins {
  return computeHeaderFooterMarginExtender({
    headerContent,
    footerContent,
    firstPageHeaderContent,
    firstPageFooterContent,
  })(margins);
}
