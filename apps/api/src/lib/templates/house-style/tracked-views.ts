// A document that keeps its tracked changes is two documents: the one with
// the changes accepted and the one with them rejected. A clause inserted or
// deleted in front of another gives that other a different number in each.
// This pairs the paragraphs of the two readings, so that a plan can tell a
// paragraph whose number depends on the view.

import type { DocxBlock } from "@/api/lib/templates/house-style/folio-contract";

/** Above this many pairs of paragraphs to compare, the part of the two
 *  readings that differs is not paired by text. */
const COMPARISONS_MAX = 4_000_000;

type Pair = readonly [kept: number, rejected: number];

/** What a paragraph says, whatever blank separates its words. */
const wordsOf = ({ text }: DocxBlock): string => text.replaceAll(/\s+/gu, "");

/** The number a paragraph shows: the one its list prints, or else the first
 *  word of its text, which is where a typed number stands. */
const numberOf = ({ label, text }: DocxBlock): string => {
  const printed = (label ?? "").trim();
  return printed === "" ? (text.trim().split(/\s/u).at(0) ?? "") : printed;
};

/** Whether all of the paragraph's text is one insertion: with the changes
 *  rejected it is not there. */
const isInserted = ({ text, revisions }: DocxBlock): boolean =>
  revisions?.some(
    ({ kind, start, end, paragraphMark }) =>
      kind === "insertion" &&
      paragraphMark !== true &&
      start === 0 &&
      end >= text.length,
  ) === true;

/** The entries two lists share, in order, as pairs of positions: the
 *  longest such choice. */
const longestShared = (
  kept: readonly string[],
  rejected: readonly string[],
): Pair[] => {
  const rows = kept.length;
  const columns = rejected.length;
  const width = columns + 1;
  const lengths = new Int32Array((rows + 1) * width);
  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let column = columns - 1; column >= 0; column -= 1) {
      lengths[row * width + column] =
        kept[row] === rejected[column]
          ? (lengths[(row + 1) * width + column + 1] ?? 0) + 1
          : Math.max(
              lengths[(row + 1) * width + column] ?? 0,
              lengths[row * width + column + 1] ?? 0,
            );
    }
  }
  const pairs: Pair[] = [];
  let row = 0;
  let column = 0;
  while (row < rows && column < columns) {
    if (kept[row] === rejected[column]) {
      pairs.push([row, column]);
      row += 1;
      column += 1;
    } else if (
      (lengths[(row + 1) * width + column] ?? 0) >=
      (lengths[row * width + column + 1] ?? 0)
    ) {
      row += 1;
    } else {
      column += 1;
    }
  }
  return pairs;
};

/**
 * The paragraphs of the two readings that say the same, in order. Most of
 * a document is untouched, so what the readings share at their start and
 * at their end pairs up directly and only the part between is searched.
 */
const sameWords = (
  kept: readonly string[],
  rejected: readonly string[],
): Pair[] => {
  const pairs: Pair[] = [];
  const shorter = Math.min(kept.length, rejected.length);
  let head = 0;
  while (head < shorter && kept[head] === rejected[head]) {
    pairs.push([head, head]);
    head += 1;
  }
  let tail = 0;
  while (
    tail < shorter - head &&
    kept[kept.length - 1 - tail] === rejected[rejected.length - 1 - tail]
  ) {
    tail += 1;
  }
  const rows = kept.length - head - tail;
  const columns = rejected.length - head - tail;
  if (rows > 0 && columns > 0 && rows * columns <= COMPARISONS_MAX) {
    for (const [row, column] of longestShared(
      kept.slice(head, head + rows),
      rejected.slice(head, head + columns),
    )) {
      pairs.push([head + row, head + column]);
    }
  }
  for (let offset = tail; offset >= 1; offset -= 1) {
    pairs.push([kept.length - offset, rejected.length - offset]);
  }
  return pairs;
};

/**
 * The number each paragraph of a document shows with its tracked changes
 * rejected, by the id the paragraph has in `kept`: the document read with
 * the changes kept, whose text is the accepted one. `rejected` is the same
 * document read with the changes rejected.
 *
 * Paragraphs that say the same in both readings pair up, in order. Between
 * two such pairs, the paragraphs that are left pair up in order when there
 * are as many on one side as on the other (a paragraph somebody inserted
 * whole is on neither). A paragraph without a counterpart is not in the
 * result: with the changes rejected it is not there, or which one it is
 * cannot be told.
 */
export const numbersWhenRejected = (
  kept: readonly DocxBlock[],
  rejected: readonly DocxBlock[],
): Map<string, string> => {
  const said = (block: DocxBlock): boolean =>
    block.kind === "paragraph" && wordsOf(block) !== "";
  const before = kept.filter(said);
  const after = rejected.filter(said);
  const anchors = sameWords(before.map(wordsOf), after.map(wordsOf));
  const numbers = new Map<string, string>();
  const pair = (keptBlock?: DocxBlock, rejectedBlock?: DocxBlock): void => {
    if (keptBlock !== undefined && rejectedBlock !== undefined) {
      numbers.set(keptBlock.id, numberOf(rejectedBlock));
    }
  };
  let keptFrom = 0;
  let rejectedFrom = 0;
  for (const [keptAt, rejectedAt] of [
    ...anchors,
    [before.length, after.length] as const,
  ]) {
    const left = before
      .slice(keptFrom, keptAt)
      .filter((block) => !isInserted(block));
    const right = after.slice(rejectedFrom, rejectedAt);
    if (left.length === right.length) {
      for (const [position, block] of left.entries()) {
        pair(block, right[position]);
      }
    }
    pair(before[keptAt], after[rejectedAt]);
    keptFrom = keptAt + 1;
    rejectedFrom = rejectedAt + 1;
  }
  return numbers;
};

/** The number a paragraph shows now, to hold against the one it shows
 *  with the changes rejected. */
export const numberShown = numberOf;
