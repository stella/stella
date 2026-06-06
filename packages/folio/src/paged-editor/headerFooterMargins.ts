import type {
  PageMargins,
  SectionBreakBlock,
} from "../core/layout-engine/types";
import type { HeaderFooterContent } from "../core/layout-painter/renderPage";

/**
 * Floor on the body content area, in pixels. Header/footer overflow can
 * never shrink the content band below this, so a degenerate document
 * (a header taller than the page) still renders some body text.
 */
const MIN_CONTENT_HEIGHT_PX = 24;

type EffectiveHeaderFooterMarginsInput = {
  margins: PageMargins;
  headerContent?: HeaderFooterContent | undefined;
  footerContent?: HeaderFooterContent | undefined;
  firstPageHeaderContent?: HeaderFooterContent | undefined;
  firstPageFooterContent?: HeaderFooterContent | undefined;
  pageSize?: { w: number; h: number } | undefined;
  warn?: ((message: string) => void) | undefined;
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
  if (!content) {
    return 0;
  }
  // Prefer the margin-push bounds (excludes behindDoc images that paint
  // behind body content) so a full-page letterhead doesn't reserve itself
  // as body push-down. Fall back to visualBottom for callers that predate
  // the field.
  return content.marginPushBottom ?? content.visualBottom ?? content.height;
}

function footerHeight(content: HeaderFooterContent | undefined): number {
  if (!content) {
    return 0;
  }
  const bottom =
    content.marginPushBottom ?? content.visualBottom ?? content.height;
  const top = content.marginPushTop ?? content.visualTop ?? 0;
  return Math.max(bottom - top, content.height);
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
/**
 * Build an extender that pushes body margins clear of HF content.
 *
 * `mode === "default"` ignores `firstPageHeaderContent` /
 * `firstPageFooterContent`. The first-page H/F only renders on page 1 of
 * a `<w:titlePg/>`-enabled section, so margins for pages 2+ within the
 * same section must NOT be extended for first-page overflow — extending
 * them would push body content down on every page even though only page
 * 1 actually carries the overflowing header. This produced visible
 * regressions on NVCA-style first-page-header docs, where pages 2+
 * inherited page 1's title-page header reservation.
 *
 * `mode === "firstPage"` uses the larger of the default and first-page
 * H/F heights — applied only to the first-page margins of a titlePg
 * section.
 */
function buildExtender({
  headerContent,
  footerContent,
  firstPageHeaderContent,
  firstPageFooterContent,
  pageSize,
  warn,
  mode,
}: Omit<EffectiveHeaderFooterMarginsInput, "margins"> & {
  mode: "default" | "firstPage";
}): PageMarginsExtender {
  const headerContentHeight =
    mode === "firstPage"
      ? Math.max(
          headerHeight(headerContent),
          headerHeight(firstPageHeaderContent),
        )
      : headerHeight(headerContent);
  const footerContentHeight =
    mode === "firstPage"
      ? Math.max(
          footerHeight(footerContent),
          footerHeight(firstPageFooterContent),
        )
      : footerHeight(footerContent);

  return (margins: PageMargins): PageMargins => {
    const headerDistance = margins.header ?? 48;
    const footerDistance = margins.footer ?? 48;
    const availableHeaderSpace = margins.top - headerDistance;
    const availableFooterSpace = margins.bottom - footerDistance;

    const maxMargins = pageSize
      ? Math.max(0, pageSize.h - MIN_CONTENT_HEIGHT_PX)
      : undefined;
    const fitsContent =
      headerContentHeight <= availableHeaderSpace &&
      footerContentHeight <= availableFooterSpace;
    // Margins inherited from a taller section can already exceed a smaller
    // section's page even when nothing here needs extending, so the page
    // clamp must still run on this fast path.
    const fitsPage =
      maxMargins === undefined || margins.top + margins.bottom <= maxMargins;
    if (fitsContent && fitsPage) {
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

    if (
      pageSize &&
      maxMargins !== undefined &&
      out.top + out.bottom > maxMargins
    ) {
      if (warn) {
        warn(
          `header/footer content exceeds page height; clamping margins to preserve a content area. pageHeight=${Math.round(
            pageSize.h,
          )} top=${Math.round(out.top)} bottom=${Math.round(out.bottom)}`,
        );
      }
      out.bottom = Math.max(0, Math.min(out.bottom, maxMargins - out.top));
      if (out.top + out.bottom > maxMargins) {
        out.top = Math.max(0, maxMargins - out.bottom);
      }
    }

    return out;
  };
}

export function computeHeaderFooterMarginExtender(
  input: Omit<EffectiveHeaderFooterMarginsInput, "margins">,
): PageMarginsExtender {
  return buildExtender({ ...input, mode: "default" });
}

/**
 * Like `computeHeaderFooterMarginExtender` but also accounts for the
 * first-page header/footer content. Apply this only to the margins used
 * for page 1 of a `<w:titlePg/>`-enabled section.
 */
export function computeFirstPageHeaderFooterMarginExtender(
  input: Omit<EffectiveHeaderFooterMarginsInput, "margins">,
): PageMarginsExtender {
  return buildExtender({ ...input, mode: "firstPage" });
}

export function computeEffectiveHeaderFooterMargins({
  margins,
  headerContent,
  footerContent,
  firstPageHeaderContent,
  firstPageFooterContent,
  pageSize,
  warn,
}: EffectiveHeaderFooterMarginsInput): PageMargins {
  return computeHeaderFooterMarginExtender({
    headerContent,
    footerContent,
    firstPageHeaderContent,
    firstPageFooterContent,
    pageSize,
    warn,
  })(margins);
}

/** Rendered header/footer content shared by every extender on a page. */
export type HeaderFooterExtenderContent = Omit<
  EffectiveHeaderFooterMarginsInput,
  "margins" | "pageSize" | "warn"
>;

type ExtendSectionBreakMarginsInput = {
  content: HeaderFooterExtenderContent;
  /** Body page size and effective margins — the inheritance seed. */
  bodyPageSize: { w: number; h: number };
  bodyMargins: PageMargins;
  warn?: ((message: string) => void) | undefined;
};

/**
 * Extend every section break's margins to clear the same header/footer
 * overflow the body margins do (eigenpal #400), so an overflowing footer
 * never re-overlaps body text on a later section.
 *
 * The walk mirrors `collectSectionConfigs`: a break that omits its own
 * `pageSize` or `margins` inherits the previous section's. Each break's
 * authored-or-inherited margins are extended against the section's *own*
 * resolved page height, so a taller page never keeps a smaller page's
 * clamped reservation (and vice versa). Materializes `margins` on every
 * non-inheriting break in place.
 */
export function extendSectionBreakMargins(
  sectionBreaks: SectionBreakBlock[],
  { content, bodyPageSize, bodyMargins, warn }: ExtendSectionBreakMarginsInput,
): void {
  let pageSize = bodyPageSize;
  let margins = bodyMargins;
  for (const sb of sectionBreaks) {
    if (!sb.pageSize && !sb.margins) {
      continue;
    }
    pageSize = sb.pageSize ?? pageSize;
    margins = computeHeaderFooterMarginExtender({ ...content, pageSize, warn })(
      sb.margins ?? margins,
    );
    sb.margins = margins;
  }
}
