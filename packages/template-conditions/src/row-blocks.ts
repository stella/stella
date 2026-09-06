/**
 * Row-form block markers: the lenient placement authoring agents actually
 * write for a "one row per item" table.
 *
 * The canonical placement gives a block marker its own paragraph. In a table
 * that costs an extra empty-looking paragraph in the first and last cell, so
 * an author instead types the opener in front of the first cell's text and the
 * closer behind the last cell's text:
 *
 *     | {{#each deliverables}}{{deliverables.item}} | {{deliverables.fee}}{{/each}} |
 *
 * Both placements mean the same thing — the `w:tr` is the unit — so this
 * module recognizes the row form purely from text, and the consumer rewrites
 * it into the canonical form before any engine runs.
 *
 * Text-only and structure-free on purpose: the fill/discovery pipeline feeds
 * it OOXML run text, the authoring eval feeds it the cells a model produced,
 * and neither can drift from the other's idea of what a row block is.
 */

import { blockDirectiveLinePattern, scanMarkers } from "./markers.js";
import type { ScannedMarker } from "./markers.js";

/** One end of a row block, addressed within the row that was scanned. */
export type RowBlockMarker = {
  /** Index into the row's cells. */
  cellIndex: number;
  /** Index into that cell's paragraphs. */
  paragraphIndex: number;
  marker: ScannedMarker;
};

export type RowBlockPair = {
  open: RowBlockMarker;
  close: RowBlockMarker;
};

const CLOSER_OF = {
  each: "endeach",
  if: "endif",
} as const satisfies Record<"each" | "if", "endeach" | "endif">;

type OpenKind = keyof typeof CLOSER_OF;

const isOpenKind = (kind: string): kind is OpenKind =>
  kind === "each" || kind === "if";

/**
 * Block markers in one paragraph that do not pair inside it. A pair that opens
 * and closes within the paragraph is an inline span (`the Buyer{{#if x}} and
 * spouse{{/if}}`), which the inline engine already owns; only what is left
 * over can reach across cells.
 *
 * A branch marker (`{{#elseif}}`, `{{#else}}`) counts as left over unless its
 * `{{#if}}` also closes in this paragraph. Only the opener and the closer of a
 * row block are hoisted, so a branch marker stranded between them would stay
 * buried in the cell text: a false condition would drop the whole row and the
 * branch that should have rendered with it, and a true one would leave the
 * marker behind as an inline orphan. Counting it here refuses the placement
 * instead.
 *
 * A paragraph that is nothing but a directive is the canonical form and
 * belongs to the block engine, so it contributes nothing here.
 */
const danglingBlockMarkers = (text: string): ScannedMarker[] => {
  if (blockDirectiveLinePattern().test(text)) {
    return [];
  }
  type OpenFrame = {
    kind: OpenKind;
    marker: ScannedMarker;
    /** `{{#elseif}}` / `{{#else}}` markers belonging to this frame. */
    branches: ScannedMarker[];
  };
  const open: OpenFrame[] = [];
  const dangling: ScannedMarker[] = [];
  for (const marker of scanMarkers(text)) {
    const { kind } = marker.meta;
    if (isOpenKind(kind)) {
      open.push({ kind, marker, branches: [] });
      continue;
    }
    if (kind === "endeach" || kind === "endif") {
      const innermost = open.at(-1);
      if (innermost && CLOSER_OF[innermost.kind] === kind) {
        // The frame closed here, so its branch markers closed with it.
        open.pop();
      } else {
        dangling.push(marker);
      }
      continue;
    }
    if (kind === "elseif" || kind === "else") {
      const innermost = open.at(-1);
      if (innermost?.kind === "if") {
        innermost.branches.push(marker);
      } else {
        dangling.push(marker);
      }
    }
  }
  // A frame still open at the end of the paragraph reaches outside it, and so
  // does every branch marker that belonged to it.
  for (const { branches, marker } of open) {
    dangling.push(marker, ...branches);
  }
  return dangling.toSorted((a, b) => a.start - b.start);
};

const firstContentParagraph = (paragraphs: readonly string[]): number =>
  paragraphs.findIndex((text) => text.trim() !== "");

const lastContentParagraph = (paragraphs: readonly string[]): number =>
  paragraphs.findLastIndex((text) => text.trim() !== "");

/** The marker stands in front of everything the cell says. */
const prefixesCell = (
  paragraphs: readonly string[],
  { marker, paragraphIndex }: RowBlockMarker,
): boolean =>
  paragraphIndex === firstContentParagraph(paragraphs) &&
  (paragraphs[paragraphIndex] ?? "").slice(0, marker.start).trim() === "";

/** The marker stands behind everything the cell says. */
const suffixesCell = (
  paragraphs: readonly string[],
  { marker, paragraphIndex }: RowBlockMarker,
): boolean =>
  paragraphIndex === lastContentParagraph(paragraphs) &&
  (paragraphs[paragraphIndex] ?? "").slice(marker.end).trim() === "";

/**
 * The one row block a table row declares in the lenient form, or `null`.
 *
 * `cells` is the row's cells in document order, each as its paragraph texts in
 * document order.
 *
 * A row qualifies when exactly two block markers reach outside their own
 * paragraph, they are a matching opener/closer pair, the closer sits in a LATER
 * cell than the opener, the opener prefixes its cell and the closer suffixes
 * its cell. Everything else — one half of a pair, two nested pairs, a stray
 * `{{#else}}`, a pair wrapping the paragraphs of a single cell — is left to the
 * engine's existing structure errors rather than guessed at.
 */
export const detectRowBlockPair = (
  cells: readonly (readonly string[])[],
): RowBlockPair | null => {
  const located: RowBlockMarker[] = [];
  for (const [cellIndex, paragraphs] of cells.entries()) {
    for (const [paragraphIndex, text] of paragraphs.entries()) {
      for (const marker of danglingBlockMarkers(text)) {
        located.push({ cellIndex, paragraphIndex, marker });
      }
    }
  }

  if (located.length !== 2) {
    return null;
  }
  const [open, close] = located;
  if (!open || !close) {
    return null;
  }
  const openKind = open.marker.meta.kind;
  if (!isOpenKind(openKind) || close.marker.meta.kind !== CLOSER_OF[openKind]) {
    return null;
  }
  // Cell to cell, never within one cell: a pair wrapping the paragraphs of a
  // single cell reads as a block scoped to that cell, not to the row, and the
  // row is the only unit this placement can act on.
  if (open.cellIndex >= close.cellIndex) {
    return null;
  }
  if (
    !prefixesCell(cells[open.cellIndex] ?? [], open) ||
    !suffixesCell(cells[close.cellIndex] ?? [], close)
  ) {
    return null;
  }
  return { open, close };
};
