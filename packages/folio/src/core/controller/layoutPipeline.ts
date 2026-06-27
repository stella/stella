import type { EditorState } from "prosemirror-state";

import { buildBookmarkPageMap } from "../fields/bookmarkPages";
import { buildBookmarkText } from "../fields/bookmarkText";
import {
  buildHeaderFooterFieldValues,
  fieldValuesEqual,
  resolveFieldValues,
} from "../fields/resolveFieldValues";
import type { HeaderFooterFieldInputs } from "../fields/resolveFieldValues";
import { buildSectionPageCounts } from "../fields/sectionPageCounts";
import { buildSeqValues } from "../fields/seqValues";
import {
  FOOTNOTE_ENTRY_MARGIN_BOTTOM,
  buildFootnoteContentMap,
  collectFootnoteRefs,
} from "../layout-bridge/footnoteLayout";
import type { MeasureBlocksFn } from "../layout-bridge/footnoteLayout";
import type {
  ConvertHeaderFooterOptions,
  HeaderFooterMetrics,
} from "../layout-bridge/headerFooterLayout";
import { applyTemplatePreviewToBlocks } from "../layout-bridge/templatePreviewFlow";
import { toFlowBlocks } from "../layout-bridge/toFlowBlocks";
import type { ToFlowBlocksOptions } from "../layout-bridge/toFlowBlocks";
import { layoutDocument } from "../layout-engine";
import type { ColumnLayout, SectionLayoutConfig } from "../layout-engine";
import {
  recordLayoutComplete,
  recordLayoutError,
  recordLayoutPhase,
} from "../layout-engine/layoutInstrumentation";
import type {
  LayoutPhase,
  LayoutRunReason,
} from "../layout-engine/layoutInstrumentation";
import {
  measureBlocks,
  measureSingleBlockWithoutFloatingZones,
} from "../layout-engine/measure/measureBlocks";
import { installCanvasMeasureProvider } from "../layout-engine/measure/measureContainer";
import type {
  FlowBlock,
  FootnoteContent,
  Layout,
  Measure,
  PageHeaderFooterRefs,
  PageMargins,
  SectionBreakBlock,
} from "../layout-engine/types";
import type { BlockLookup, LayoutPainter } from "../layout-painter";
import { renderPages } from "../layout-painter/renderPage";
import type {
  FootnoteRenderItem,
  HeaderFooterContent,
  RenderPageOptions,
} from "../layout-painter/renderPage";
import {
  computeFirstPageHeaderFooterMarginExtender,
  computeHeaderFooterMarginExtender,
  extendSectionBreakMargins,
} from "../paged-layout/headerFooterMargins";
import { tryBuildIncrementalMeasures } from "../paged-layout/incrementalMeasure";
import type { DirtyRange } from "../paged-layout/incrementalMeasure";
import type { LayoutSelectionGate } from "../paged-layout/LayoutSelectionGate";
import { computePerBlockMeasureInputs } from "../paged-layout/sectionBlockWidths";
import { twipsToPixels } from "../paged-layout/sectionGeometry";
import { templatePreviewValuesKey } from "../prosemirror/plugins/templatePreviewValues";
import type { TemplatePreviewEntry } from "../prosemirror/plugins/templatePreviewValues";
import type {
  Document,
  HeaderFooter,
  SectionProperties,
  StyleDefinitions,
  Theme,
  Watermark,
} from "../types/document";
import { getDocumentWatermark } from "../watermark";
import type { LayoutSession } from "./layoutSession";

function pageMarginsEqual(left: PageMargins, right: PageMargins): boolean {
  return (
    left.top === right.top &&
    left.right === right.right &&
    left.bottom === right.bottom &&
    left.left === right.left &&
    left.header === right.header &&
    left.footer === right.footer
  );
}

function optionalPageMarginsEqual(
  left: PageMargins | undefined,
  right: PageMargins | undefined,
): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return pageMarginsEqual(left, right);
}

export type LayoutRunOptions = {
  dirtyRange?: DirtyRange;
  forceFull?: boolean;
  reason?: LayoutRunReason;
};

// Different exit paths populate different subsets; the adapter applies whatever
// is present in the original setter order.
export type LayoutOutcome = {
  blocks?: FlowBlock[];
  measures?: Measure[];
  layout?: Layout;
  blockLookup?: BlockLookup;
};

// Everything the compute reads from the React adapter's scope. The adapter
// rebuilds this on every call from current props/refs/handlers, so plain values
// (not accessors) are safe: there is no stale-closure risk. `THfPMs` keeps the
// hidden header/footer ProseMirror handle opaque to the controller — it is only
// threaded through the injected render callbacks, never inspected here.
export type LayoutPipelineDeps<THfPMs> = {
  contentWidth: number;
  columns: ColumnLayout | undefined;
  pageSize: { w: number; h: number };
  margins: PageMargins;
  pageGap: number;
  syncCoordinator: LayoutSelectionGate;
  headerContent: HeaderFooter | null | undefined;
  footerContent: HeaderFooter | null | undefined;
  firstPageHeaderContent: HeaderFooter | null | undefined;
  firstPageFooterContent: HeaderFooter | null | undefined;
  headerContentRId: string | null | undefined;
  footerContentRId: string | null | undefined;
  firstPageHeaderContentRId: string | null | undefined;
  firstPageFooterContentRId: string | null | undefined;
  sectionHeaderFooterRefs: PageHeaderFooterRefs[] | undefined;
  theme: Theme | null | undefined;
  sectionProperties: SectionProperties | null | undefined;
  document: Document | null;
  defaultTabStop: number | undefined;
  styles: StyleDefinitions | null | undefined;
  layout: Layout | null;
  // Refs read as their current value; `session` is the object itself because
  // the body reads AND writes its fields and those writes must persist.
  hfPMs: THfPMs;
  painter: LayoutPainter | null;
  pagesContainer: HTMLDivElement | null;
  session: LayoutSession;
  // Render/font helpers kept in the adapter; the controller calls them
  // opaquely.
  renderHfFromContentOrPm: (
    hf: HeaderFooter | null | undefined,
    rId: string | null | undefined,
    hfPMs: THfPMs,
    contentWidth: number,
    metrics: HeaderFooterMetrics,
    options: ConvertHeaderFooterOptions,
  ) => HeaderFooterContent | undefined;
  renderHeaderFooterContentByRId: (
    source: Map<string, HeaderFooter> | undefined,
    hfPMs: THfPMs,
    contentWidth: number,
    metrics: HeaderFooterMetrics,
    options: ConvertHeaderFooterOptions,
  ) => Map<string, HeaderFooterContent> | undefined;
  documentFontsAreLoaded: () => boolean;
  buildFootnoteRenderItems: (
    pageFootnoteMap: Map<number, number[]>,
    footnoteContentMap: Map<number, FootnoteContent>,
    doc: Document | null,
  ) => Map<number, FootnoteRenderItem[]>;
  describeInvalidHighlightMarks: (doc: EditorState["doc"]) => string;
  emptyTemplatePreviewEntries: readonly TemplatePreviewEntry[];
};

export function runLayoutPipeline<THfPMs>(
  deps: LayoutPipelineDeps<THfPMs>,
  state: EditorState,
  options: LayoutRunOptions = {},
): LayoutOutcome {
  const {
    contentWidth,
    columns,
    pageSize,
    margins,
    pageGap,
    syncCoordinator,
    headerContent,
    footerContent,
    firstPageHeaderContent,
    firstPageFooterContent,
    headerContentRId,
    footerContentRId,
    firstPageHeaderContentRId,
    firstPageFooterContentRId,
    sectionHeaderFooterRefs,
    theme: _theme,
    sectionProperties,
    document,
    defaultTabStop,
    styles,
    layout,
    hfPMs,
    painter,
    pagesContainer,
    session,
    renderHfFromContentOrPm,
    renderHeaderFooterContentByRId,
    documentFontsAreLoaded,
    buildFootnoteRenderItems,
    describeInvalidHighlightMarks,
    emptyTemplatePreviewEntries: EMPTY_TEMPLATE_PREVIEW_ENTRIES,
  } = deps;
  const outcome: LayoutOutcome = {};
  // Composition root for text measurement: install the canvas backend
  // before any layout/measure runs. Idempotent; the engine measures
  // through the pure provider seam, which throws until a backend is set.
  installCanvasMeasureProvider();
  const reason = options.reason ?? "manual";
  const recordPhaseDuration = (phase: LayoutPhase, startedAt: number): void => {
    recordLayoutPhase(reason, phase, performance.now() - startedAt);
  };

  // Capture current state sequence for this layout run
  const currentEpoch = syncCoordinator.getStateSeq();

  // Signal layout is starting
  syncCoordinator.onLayoutStart();

  try {
    // Step 1: Convert PM doc to flow blocks
    let phaseStartedAt = performance.now();
    const pageContentHeight = pageSize.h - margins.top - margins.bottom;
    const flowOpts: ToFlowBlocksOptions = {
      pageContentHeight,
    };
    if (_theme !== undefined) {
      flowOpts.theme = _theme;
    }
    // Stamp the document's `w:defaultTabStop` onto every paragraph so
    // list-marker tab-stop math (renderParagraph + measureParagraph)
    // uses the right grid. Absent settings.xml falls back to the
    // OOXML default inside `getListMarkerInlineWidth`.
    if (defaultTabStop !== undefined) {
      flowOpts.defaultTabStopTwips = defaultTabStop;
    }
    let newBlocks = toFlowBlocks(state.doc, flowOpts);
    // Template fill preview: substitute each matched {{marker}} range
    // with its typed value at the flow-block level so the pages lay out
    // (wrap, paginate) as if the value were the document text. View-only:
    // the PM doc — and with it the save path — is never modified.
    const previewState = templatePreviewValuesKey.getState(state);
    const previewEntries =
      previewState?.entries ?? EMPTY_TEMPLATE_PREVIEW_ENTRIES;
    const previewMode = previewState?.preview?.mode ?? "plain";
    if (previewEntries.length > 0) {
      newBlocks = applyTemplatePreviewToBlocks(newBlocks, {
        entries: previewEntries,
        mode: previewMode,
      });
    }
    session.lastTemplatePreview = {
      entries: previewEntries,
      mode: previewMode,
    };
    outcome.blocks = newBlocks;
    recordPhaseDuration("flow-blocks", phaseStartedAt);

    // Step 2.5: Collect footnote references from blocks
    phaseStartedAt = performance.now();
    const footnoteRefs = collectFootnoteRefs(newBlocks);
    const documentFootnotes = document?.package.footnotes;
    const hasFootnotes =
      footnoteRefs.length > 0 && documentFootnotes !== undefined;

    // Step 2.75: Prepare header/footer content for rendering (needed before layout
    // to compute effective margins when header content exceeds available space)
    const hfMetricsHeader: HeaderFooterMetrics = {
      section: "header",
      pageSize,
      margins,
    };
    const hfMetricsFooter: HeaderFooterMetrics = {
      section: "footer",
      pageSize,
      margins,
    };
    // Header/footer blocks are measured once but painted on every page with
    // a different page number. Measure with the prior render's page count
    // first, then rebuild the prepared HF content with the final page count
    // after body layout stabilizes so digit-boundary changes are reflected
    // before paint.
    const hfPageCountEstimate = layout?.pages.length ?? 1;
    const hfClock = new Date();
    const buildHfOptions = (
      pageCount: number,
      fieldInputs?: HeaderFooterFieldInputs,
    ) => {
      const hfMeasureBlocks: MeasureBlocksFn = (hfBlocks, hfWidth) =>
        measureBlocks(
          hfBlocks,
          hfWidth,
          undefined,
          undefined,
          buildHeaderFooterFieldValues(
            hfBlocks,
            pageCount,
            hfClock,
            fieldInputs,
          ),
        );
      return {
        ...(styles ? { styles } : {}),
        ...(_theme !== undefined ? { theme: _theme } : {}),
        measureBlocks: hfMeasureBlocks,
        ...(defaultTabStop !== undefined
          ? { defaultTabStopTwips: defaultTabStop }
          : {}),
      };
    };
    const hfOptions = buildHfOptions(hfPageCountEstimate);
    let headerContentForRender = renderHfFromContentOrPm(
      headerContent,
      headerContentRId,
      hfPMs,
      contentWidth,
      hfMetricsHeader,
      hfOptions,
    );
    let footerContentForRender = renderHfFromContentOrPm(
      footerContent,
      footerContentRId,
      hfPMs,
      contentWidth,
      hfMetricsFooter,
      hfOptions,
    );
    const hasTitlePg = sectionProperties?.titlePg === true;
    let firstPageHeaderForRender = hasTitlePg
      ? renderHfFromContentOrPm(
          firstPageHeaderContent,
          firstPageHeaderContentRId,
          hfPMs,
          contentWidth,
          hfMetricsHeader,
          hfOptions,
        )
      : undefined;
    let firstPageFooterForRender = hasTitlePg
      ? renderHfFromContentOrPm(
          firstPageFooterContent,
          firstPageFooterContentRId,
          hfPMs,
          contentWidth,
          hfMetricsFooter,
          hfOptions,
        )
      : undefined;
    let headerContentByRId = renderHeaderFooterContentByRId(
      document?.package.headers,
      hfPMs,
      contentWidth,
      hfMetricsHeader,
      hfOptions,
    );
    let footerContentByRId = renderHeaderFooterContentByRId(
      document?.package.footers,
      hfPMs,
      contentWidth,
      hfMetricsFooter,
      hfOptions,
    );

    // Rendered H/F content is shared across every extender; only the
    // page size (body vs. a section's own) and the mode (default vs.
    // first-page) vary.
    const hfExtenderContent = {
      headerContent: headerContentForRender,
      footerContent: footerContentForRender,
      firstPageHeaderContent: firstPageHeaderForRender,
      firstPageFooterContent: firstPageFooterForRender,
    };
    const hfWarn = (msg: string): void => {
      // eslint-disable-next-line no-console -- standalone editor package has no logger in scope
      console.warn(`[PagedEditor] ${msg}`);
    };
    // Default extender — applied to pages 2+ of every section. It
    // ignores firstPage H/F so a `<w:titlePg/>` section's
    // overflowing first-page header doesn't push body content down
    // on every subsequent page.
    const extendForHfOverflow = computeHeaderFooterMarginExtender({
      ...hfExtenderContent,
      pageSize,
      warn: hfWarn,
    });
    // First-page extender — used only for page 1 of a titlePg
    // section so the title page's larger header reservation is
    // honored without leaking onto pages 2+.
    const extendForFirstPage = computeFirstPageHeaderFooterMarginExtender({
      ...hfExtenderContent,
      pageSize,
      warn: hfWarn,
    });
    let effectiveMargins = extendForHfOverflow(margins);
    let effectiveFirstPageMargins = hasTitlePg
      ? extendForFirstPage(margins)
      : undefined;
    const sectionBreaks = newBlocks.filter(
      (block): block is SectionBreakBlock => block.kind === "sectionBreak",
    );
    const originalSectionBreakMargins = new Map<
      SectionBreakBlock["id"],
      PageMargins | undefined
    >();
    for (const sectionBreak of sectionBreaks) {
      originalSectionBreakMargins.set(
        sectionBreak.id,
        sectionBreak.margins ? { ...sectionBreak.margins } : undefined,
      );
    }
    const restoreSectionBreakMargins = (): void => {
      for (const sectionBreak of sectionBreaks) {
        const originalMargins = originalSectionBreakMargins.get(
          sectionBreak.id,
        );
        if (originalMargins === undefined) {
          delete sectionBreak.margins;
          continue;
        }
        sectionBreak.margins = { ...originalMargins };
      }
    };
    const applySectionBreakMargins = (
      content: typeof hfExtenderContent,
      bodyMargins: PageMargins,
    ): void => {
      restoreSectionBreakMargins();
      // Section-break blocks carry their own `pageSize`/`margins` from
      // `<w:sectPr>` and the layout engine prefers those over the
      // body-level fallback. Extend each against its own resolved page
      // so an overflowing footer never re-overlaps body text on the next
      // section. (Eigenpal #400.)
      extendSectionBreakMargins(sectionBreaks, {
        content,
        bodyPageSize: pageSize,
        bodyMargins,
        warn: hfWarn,
      });
    };
    applySectionBreakMargins(hfExtenderContent, effectiveMargins);
    recordPhaseDuration("header-footer", phaseStartedAt);

    // Compute per-block widths + band geometry from the EFFECTIVE margins
    // layout uses (header/footer overflow extension + section-break margin
    // extension applied above), so a page/margin-pinned topAndBottom band
    // reserves its band at the same Y the box is painted. Measuring with the
    // raw margins would mis-place the reserved band when a tall header/footer
    // extends the margins. eigenpal #694.
    phaseStartedAt = performance.now();
    let bodyLayoutConfig: SectionLayoutConfig = {
      pageSize,
      margins: effectiveMargins,
    };
    if (columns !== undefined) {
      bodyLayoutConfig.columns = columns;
    }
    let blockMeasureInputs = computePerBlockMeasureInputs({
      blocks: newBlocks,
      bodyConfig: bodyLayoutConfig,
      finalConfig: bodyLayoutConfig,
    });
    let blockWidths = blockMeasureInputs.widths;
    const previousArtifacts = session.artifacts;
    const incrementalResult =
      options.dirtyRange && !options.forceFull && previousArtifacts
        ? tryBuildIncrementalMeasures({
            previousBlocks: previousArtifacts.blocks,
            previousMeasures: previousArtifacts.measures,
            previousBlockWidths: previousArtifacts.blockWidths,
            nextBlocks: newBlocks,
            nextBlockWidths: blockWidths,
            dirtyRange: options.dirtyRange,
            measureBlock: measureSingleBlockWithoutFloatingZones,
          })
        : null;
    let newMeasures =
      incrementalResult?.measures ??
      measureBlocks(newBlocks, blockWidths, blockMeasureInputs.marginTops, {
        pageHeight: blockMeasureInputs.pageHeights,
        marginBottom: blockMeasureInputs.marginBottoms,
      });
    session.artifacts = {
      blocks: newBlocks,
      blockWidths,
      measures: newMeasures,
    };
    outcome.measures = newMeasures;
    recordPhaseDuration("measure-blocks", phaseStartedAt);

    // Step 3: Layout blocks onto pages (two-pass if footnotes exist)
    phaseStartedAt = performance.now();
    let newLayout: Layout;
    let pageFootnoteMap = new Map<number, number[]>();
    let footnoteContentMap = new Map<number, FootnoteContent>();

    // Common layout options for all passes
    // SAFETY: `sectionStart` may be `"nextColumn"`, which the layout engine's
    // `bodyBreakType` does not model; the adapter narrows it away and passes the
    // value through unchanged at runtime. Preserved verbatim from the adapter.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const bodyBreakType = sectionProperties?.sectionStart as
      | "continuous"
      | "nextPage"
      | "evenPage"
      | "oddPage"
      | undefined;
    const buildLayoutOpts = (
      nextMargins: PageMargins,
      nextFirstPageMargins: PageMargins | undefined,
    ): Parameters<typeof layoutDocument>[2] => {
      const nextLayoutOpts: Parameters<typeof layoutDocument>[2] = {
        pageSize,
        margins: nextMargins,
        pageGap,
      };
      if (nextFirstPageMargins !== undefined) {
        nextLayoutOpts.firstPageMargins = nextFirstPageMargins;
      }
      if (columns !== undefined) {
        nextLayoutOpts.columns = columns;
      }
      if (bodyBreakType !== undefined) {
        nextLayoutOpts.bodyBreakType = bodyBreakType;
      }
      if (sectionHeaderFooterRefs !== undefined) {
        nextLayoutOpts.sectionHeaderFooterRefs = sectionHeaderFooterRefs;
      }
      return nextLayoutOpts;
    };
    const layoutOpts = buildLayoutOpts(
      effectiveMargins,
      effectiveFirstPageMargins,
    );
    // The exact options the layout was produced with, reused if the field-
    // width stabilization pass re-lays-out below.
    let layoutOptsUsed: Parameters<typeof layoutDocument>[2] = layoutOpts;

    if (hasFootnotes) {
      // Build footnote content and measure heights up front. The
      // per-fn height table feeds into the layout engine so each
      // body line carrying an fn ref reserves space for that fn
      // on its host page in a single pass — no convergence loop.
      footnoteContentMap = buildFootnoteContentMap(
        documentFootnotes,
        footnoteRefs,
        contentWidth,
        (() => {
          const footnoteOptions: Parameters<typeof buildFootnoteContentMap>[3] =
            { measureBlocks };
          if (styles) {
            footnoteOptions.styles = styles;
          }
          if (_theme !== undefined) {
            footnoteOptions.theme = _theme;
          }
          if (defaultTabStop !== undefined) {
            footnoteOptions.defaultTabStopTwips = defaultTabStop;
          }
          return footnoteOptions;
        })(),
      );

      const footnoteHeightById = new Map<number, number>();
      // Any per-fn wrapper margin applied by the painter is reserved
      // alongside content height. The value is zero for Word-like footnote
      // spacing; source paragraph spacing inside each note carries the
      // visible gaps.
      for (const [id, content] of footnoteContentMap) {
        footnoteHeightById.set(
          id,
          content.height + FOOTNOTE_ENTRY_MARGIN_BOTTOM,
        );
      }
      // Note: the layout engine adds the divider's height once per
      // fn-bearing page (in paginator.addFootnoteHeight); we pass per-fn
      // content plus any wrapper margin here.

      layoutOptsUsed = { ...layoutOpts, footnoteHeightById };
      newLayout = layoutDocument(newBlocks, newMeasures, layoutOptsUsed);

      // The layout engine assigned `page.footnoteIds` line-by-
      // line via `paginator.addFootnoteHeight(_, ids)`, so a fn
      // ref in a continuation fragment of a split paragraph
      // lands on the page where the ref-bearing line actually
      // is. Build pageFootnoteMap from those page records (not
      // from `mapFootnotesToPages`'s pmRange scan, which can't
      // disambiguate split-paragraph halves; Codex PR #258).
      pageFootnoteMap = new Map<number, number[]>();
      for (const page of newLayout.pages) {
        if (page.footnoteIds && page.footnoteIds.length > 0) {
          pageFootnoteMap.set(page.number, page.footnoteIds);
        }
      }
    } else {
      // No footnotes — single pass
      newLayout = layoutDocument(newBlocks, newMeasures, layoutOpts);
    }

    const rebuildFootnotePageMap = (): void => {
      pageFootnoteMap = new Map<number, number[]>();
      for (const page of newLayout.pages) {
        if (page.footnoteIds && page.footnoteIds.length > 0) {
          pageFootnoteMap.set(page.number, page.footnoteIds);
        }
      }
    };

    const withFootnoteHeights = (
      nextLayoutOpts: Parameters<typeof layoutDocument>[2],
    ): Parameters<typeof layoutDocument>[2] => {
      if (!hasFootnotes) {
        return nextLayoutOpts;
      }
      const footnoteHeightById = new Map<number, number>();
      for (const [id, content] of footnoteContentMap) {
        footnoteHeightById.set(
          id,
          content.height + FOOTNOTE_ENTRY_MARGIN_BOTTOM,
        );
      }
      return { ...nextLayoutOpts, footnoteHeightById };
    };

    const relayoutWithCurrentMeasures = (
      nextLayoutOpts: Parameters<typeof layoutDocument>[2],
    ): void => {
      layoutOptsUsed = withFootnoteHeights(nextLayoutOpts);
      newLayout = layoutDocument(newBlocks, newMeasures, layoutOptsUsed);
      if (hasFootnotes) {
        rebuildFootnotePageMap();
      }
    };

    const stabilizeFieldWidths = (): void => {
      if (incrementalResult) {
        return;
      }
      const MAX_FIELD_STABILIZATION_PASSES = 3;
      const fieldClock = new Date();
      let previousFieldValues: Map<number, string> | null = null;
      for (let pass = 0; pass < MAX_FIELD_STABILIZATION_PASSES; pass++) {
        const seqValues = buildSeqValues(newBlocks);
        const bookmarkTextInputs =
          previousFieldValues === null
            ? { seqValues }
            : { fieldValues: previousFieldValues, seqValues };
        const { values, changed } = resolveFieldValues(
          newBlocks,
          newLayout.pages,
          {
            totalPages: newLayout.pages.length,
            bookmarkPages: buildBookmarkPageMap(newLayout.pages, newBlocks),
            bookmarkText: buildBookmarkText(newBlocks, bookmarkTextInputs),
            seqValues,
            sectionPageCounts: buildSectionPageCounts(newLayout.pages),
            now: fieldClock,
          },
        );
        const settled =
          previousFieldValues === null
            ? !changed
            : fieldValuesEqual(previousFieldValues, values);
        if (settled) {
          stabilizedFieldValues = values;
          break;
        }
        previousFieldValues = values;
        stabilizedFieldValues = values;
        newMeasures = measureBlocks(
          newBlocks,
          blockWidths,
          blockMeasureInputs.marginTops,
          {
            pageHeight: blockMeasureInputs.pageHeights,
            marginBottom: blockMeasureInputs.marginBottoms,
          },
          values,
        );
        relayoutWithCurrentMeasures(layoutOptsUsed);
        session.artifacts = {
          blocks: newBlocks,
          blockWidths,
          measures: newMeasures,
        };
        outcome.measures = newMeasures;
      }
    };

    // Field-width stabilization: fields were measured at their cached
    // fallback text. Resolve them against this layout and, if a value's
    // width differs, re-measure and re-lay-out so wrapping matches what the
    // painter draws. PAGE/NUMPAGES depend on the layout they help produce,
    // so a re-layout can shift pages and change values again — iterate to a
    // fixed point with a small cap. Gated on a real change, so field-free
    // documents and most edits do zero passes; skipped on the incremental
    // (typing) path to keep keystrokes cheap.
    let stabilizedFieldValues: Map<number, string> | undefined;
    stabilizeFieldWidths();

    const rebuildHeaderFooterForLayout = (): typeof hfExtenderContent => {
      const seqValues = buildSeqValues(newBlocks);
      const bookmarkTextInputs =
        stabilizedFieldValues === undefined
          ? { seqValues }
          : { fieldValues: stabilizedFieldValues, seqValues };
      const finalHfFieldInputs: HeaderFooterFieldInputs = {
        bookmarkPages: buildBookmarkPageMap(newLayout.pages, newBlocks),
        bookmarkText: buildBookmarkText(newBlocks, bookmarkTextInputs),
        seqValues,
        sectionPageCounts: buildSectionPageCounts(newLayout.pages),
      };
      const finalHfOptions = buildHfOptions(
        newLayout.pages.length,
        finalHfFieldInputs,
      );
      headerContentForRender = renderHfFromContentOrPm(
        headerContent,
        headerContentRId,
        hfPMs,
        contentWidth,
        hfMetricsHeader,
        finalHfOptions,
      );
      footerContentForRender = renderHfFromContentOrPm(
        footerContent,
        footerContentRId,
        hfPMs,
        contentWidth,
        hfMetricsFooter,
        finalHfOptions,
      );
      firstPageHeaderForRender = hasTitlePg
        ? renderHfFromContentOrPm(
            firstPageHeaderContent,
            firstPageHeaderContentRId,
            hfPMs,
            contentWidth,
            hfMetricsHeader,
            finalHfOptions,
          )
        : undefined;
      firstPageFooterForRender = hasTitlePg
        ? renderHfFromContentOrPm(
            firstPageFooterContent,
            firstPageFooterContentRId,
            hfPMs,
            contentWidth,
            hfMetricsFooter,
            finalHfOptions,
          )
        : undefined;
      headerContentByRId = renderHeaderFooterContentByRId(
        document?.package.headers,
        hfPMs,
        contentWidth,
        hfMetricsHeader,
        finalHfOptions,
      );
      footerContentByRId = renderHeaderFooterContentByRId(
        document?.package.footers,
        hfPMs,
        contentWidth,
        hfMetricsFooter,
        finalHfOptions,
      );
      return {
        headerContent: headerContentForRender,
        footerContent: footerContentForRender,
        firstPageHeaderContent: firstPageHeaderForRender,
        firstPageFooterContent: firstPageFooterForRender,
      };
    };

    const MAX_HEADER_FOOTER_STABILIZATION_PASSES = 3;
    for (let pass = 0; pass < MAX_HEADER_FOOTER_STABILIZATION_PASSES; pass++) {
      const finalHfExtenderContent = rebuildHeaderFooterForLayout();
      const finalEffectiveMargins = computeHeaderFooterMarginExtender({
        ...finalHfExtenderContent,
        pageSize,
        warn: hfWarn,
      })(margins);
      const finalEffectiveFirstPageMargins = hasTitlePg
        ? computeFirstPageHeaderFooterMarginExtender({
            ...finalHfExtenderContent,
            pageSize,
            warn: hfWarn,
          })(margins)
        : undefined;

      if (
        !pageMarginsEqual(effectiveMargins, finalEffectiveMargins) ||
        !optionalPageMarginsEqual(
          effectiveFirstPageMargins,
          finalEffectiveFirstPageMargins,
        )
      ) {
        effectiveMargins = finalEffectiveMargins;
        effectiveFirstPageMargins = finalEffectiveFirstPageMargins;
        applySectionBreakMargins(finalHfExtenderContent, effectiveMargins);
        bodyLayoutConfig = { pageSize, margins: effectiveMargins };
        if (columns !== undefined) {
          bodyLayoutConfig.columns = columns;
        }
        blockMeasureInputs = computePerBlockMeasureInputs({
          blocks: newBlocks,
          bodyConfig: bodyLayoutConfig,
          finalConfig: bodyLayoutConfig,
        });
        blockWidths = blockMeasureInputs.widths;
        newMeasures = measureBlocks(
          newBlocks,
          blockWidths,
          blockMeasureInputs.marginTops,
          {
            pageHeight: blockMeasureInputs.pageHeights,
            marginBottom: blockMeasureInputs.marginBottoms,
          },
        );
        session.artifacts = {
          blocks: newBlocks,
          blockWidths,
          measures: newMeasures,
        };
        outcome.measures = newMeasures;
        relayoutWithCurrentMeasures(
          buildLayoutOpts(effectiveMargins, effectiveFirstPageMargins),
        );
        stabilizeFieldWidths();
        continue;
      }
      break;
    }

    outcome.layout = newLayout;
    session.lastEditorState = state;
    session.lastPmDoc = state.doc;
    session.usedLoadedFonts = documentFontsAreLoaded();
    recordLayoutComplete(reason);
    recordPhaseDuration("layout-document", phaseStartedAt);

    // Step 4: Paint to DOM
    if (pagesContainer && painter) {
      phaseStartedAt = performance.now();
      // Build block lookup
      const blockLookup: BlockLookup = new Map();
      for (let i = 0; i < newBlocks.length; i++) {
        const block = newBlocks[i];
        const measure = newMeasures[i];
        if (block && measure) {
          blockLookup.set(String(block.id), { block, measure });
        }
      }
      outcome.blockLookup = blockLookup;

      // Build per-page footnote render items
      const footnotesByPage = hasFootnotes
        ? buildFootnoteRenderItems(
            pageFootnoteMap,
            footnoteContentMap,
            document,
          )
        : undefined;

      // Render pages to container.
      // Built incrementally so optional fields are only present when
      // defined (RenderPageOptions has `exactOptionalPropertyTypes`).
      const renderOpts: RenderPageOptions & {
        pageGap?: number;
        footnotesByPage?: Map<number, FootnoteRenderItem[]>;
      } = {
        pageGap,
        showShadow: true,
        blockLookup,
        titlePg: hasTitlePg,
      };
      if (headerContentForRender) {
        renderOpts.headerContent = headerContentForRender;
      }
      if (footerContentForRender) {
        renderOpts.footerContent = footerContentForRender;
      }
      if (firstPageHeaderForRender) {
        renderOpts.firstPageHeaderContent = firstPageHeaderForRender;
      }
      if (firstPageFooterForRender) {
        renderOpts.firstPageFooterContent = firstPageFooterForRender;
      }
      if (headerContentByRId) {
        renderOpts.headerContentByRId = headerContentByRId;
      }
      if (footerContentByRId) {
        renderOpts.footerContentByRId = footerContentByRId;
      }
      if (
        sectionHeaderFooterRefs === undefined &&
        sectionProperties?.headerDistance !== undefined &&
        sectionProperties.headerDistance !== 0
      ) {
        renderOpts.headerDistance = twipsToPixels(
          sectionProperties.headerDistance,
        );
      }
      if (
        sectionHeaderFooterRefs === undefined &&
        sectionProperties?.footerDistance !== undefined &&
        sectionProperties.footerDistance !== 0
      ) {
        renderOpts.footerDistance = twipsToPixels(
          sectionProperties.footerDistance,
        );
      }
      if (sectionProperties?.pageBorders) {
        renderOpts.pageBorders = sectionProperties.pageBorders;
      }
      if (_theme) {
        renderOpts.theme = _theme;
      }
      if (footnotesByPage !== undefined && footnotesByPage.size > 0) {
        renderOpts.footnotesByPage = footnotesByPage;
      }
      // Map bookmarks to the pages they land on so PAGEREF fields resolve
      // to live page numbers at paint.
      const bookmarkPages = buildBookmarkPageMap(newLayout.pages, newBlocks);
      if (bookmarkPages.size > 0) {
        renderOpts.bookmarkPages = bookmarkPages;
      }
      // Assign SEQ caption numbers in document order so SEQ fields resolve.
      const seqValues = buildSeqValues(newBlocks);
      if (seqValues.size > 0) {
        renderOpts.seqValues = seqValues;
      }
      // Bookmark text for REF cross-references.
      const bookmarkTextInputs =
        stabilizedFieldValues === undefined
          ? { seqValues }
          : { fieldValues: stabilizedFieldValues, seqValues };
      const bookmarkText = buildBookmarkText(newBlocks, bookmarkTextInputs);
      if (bookmarkText.size > 0) {
        renderOpts.bookmarkText = bookmarkText;
      }
      // Per-section page counts so SECTIONPAGES fields resolve.
      renderOpts.sectionPageCounts = buildSectionPageCounts(newLayout.pages);
      // Document watermark (rendered behind every page). Build a
      // per-header-rId map so titlePg / even-odd / per-section
      // header parts each paint their own watermark; the painter
      // falls back to `renderOpts.watermark` for documents that
      // share one header. Picture watermarks need an image-rId →
      // asset URL resolver that currently lives outside the
      // editor; until that's wired in, the painter silently skips
      // them.
      if (document) {
        const watermark = getDocumentWatermark(document);
        if (watermark) {
          renderOpts.watermark = watermark;
        }
        const headers = document.package.headers;
        if (headers) {
          const watermarkByHeaderRId = new Map<string, Watermark>();
          for (const [rId, header] of headers) {
            if (header.watermark) {
              watermarkByHeaderRId.set(rId, header.watermark);
            }
          }
          if (watermarkByHeaderRId.size > 0) {
            renderOpts.watermarkByHeaderRId = watermarkByHeaderRId;
          }
        }
      }
      renderPages(newLayout.pages, pagesContainer, renderOpts);
      recordPhaseDuration("render-pages", phaseStartedAt);
    }
  } catch (error) {
    const invalidHighlights = describeInvalidHighlightMarks(state.doc);
    recordLayoutError(
      reason,
      invalidHighlights
        ? new Error(`${String(error)} Invalid highlights: ${invalidHighlights}`)
        : error,
    );
    // Keep the previous visible layout if measurement or painting fails.
  }

  // Signal layout is complete for this sequence
  syncCoordinator.onLayoutComplete(currentEpoch);

  return outcome;
}
