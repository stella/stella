import { resolveTextWindowBounds } from "@/api/mcp/tool-utils";

const OUTLINE_LIMIT = 100;
// A navigation label, not a preview: a numbered paragraph is named by its
// opening words, and a hundred long openings would outweigh the page itself.
const TITLE_LIMIT = 80;
const NUMBERED_SECTION = /^(?:[IVXLCDM]+[.)]|\d+[.)]|\[\d+\])(?:\s|$)/u;

/** One AST block as the decision read holds it. */
export type DecisionTextBlock = {
  type: string;
  plainText: string;
  /** The reader's fragment for this block; absent on a block without one. */
  anchorId?: string;
};

/** A block found in the served plain text, with where it sits there. */
export type LocatedDecisionBlock = {
  anchorId: string | null;
  end: number;
  start: number;
  text: string;
  type: string;
};

/**
 * Every block with text, located in the served plain text in document order.
 * The plain text is built from these blocks, so each is found after the one
 * before it; a block that cannot be found (a fallback text that differs) is
 * left out rather than guessed at.
 */
export const locateDecisionBlocks = (
  blocks: readonly DecisionTextBlock[],
  text: string,
): LocatedDecisionBlock[] => {
  const located: LocatedDecisionBlock[] = [];
  let offset = 0;
  for (const block of blocks) {
    const found = text.indexOf(block.plainText, offset);
    if (block.plainText.length === 0 || found === -1) {
      continue;
    }
    offset = found + block.plainText.length;
    located.push({
      anchorId: block.anchorId ?? null,
      end: offset,
      start: found,
      text: block.plainText,
      type: block.type,
    });
  }
  return located;
};

/** The located block holding `offset`, by its span. */
const blockAt = (
  located: readonly LocatedDecisionBlock[],
  offset: number,
): LocatedDecisionBlock | undefined =>
  located.find((block) => block.start <= offset && offset < block.end);

type DecisionOutlineOptions = {
  blocks: readonly DecisionTextBlock[] | null;
  text: string;
};

export type DecisionOutlineEntry = {
  /** The reader's fragment for the block the entry opens, when it has one. */
  anchorId: string | null;
  /** Where the entry starts in the served plain text. */
  start: number;
  title: string;
};

export const decisionOutline = ({
  blocks,
  text,
}: DecisionOutlineOptions): DecisionOutlineEntry[] => {
  const located = blocks === null ? [] : locateDecisionBlocks(blocks, text);
  const entries = new Map<number, string>();
  for (const block of located) {
    if (entries.size >= OUTLINE_LIMIT) {
      break;
    }
    if (block.type === "heading") {
      entries.set(block.start, block.text);
    }
  }
  // Plain-text decisions also carry numbered sections and reasoning paragraphs.
  for (const line of text.matchAll(/[^\r\n]+/gu)) {
    if (entries.size >= OUTLINE_LIMIT) {
      break;
    }
    const title = line[0].trim();
    if (NUMBERED_SECTION.test(title)) {
      entries.set(line.index + line[0].indexOf(title), title);
    }
  }
  return [...entries]
    .toSorted(([left], [right]) => left - right)
    .slice(0, OUTLINE_LIMIT)
    .map(([start, title]) => ({
      anchorId: blockAt(located, start)?.anchorId ?? null,
      start,
      title: title.slice(
        0,
        resolveTextWindowBounds({
          text: title,
          offset: 0,
          size: TITLE_LIMIT,
        }).end,
      ),
    }));
};
