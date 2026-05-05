import type { PageMargins } from "../core/layout-engine/types";
import type { HeaderFooterContent } from "../core/layout-painter/renderPage";

type EffectiveHeaderFooterMarginsInput = {
  margins: PageMargins;
  headerContent?: HeaderFooterContent | undefined;
  footerContent?: HeaderFooterContent | undefined;
  firstPageHeaderContent?: HeaderFooterContent | undefined;
  firstPageFooterContent?: HeaderFooterContent | undefined;
};

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

export function computeEffectiveHeaderFooterMargins({
  margins,
  headerContent,
  footerContent,
  firstPageHeaderContent,
  firstPageFooterContent,
}: EffectiveHeaderFooterMarginsInput): PageMargins {
  const headerDistance = margins.header ?? 48;
  const footerDistance = margins.footer ?? 48;
  const availableHeaderSpace = margins.top - headerDistance;
  const availableFooterSpace = margins.bottom - footerDistance;
  const headerContentHeight = Math.max(
    headerHeight(headerContent),
    headerHeight(firstPageHeaderContent),
  );
  const footerContentHeight = Math.max(
    footerHeight(footerContent),
    footerHeight(firstPageFooterContent),
  );

  if (
    headerContentHeight <= availableHeaderSpace &&
    footerContentHeight <= availableFooterSpace
  ) {
    return margins;
  }

  const effectiveMargins = { ...margins };
  if (headerContentHeight > availableHeaderSpace) {
    effectiveMargins.top = Math.max(
      margins.top,
      headerDistance + headerContentHeight,
    );
  }
  if (footerContentHeight > availableFooterSpace) {
    effectiveMargins.bottom = Math.max(
      margins.bottom,
      footerDistance + footerContentHeight,
    );
  }
  return effectiveMargins;
}
