/**
 * Footnote Layout Utilities
 *
 * Handles scanning for footnote references, mapping them to pages,
 * converting footnote content to measurable FlowBlocks, and computing
 * per-page footnote area heights for layout space reservation.
 */

import type {
  FlowBlock,
  Measure,
  Page,
  ParagraphBlock,
  Run,
  TableBlock,
  TableCellMeasure,
  TableMeasure,
  TableRowMeasure,
  TextRun,
  FootnoteContent,
} from "../layout-engine/types";
import { DEFAULT_TEXTBOX_MARGINS as TEXTBOX_MARGINS } from "../layout-engine/types";
import { footnoteToProseDoc } from "../prosemirror/conversion/toProseDoc";
import type { Footnote, StyleDefinitions, Theme } from "../types/document";
import { measureParagraph } from "./measuring";
import { toFlowBlocks } from "./toFlowBlocks";

/**
 * Footnote separator height in pixels: 0.5 px divider rule + symmetric
 * vertical margins. Single source of truth for the paginator's
 * reservation tick, the painter's separator margins, and the per-page
 * height returned by `calculateFootnoteReservedHeights`. Keeping all
 * three in lockstep ensures the painted area lands inside the slot the
 * paginator reserved.
 *
 * Mirrors eigenpal/docx-editor#485.
 */
export const FOOTNOTE_SEPARATOR_HEIGHT = 12;

/**
 * Per-footnote `marginBottom` painted by `renderFootnoteArea`. Shared
 * with the painter's clamp helper, the dynamic reservation in
 * `PagedEditor`, and the static `calculateFootnoteReservedHeights`
 * path so every reservation matches the painted stack.
 */
export const FOOTNOTE_ENTRY_MARGIN_BOTTOM = 4;

/**
 * Fallback footnote line height in pixels when a footnote has no
 * structured content (plain-text fallback rendered at `fontSize: 10px`
 * × `lineHeight: 1.3`). Shared with the painter so the clamp helper and
 * the painted fallback stay in lockstep.
 */
export const FOOTNOTE_FALLBACK_LINE_HEIGHT = 13;

/** Default footnote font size in points */
const FOOTNOTE_FONT_SIZE = 8;

export type MeasureBlocksFn = (
  blocks: FlowBlock[],
  contentWidth: number,
) => Measure[];

export type ConvertFootnoteOptions = {
  styles?: StyleDefinitions | null;
  theme?: Theme | null;
  measureBlocks?: MeasureBlocksFn;
  /** Document-wide `w:defaultTabStop` in twips — forwarded to toFlowBlocks. */
  defaultTabStopTwips?: number;
};

// ============================================================================
// 1. Scan FlowBlocks for footnote references
// ============================================================================

/**
 * Scan FlowBlocks for runs with footnoteRefId set.
 * Returns a list of { footnoteId, pmPos } in document order.
 *
 * Recurses into table cells and text-box content so footnote references
 * nested in tables (incl. tables-within-cells) and text boxes still reach
 * the page-assignment step. Without this walk, inline footnote markers
 * render inside the body but never get an entry in the per-page footnote
 * area.
 */
export function collectFootnoteRefs(
  blocks: FlowBlock[],
): { footnoteId: number; pmPos: number }[] {
  const refs: { footnoteId: number; pmPos: number }[] = [];

  const walk = (containerBlocks: FlowBlock[]): void => {
    for (const block of containerBlocks) {
      if (block.kind === "paragraph") {
        for (const run of block.runs) {
          if (run.kind === "text" && run.footnoteRefId !== undefined) {
            refs.push({
              footnoteId: run.footnoteRefId,
              pmPos: run.pmStart ?? 0,
            });
          }
        }
      } else if (block.kind === "table") {
        for (const row of block.rows) {
          for (const cell of row.cells) {
            walk(cell.blocks);
          }
        }
      } else if (block.kind === "textBox") {
        walk(block.content);
      }
    }
  };

  walk(blocks);
  return refs;
}

// ============================================================================
// 2. Map footnote references to pages
// ============================================================================

/**
 * After layout, determine which footnotes appear on which pages.
 * Checks each page's fragments to see if any footnoteRef PM positions fall within.
 *
 * Returns Map<pageNumber, footnoteId[]> in document order.
 */
export function mapFootnotesToPages(
  pages: Page[],
  footnoteRefs: { footnoteId: number; pmPos: number }[],
): Map<number, number[]> {
  const pageFootnotes = new Map<number, number[]>();

  if (footnoteRefs.length === 0) {
    return pageFootnotes;
  }

  // For each footnote ref, find which page it lands on
  for (const ref of footnoteRefs) {
    for (const page of pages) {
      let found = false;
      for (const fragment of page.fragments) {
        const pmStart = fragment.pmStart ?? -1;
        const pmEnd = fragment.pmEnd ?? -1;
        if (
          pmStart >= 0 &&
          pmEnd >= 0 &&
          ref.pmPos >= pmStart &&
          ref.pmPos < pmEnd
        ) {
          const existing = pageFootnotes.get(page.number) ?? [];
          // Avoid duplicates (same footnote shouldn't appear twice on same page)
          if (!existing.includes(ref.footnoteId)) {
            existing.push(ref.footnoteId);
          }
          pageFootnotes.set(page.number, existing);
          found = true;
          break;
        }
      }
      if (found) {
        break;
      }
    }
  }

  return pageFootnotes;
}

// ============================================================================
// 3. Convert footnote content to FlowBlocks + Measures
// ============================================================================

/**
 * Convert a Footnote's content paragraphs to FlowBlocks suitable for rendering.
 * Prepends the display number to the first run of the first paragraph.
 */
export function convertFootnoteToContent(
  footnote: Footnote,
  displayNumber: number,
  contentWidth: number,
  options: ConvertFootnoteOptions = {},
): FootnoteContent {
  const proseOptions: Parameters<typeof footnoteToProseDoc>[1] = {};
  if (options.styles) {
    proseOptions.styles = options.styles;
  }
  if (options.theme !== undefined) {
    proseOptions.theme = options.theme;
  }
  const pmDoc = footnoteToProseDoc(footnote.content, proseOptions);
  const flowOptions: Parameters<typeof toFlowBlocks>[1] = {};
  if (options.theme !== undefined) {
    flowOptions.theme = options.theme;
  }
  if (options.defaultTabStopTwips !== undefined) {
    flowOptions.defaultTabStopTwips = options.defaultTabStopTwips;
  }
  const blocks = applyFootnotePresentation(
    toFlowBlocks(pmDoc, flowOptions),
    displayNumber,
  );

  const measures = options.measureBlocks
    ? options.measureBlocks(blocks, contentWidth)
    : measureFootnoteBlocks(blocks, contentWidth);

  let totalHeight = 0;
  for (const measure of measures) {
    if (measure.kind === "paragraph") {
      totalHeight += measure.totalHeight;
    } else if (measure.kind === "table") {
      totalHeight += measure.totalHeight;
    } else if (measure.kind === "image" || measure.kind === "textBox") {
      totalHeight += measure.height;
    }
  }

  return {
    id: footnote.id,
    displayNumber,
    blocks,
    measures,
    height: totalHeight,
  };
}

function measureFootnoteBlocks(
  blocks: FlowBlock[],
  contentWidth: number,
): Measure[] {
  return blocks.map((block) => measureFootnoteBlock(block, contentWidth));
}

function measureFootnoteBlock(block: FlowBlock, contentWidth: number): Measure {
  switch (block.kind) {
    case "paragraph":
      return measureParagraph(block, contentWidth);

    case "table":
      return measureFootnoteTable(block, contentWidth);

    case "image":
      return {
        kind: "image",
        width: block.width,
        height: block.height,
      };

    case "textBox": {
      const margins = block.margins ?? TEXTBOX_MARGINS;
      const width = block.width;
      const innerWidth = Math.max(1, width - margins.left - margins.right);
      const innerMeasures = block.content.map((paragraph) =>
        measureParagraph(paragraph, innerWidth),
      );
      let contentHeight = 0;
      for (const measure of innerMeasures) {
        contentHeight += measure.totalHeight;
      }

      return {
        kind: "textBox",
        width,
        height: block.height ?? contentHeight + margins.top + margins.bottom,
        innerMeasures,
      };
    }

    case "pageBreak":
      return { kind: "pageBreak" };

    case "columnBreak":
      return { kind: "columnBreak" };

    case "sectionBreak":
      return { kind: "sectionBreak" };

    default: {
      const exhaustive: never = block;
      return exhaustive;
    }
  }
}

function resolveFootnoteTableWidth(
  width: number | undefined,
  widthType: string | undefined,
  contentWidth: number,
): number | undefined {
  if (!width) {
    return undefined;
  }
  if (widthType === "pct") {
    return (contentWidth * width) / 5000;
  }
  if (widthType === "dxa" || !widthType || widthType === "auto") {
    return (width / 1440) * 96;
  }
  return undefined;
}

function measureFootnoteTable(
  tableBlock: TableBlock,
  contentWidth: number,
): TableMeasure {
  let columnWidths = tableBlock.columnWidths ?? [];
  const explicitWidth = resolveFootnoteTableWidth(
    tableBlock.width,
    tableBlock.widthType,
    contentWidth,
  );

  if (columnWidths.length === 0) {
    const firstRow = tableBlock.rows.at(0);
    let colCount = 0;
    for (const cell of firstRow?.cells ?? []) {
      colCount += cell.colSpan ?? 1;
    }
    const totalWidth = explicitWidth ?? contentWidth;
    const equalWidth = totalWidth / Math.max(1, colCount);
    columnWidths = Array.from(
      { length: Math.max(1, colCount) },
      () => equalWidth,
    );
  } else if (explicitWidth) {
    const totalWidth = sumColumnWidths(columnWidths);
    if (totalWidth > 0 && Math.abs(totalWidth - explicitWidth) > 1) {
      const scale = explicitWidth / totalWidth;
      columnWidths = columnWidths.map((width) => width * scale);
    }
  }

  const rowSpanEnds: number[] = [];
  const rows: TableRowMeasure[] = tableBlock.rows.map((row, rowIndex) => {
    let columnIndex = 0;
    const cells: TableCellMeasure[] = row.cells.map((cell) => {
      while ((rowSpanEnds[columnIndex] ?? 0) > rowIndex) {
        columnIndex++;
      }

      const colSpan = cell.colSpan ?? 1;
      let cellWidth = 0;
      for (
        let offset = 0;
        offset < colSpan && columnIndex + offset < columnWidths.length;
        offset++
      ) {
        cellWidth += columnWidths[columnIndex + offset] ?? 0;
      }
      if (cellWidth === 0) {
        cellWidth = cell.width ?? 100;
      }
      columnIndex += colSpan;

      const padding = cell.padding ?? { top: 0, right: 7, bottom: 0, left: 7 };
      const innerWidth = Math.max(1, cellWidth - padding.left - padding.right);
      const blocks = measureFootnoteBlocks(cell.blocks, innerWidth);
      let height = padding.top + padding.bottom;
      for (const measure of blocks) {
        height += getMeasureHeight(measure);
      }

      const cellMeasure: TableCellMeasure = {
        blocks,
        width: cellWidth,
        height,
      };
      if (cell.colSpan !== undefined) {
        cellMeasure.colSpan = cell.colSpan;
      }
      if (cell.rowSpan !== undefined) {
        cellMeasure.rowSpan = cell.rowSpan;
      }
      if ((cell.rowSpan ?? 1) > 1) {
        const rowSpanEnd = rowIndex + (cell.rowSpan ?? 1);
        for (let offset = 0; offset < colSpan; offset++) {
          rowSpanEnds[columnIndex - colSpan + offset] = rowSpanEnd;
        }
      }
      return cellMeasure;
    });

    let contentHeight = 0;
    for (const cell of cells) {
      contentHeight = Math.max(contentHeight, cell.height);
    }
    const explicitHeight = row.height;
    let height = contentHeight;
    if (explicitHeight !== undefined && row.heightRule === "exact") {
      height = explicitHeight;
    } else if (explicitHeight !== undefined) {
      height = Math.max(contentHeight, explicitHeight);
    }

    return { cells, height };
  });

  let totalHeight = 0;
  for (const row of rows) {
    totalHeight += row.height;
  }

  return {
    kind: "table",
    rows,
    columnWidths,
    totalWidth: sumColumnWidths(columnWidths) || explicitWidth || contentWidth,
    totalHeight,
  };
}

function sumColumnWidths(columnWidths: number[]): number {
  let total = 0;
  for (const width of columnWidths) {
    total += width;
  }
  return total;
}

function getMeasureHeight(measure: Measure): number {
  if (measure.kind === "paragraph" || measure.kind === "table") {
    return measure.totalHeight;
  }
  if (measure.kind === "image" || measure.kind === "textBox") {
    return measure.height;
  }
  return 0;
}

export function applyFootnotePresentation(
  blocks: FlowBlock[],
  displayNumber: number,
): FlowBlock[] {
  if (blocks.length === 0) {
    return [
      {
        kind: "paragraph",
        id: `fn-empty-${displayNumber}`,
        runs: [
          {
            kind: "text",
            text: `${displayNumber}  `,
            fontSize: FOOTNOTE_FONT_SIZE,
            superscript: true,
          },
        ],
      } satisfies ParagraphBlock,
    ];
  }

  const output = blocks.map(applyFootnoteBlockPresentation);

  const first = output[0];
  if (first?.kind === "paragraph") {
    const numberRun: TextRun = {
      kind: "text",
      text: `${displayNumber}  `,
      fontSize: FOOTNOTE_FONT_SIZE,
      superscript: true,
    };
    output[0] = {
      ...first,
      runs: [numberRun, ...first.runs],
    };
  } else {
    output.unshift({
      kind: "paragraph",
      id: `fn-number-${displayNumber}`,
      runs: [
        {
          kind: "text",
          text: `${displayNumber}  `,
          fontSize: FOOTNOTE_FONT_SIZE,
          superscript: true,
        },
      ],
    });
  }

  return output;
}

function applyFootnoteBlockPresentation(block: FlowBlock): FlowBlock {
  if (block.kind === "paragraph") {
    return applyFootnoteParagraphPresentation(block);
  }
  if (block.kind === "table") {
    return {
      ...block,
      rows: block.rows.map((row) => ({
        ...row,
        cells: row.cells.map((cell) => ({
          ...cell,
          blocks: cell.blocks.map(applyFootnoteBlockPresentation),
        })),
      })),
    };
  }
  if (block.kind === "textBox") {
    return {
      ...block,
      content: block.content.map(applyFootnoteParagraphPresentation),
    };
  }
  return block;
}

function applyFootnoteParagraphPresentation(
  block: ParagraphBlock,
): ParagraphBlock {
  return {
    ...block,
    runs: block.runs.map(applyFootnoteRunPresentation),
  };
}

function applyFootnoteRunPresentation(run: Run): Run {
  if (
    (run.kind === "text" || run.kind === "tab" || run.kind === "field") &&
    run.fontSize === undefined
  ) {
    return { ...run, fontSize: FOOTNOTE_FONT_SIZE };
  }
  return run;
}

// ============================================================================
// 4. Build per-page footnote content and reserved heights
// ============================================================================

/**
 * Build footnote content for all footnotes referenced in the document.
 * Returns a Map<footnoteId, FootnoteContent>.
 */
export function buildFootnoteContentMap(
  footnotes: Footnote[],
  footnoteRefs: { footnoteId: number }[],
  contentWidth: number,
  options: ConvertFootnoteOptions = {},
): Map<number, FootnoteContent> {
  const contentMap = new Map<number, FootnoteContent>();
  const footnoteById = new Map<number, Footnote>();

  for (const fn of footnotes) {
    if (fn.noteType === "normal") {
      footnoteById.set(fn.id, fn);
    }
  }

  // Assign display numbers in order of first appearance
  let displayNumber = 1;
  const seen = new Set<number>();

  for (const ref of footnoteRefs) {
    if (seen.has(ref.footnoteId)) {
      continue;
    }
    seen.add(ref.footnoteId);

    const footnote = footnoteById.get(ref.footnoteId);
    if (!footnote) {
      continue;
    }

    const content = convertFootnoteToContent(
      footnote,
      displayNumber,
      contentWidth,
      options,
    );
    contentMap.set(ref.footnoteId, content);
    displayNumber++;
  }

  return contentMap;
}

/**
 * Calculate per-page footnote reserved heights.
 * Returns Map<pageNumber, reservedHeight>.
 */
export function calculateFootnoteReservedHeights(
  pageFootnoteMap: Map<number, number[]>,
  footnoteContentMap: Map<number, { height: number }>,
): Map<number, number> {
  const reserved = new Map<number, number>();

  for (const [pageNumber, footnoteIds] of pageFootnoteMap) {
    let totalHeight = 0;

    for (const fnId of footnoteIds) {
      const content = footnoteContentMap.get(fnId);
      if (content) {
        totalHeight += content.height;
      }
    }

    if (totalHeight > 0) {
      // Add separator + per-entry margin so the static reservation
      // matches what `renderFootnoteArea` actually paints (4px
      // `marginBottom` per fn wrapper). Without this, the painter's
      // clamp would shift the area upward by `count × margin` and
      // overlap the body lines the engine laid out against the
      // smaller reservation.
      totalHeight += FOOTNOTE_SEPARATOR_HEIGHT;
      totalHeight += footnoteIds.length * FOOTNOTE_ENTRY_MARGIN_BOTTOM;
      reserved.set(pageNumber, totalHeight);
    }
  }

  return reserved;
}
