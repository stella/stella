/**
 * Rewrite a table row's lenient block markers into the canonical
 * own-paragraph form, before discovery or the block engine looks at the row.
 *
 * A `{{#each}}` / `{{#if}}` opener that prefixes a cell's text, closed by a
 * `{{/each}}` / `{{/if}}` that suffixes a later cell's text in the same
 * `w:tr`, means what the own-paragraph placement means: the row is the unit.
 * Authoring agents write it constantly for a "one row per item" table, so it
 * is accepted rather than reported as an unclosed inline block.
 *
 *     | {{#each deliverables}}{{deliverables.item}} | {{deliverables.fee}}{{/each}} |
 *
 * Normalizing (rather than teaching the engine a second placement) is what
 * keeps the two forms from drifting: the row-repeat, the row condition, the
 * straddling-marker errors, the loop-item discovery, and the authoring
 * warnings all keep running on exactly one shape. The marker text is cut from
 * its run with the same run-splitting the inline engine uses, so the cell's
 * remaining runs keep their formatting, and the cut marker is re-emitted as a
 * paragraph of its own directly around the cell paragraph it came from — a
 * paragraph the engine strips again while expanding or pruning the row.
 *
 * {@link detectRowBlockPair} owns the grammar side of the decision and is
 * shared with the authoring eval, so both judge a row the same way.
 */

import type * as slimdom from "slimdom";

import { detectRowBlockPair } from "@stll/template-conditions";
import type { RowBlockMarker } from "@stll/template-conditions";

import { ancestorByLocalName, W_NS } from "./ooxml";
import { paragraphSpanText, replaceParagraphTextRanges } from "./rich-patch";

/** The row's own cells; a nested table's cells belong to its own rows. */
const rowCells = (row: slimdom.Element): slimdom.Element[] =>
  [...row.getElementsByTagNameNS(W_NS, "tc")].filter(
    (cell) =>
      cell.parentNode !== null &&
      ancestorByLocalName(cell.parentNode, "tr") === row,
  );

/** The cell's own paragraphs; a nested table's paragraphs belong to its cells. */
const cellParagraphs = (cell: slimdom.Element): slimdom.Element[] =>
  [...cell.getElementsByTagNameNS(W_NS, "p")].filter(
    (paragraph) =>
      paragraph.parentNode !== null &&
      ancestorByLocalName(paragraph.parentNode, "tc") === cell,
  );

/**
 * The authored paragraph each hoisted marker paragraph was cut out of.
 *
 * A hoisted paragraph exists only so the block engine sees the canonical
 * placement; the author never typed it and cannot count to it in Word. Every
 * diagnostic that names a paragraph position therefore resolves through
 * {@link authoredParagraphIndex}, which gives a hoisted marker the index of the
 * paragraph it came from and no index of its own.
 */
const hoistedFrom = new WeakMap<slimdom.Element, slimdom.Element>();

/**
 * Cut one marker out of its paragraph's runs and re-emit it as its own
 * paragraph beside that one, so the block engine sees the canonical placement.
 */
const hoistMarker = (
  paragraphsByCell: readonly (readonly slimdom.Element[])[],
  { cellIndex, marker, paragraphIndex }: RowBlockMarker,
  placement: "after" | "before",
): void => {
  const paragraph = paragraphsByCell[cellIndex]?.[paragraphIndex];
  const parent = paragraph?.parentNode;
  const doc = paragraph?.ownerDocument;
  if (!paragraph || !parent || !doc) {
    return;
  }

  replaceParagraphTextRanges(paragraph, [
    { start: marker.start, end: marker.end, value: "" },
  ]);

  const markerParagraph = doc.createElementNS(W_NS, "w:p");
  const run = doc.createElementNS(W_NS, "w:r");
  const text = doc.createElementNS(W_NS, "w:t");
  text.appendChild(doc.createTextNode(marker.raw));
  run.appendChild(text);
  markerParagraph.appendChild(run);
  hoistedFrom.set(markerParagraph, paragraph);
  parent.insertBefore(
    markerParagraph,
    placement === "before" ? paragraph : paragraph.nextSibling,
  );
};

/**
 * Rewrite every row-form block pair in `container` into the own-paragraph
 * form. Idempotent in effect: a rewritten marker owns its paragraph, which the
 * detector ignores.
 */
export const normalizeRowBlockMarkers = (container: slimdom.Element): void => {
  for (const row of [...container.getElementsByTagNameNS(W_NS, "tr")]) {
    const paragraphsByCell = rowCells(row).map(cellParagraphs);
    const pair = detectRowBlockPair(
      paragraphsByCell.map((paragraphs) => paragraphs.map(paragraphSpanText)),
    );
    if (!pair) {
      continue;
    }
    // Closer first: hoisting it inserts a sibling paragraph, which leaves the
    // opener's own runs and offsets untouched either way, and reading the row
    // back-to-front matches every other marker rewrite in the pipeline.
    hoistMarker(paragraphsByCell, pair.close, "after");
    hoistMarker(paragraphsByCell, pair.open, "before");
  }
};

/**
 * For each position in `paragraphs`, the position that paragraph holds in the
 * file the author wrote: hoisted marker paragraphs take no index of their own,
 * and each reports the index of the paragraph it was cut from.
 *
 * Every diagnostic that names a paragraph resolves through this, so a template
 * using the row form reports the same positions as the same template written
 * the long way — the positions `extractText` and the preview address. Built
 * once per paragraph snapshot; the index it translates must address that same
 * snapshot.
 *
 * A paragraph that was never hoisted and is not in the snapshot keeps its own
 * position: that is a paragraph the loop engine cloned, which has no authored
 * position at all, so its position is the only honest answer.
 */
export const authoredParagraphIndices = (
  paragraphs: readonly slimdom.Element[],
): number[] => {
  const authoredBySource = new Map<slimdom.Element, number>();
  let authored = 0;
  for (const paragraph of paragraphs) {
    if (hoistedFrom.has(paragraph)) {
      continue;
    }
    authoredBySource.set(paragraph, authored);
    authored += 1;
  }
  return paragraphs.map((paragraph, index) => {
    const source = hoistedFrom.get(paragraph) ?? paragraph;
    return authoredBySource.get(source) ?? index;
  });
};
