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
 * A paragraph that is nothing but a directive is the canonical form and
 * belongs to the block engine, so it contributes nothing here.
 */
const danglingBlockMarkers = (text: string): ScannedMarker[] => {
  if (blockDirectiveLinePattern().test(text)) {
    return [];
  }
  const open: { kind: OpenKind; marker: ScannedMarker }[] = [];
  const dangling: ScannedMarker[] = [];
  for (const marker of scanMarkers(text)) {
    const { kind } = marker.meta;
    if (isOpenKind(kind)) {
      open.push({ kind, marker });
      continue;
    }
    if (kind === "endeach" || kind === "endif") {
      const innermost = open.at(-1);
      if (innermost && CLOSER_OF[innermost.kind] === kind) {
        open.pop();
      } else {
        dangling.push(marker);
      }
      continue;
    }
    if ((kind === "elseif" || kind === "else") && open.at(-1)?.kind !== "if") {
      dangling.push(marker);
    }
  }
  return [...dangling, ...open.map(({ marker }) => marker)].toSorted(
    (a, b) => a.start - b.start,
  );
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
 * paragraph, they are a matching opener/closer pair, the opener prefixes its
 * cell and the closer suffixes its cell. Everything else — one half of a pair,
 * two nested pairs, a stray `{{#else}}` — is left to the engine's existing
 * structure errors rather than guessed at.
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
  if (
    !prefixesCell(cells[open.cellIndex] ?? [], open) ||
    !suffixesCell(cells[close.cellIndex] ?? [], close)
  ) {
    return null;
  }
  return { open, close };
};
