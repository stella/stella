/**
 * Rewrite a table row's lenient block markers into the canonical
 * own-paragraph form, before discovery or the block engine looks at the row.
 *
 * A `{% for %}` / `{% if %}` opener that prefixes a cell's text, closed by a
 * `{% endfor %}` / `{% endif %}` that suffixes a later cell's text in the same
 * `w:tr`, means what the own-paragraph placement means: the row is the unit.
 * Authoring agents write it constantly for a "one row per item" table, so it
 * is accepted rather than reported as an unclosed inline block.
 *
 *     | {% for deliverable in deliverables %}{{ deliverable.item }} | {{ deliverable.fee }}{% endfor %} |
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

import { detectRowBlockPair, scanMarkers } from "@stll/template-conditions";
import type { RowBlockMarker, ScannedMarker } from "@stll/template-conditions";

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
 * A row-form pair whose two halves sit in DIFFERENT rows of one table: the
 * shape an author reaches for when the header row looks like the place to
 * start repeating. It is not a row block — the row is the unit, and these name
 * two — so the engine reports an unclosed opener and an orphaned closer. That
 * says what broke, not what the author got wrong, which is what this is for.
 */
export type MisplacedRowBlock = {
  /** The cell text the opener prefixes. */
  openerCell: string;
  /** The cell text the closer suffixes. */
  closerCell: string;
  /** The opener marker, as written. */
  opener: string;
  /** The closer marker, as written. */
  closer: string;
};

const CLOSER_OF_OPENER = { for: "endfor", if: "endif" } as const;

const isRowBlockOpener = (
  kind: string,
): kind is keyof typeof CLOSER_OF_OPENER => kind === "for" || kind === "if";

/**
 * Every opener/closer pair in `container` that hugs its cell's text the way a
 * row block does, but whose halves are in different rows of the same table.
 *
 * Read after {@link normalizeRowBlockMarkers}, so a genuine row block has
 * already been rewritten out of the way and only the misplaced ones are left.
 */
export const misplacedRowBlocks = (
  container: slimdom.Element,
): MisplacedRowBlock[] => {
  const found: MisplacedRowBlock[] = [];
  for (const table of container.getElementsByTagNameNS(W_NS, "tbl")) {
    const open: { marker: ScannedMarker; cell: string; row: number }[] = [];
    for (const [rowIndex, row] of [
      ...table.getElementsByTagNameNS(W_NS, "tr"),
    ].entries()) {
      const rowParent = row.parentNode;
      if (
        rowParent === null ||
        ancestorByLocalName(rowParent, "tbl") !== table
      ) {
        continue;
      }
      for (const cell of rowCells(row)) {
        const text = cellParagraphs(cell).map(paragraphSpanText).join("\n");
        for (const marker of scanMarkers(text)) {
          const { kind } = marker.meta;
          if (
            isRowBlockOpener(kind) &&
            text.slice(0, marker.start).trim() === ""
          ) {
            open.push({ marker, cell: text, row: rowIndex });
            continue;
          }
          const last = open.at(-1);
          if (
            last === undefined ||
            !isRowBlockOpener(last.marker.meta.kind) ||
            CLOSER_OF_OPENER[last.marker.meta.kind] !== kind
          ) {
            continue;
          }
          open.pop();
          // Same row is either a real row block (already normalized away) or
          // an inline pair the inline engine owns; only a pair reaching across
          // rows is the mistake this names.
          if (last.row === rowIndex || text.slice(marker.end).trim() !== "") {
            continue;
          }
          found.push({
            opener: last.marker.raw,
            openerCell: last.cell,
            closer: marker.raw,
            closerCell: text,
          });
        }
      }
    }
  }
  return found;
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
