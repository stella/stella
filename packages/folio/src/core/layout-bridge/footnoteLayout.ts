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
  TextRun,
  FootnoteContent,
} from "../layout-engine/types";
import { footnoteToProseDoc } from "../prosemirror/conversion/toProseDoc";
import type { Footnote, StyleDefinitions, Theme } from "../types/document";
import { measureParagraph } from "./measuring";
import { toFlowBlocks } from "./toFlowBlocks";

/** Separator line height + padding in pixels */
const SEPARATOR_HEIGHT = 12;

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
};

// ============================================================================
// 1. Scan FlowBlocks for footnote references
// ============================================================================

/**
 * Scan FlowBlocks for runs with footnoteRefId set.
 * Returns a list of { footnoteId, pmPos } in document order.
 */
export function collectFootnoteRefs(
  blocks: FlowBlock[],
): { footnoteId: number; pmPos: number }[] {
  const refs: { footnoteId: number; pmPos: number }[] = [];

  for (const block of blocks) {
    if (block.kind !== "paragraph") {
      continue;
    }
    for (const run of block.runs) {
      if (run.kind === "text" && run.footnoteRefId !== undefined) {
        refs.push({
          footnoteId: run.footnoteRefId,
          pmPos: run.pmStart ?? 0,
        });
      }
    }
  }

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
  const blocks = applyFootnotePresentation(
    toFlowBlocks(pmDoc, flowOptions),
    displayNumber,
  );

  const measures = options.measureBlocks
    ? options.measureBlocks(blocks, contentWidth)
    : blocks.map((block) =>
        block.kind === "paragraph"
          ? measureParagraph(block, contentWidth)
          : ({ kind: block.kind } as Measure),
      );

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

  const output = blocks.map((block) => {
    if (block.kind !== "paragraph") {
      return block;
    }
    return {
      ...block,
      runs: block.runs.map((run) => {
        if ((run.kind === "text" || run.kind === "tab") && !run.fontSize) {
          return { ...run, fontSize: FOOTNOTE_FONT_SIZE };
        }
        return run;
      }),
    };
  });

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
  }

  return output;
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
    if (fn.noteType === "normal" || fn.noteType === null) {
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
      // Add separator height
      totalHeight += SEPARATOR_HEIGHT;
      reserved.set(pageNumber, totalHeight);
    }
  }

  return reserved;
}
