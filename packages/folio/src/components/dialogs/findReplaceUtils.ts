/**
 * Find & Replace Utility Functions
 *
 * Pure utility functions for text search, pattern matching, and document search.
 * Extracted from FindReplaceDialog.tsx.
 */

import type {
  BlockContent,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  Run,
} from "../../core/types/content";
import type { Document } from "../../core/types/document";

// ============================================================================
// TYPES
// ============================================================================

/**
 * A single match result in the document
 */
export type FindMatch = {
  /** Index of the paragraph containing the match */
  paragraphIndex: number;
  /** Index of the run/content within the paragraph */
  contentIndex: number;
  /** Character offset within the content */
  startOffset: number;
  /** Character offset for end of match */
  endOffset: number;
  /** The matched text */
  text: string;
};

/**
 * Find options for controlling search behavior
 */
export type FindOptions = {
  /** Whether to match case */
  matchCase: boolean;
  /** Whether to match whole words only */
  matchWholeWord: boolean;
  /** Whether to use regular expressions (future) */
  useRegex?: boolean;
};

/**
 * Find result with all matches
 */
export type FindResult = {
  /** All matches found */
  matches: FindMatch[];
  /** Total match count */
  totalCount: number;
  /** Current match index (0-based) */
  currentIndex: number;
};

/**
 * Highlight options for document rendering
 */
export type HighlightOptions = {
  /** Background color for current match */
  currentMatchColor: string;
  /** Background color for other matches */
  otherMatchColor: string;
};

// ============================================================================
// TEXT SEARCH UTILITIES
// ============================================================================

/**
 * Create default find options
 */
export function createDefaultFindOptions(): FindOptions {
  return {
    matchCase: false,
    matchWholeWord: false,
    useRegex: false,
  };
}

/**
 * Escape string for use in regex pattern
 */
export function escapeRegexString(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Create a regex pattern from search text and options
 */
export function createSearchPattern(
  searchText: string,
  options: FindOptions,
): RegExp | null {
  if (!searchText) {
    return null;
  }

  try {
    let pattern: string;

    if (options.useRegex) {
      pattern = searchText;
    } else {
      pattern = escapeRegexString(searchText);
    }

    if (options.matchWholeWord) {
      pattern = `\\b${pattern}\\b`;
    }

    const flags = options.matchCase ? "g" : "gi";
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}

/**
 * Find all matches of search text in content
 */
export function findAllMatches(
  content: string,
  searchText: string,
  options: FindOptions,
): { start: number; end: number }[] {
  if (!content || !searchText) {
    return [];
  }

  const matches: { start: number; end: number }[] = [];

  let searchFor = searchText;
  if (!options.matchCase) {
    searchFor = searchText.toLowerCase();
  }

  const escapeRegex = (str: string) =>
    str.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

  let pattern: string;
  if (options.matchWholeWord) {
    pattern = `\\b${escapeRegex(searchFor)}\\b`;
  } else {
    pattern = escapeRegex(searchFor);
  }

  const flags = options.matchCase ? "g" : "gi";
  const regex = new RegExp(pattern, flags);

  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    matches.push({
      start: match.index,
      end: match.index + match[0].length,
    });
    if (match[0].length === 0) {
      regex.lastIndex++;
    }
  }

  return matches;
}

/**
 * Replace text in content
 */
export function replaceAllInContent(
  content: string,
  searchText: string,
  replaceText: string,
  options: FindOptions,
): string {
  const pattern = createSearchPattern(searchText, options);
  if (!pattern) {
    return content;
  }

  return content.replace(pattern, replaceText);
}

/**
 * Replace first match in content
 */
export function replaceFirstInContent(
  content: string,
  searchText: string,
  replaceText: string,
  options: FindOptions,
  startIndex: number = 0,
): {
  content: string;
  replaced: boolean;
  matchStart: number;
  matchEnd: number;
} {
  const matches = findAllMatches(content, searchText, options);

  const match = matches.find((m) => m.start >= startIndex) ?? matches.at(0);

  if (!match) {
    return { content, replaced: false, matchStart: -1, matchEnd: -1 };
  }

  const newContent =
    content.slice(0, match.start) + replaceText + content.slice(match.end);

  return {
    content: newContent,
    replaced: true,
    matchStart: match.start,
    matchEnd: match.start + replaceText.length,
  };
}

/**
 * Get match count for status display
 */
export function getMatchCountText(result: FindResult | null): string {
  if (!result) {
    return "";
  }
  if (result.totalCount === 0) {
    return "No results";
  }
  if (result.totalCount === 1) {
    return "1 match";
  }
  return `${result.currentIndex + 1} of ${result.totalCount} matches`;
}

/**
 * Check if search text is empty or whitespace-only
 */
export function isEmptySearch(searchText: string): boolean {
  return !searchText || searchText.trim() === "";
}

/**
 * Get default highlight options
 */
export function getDefaultHighlightOptions(): HighlightOptions {
  return {
    currentMatchColor: "var(--doc-find-current)",
    otherMatchColor: "var(--doc-find-highlight)",
  };
}

// ============================================================================
// DOCUMENT SEARCH UTILITIES
// ============================================================================

/**
 * Get plain text from a run
 */
function getRunText(run: Run): string {
  let text = "";
  for (const item of run.content) {
    if (item.type === "text") {
      text += item.text;
    } else if (item.type === "tab") {
      text += "\t";
    } else if (item.type === "break" && item.breakType === "textWrapping") {
      text += "\n";
    }
  }
  return text;
}

/**
 * Get plain text from a paragraph
 */
function getParagraphPlainText(paragraph: Paragraph): string {
  let text = "";
  for (const item of paragraph.content) {
    if (item.type === "run") {
      text += getRunText(item);
    } else if (item.type === "hyperlink") {
      for (const child of item.children) {
        if (child.type === "run") {
          text += getRunText(child);
        }
      }
    }
  }
  return text;
}

/**
 * Find all matches in a document
 */
export function findInDocument(
  document: Document | null | undefined,
  searchText: string,
  options: FindOptions,
): FindMatch[] {
  if (!document || !searchText) {
    return [];
  }

  const matches: FindMatch[] = [];
  const body = document.package.document;
  if (!isDocumentBody(body)) {
    return matches;
  }

  forEachParagraph(body.content, (block, paragraphIndex) => {
    const paragraphMatches = findInParagraph(
      block,
      searchText,
      options,
      paragraphIndex,
    );
    matches.push(...paragraphMatches);
  });

  return matches;
}

type ParagraphVisitor = (paragraph: Paragraph, paragraphIndex: number) => void;

function forEachParagraph(
  blocks: readonly BlockContent[],
  visit: ParagraphVisitor,
): void {
  let paragraphIndex = 0;
  const walkBlocks = (items: readonly BlockContent[]): void => {
    for (const block of items) {
      if (isParagraph(block)) {
        visit(block, paragraphIndex);
        paragraphIndex++;
        continue;
      }

      if (isTable(block)) {
        walkTable(block);
        continue;
      }

      if (isBlockSdt(block)) {
        walkBlocks(block.content);
      }
    }
  };

  const walkTable = (table: Table): void => {
    for (const row of table.rows) {
      if (!isTableRow(row)) {
        continue;
      }
      for (const cell of row.cells) {
        if (!isTableCell(cell)) {
          continue;
        }
        walkBlocks(cell.content);
      }
    }
  };

  walkBlocks(blocks);
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null;
}

function isDocumentBody(
  value: unknown,
): value is Document["package"]["document"] {
  return isRecord(value) && Array.isArray(value["content"]);
}

function isParagraph(value: unknown): value is Paragraph {
  return (
    isRecord(value) &&
    value["type"] === "paragraph" &&
    Array.isArray(value["content"])
  );
}

function isTable(value: unknown): value is Table {
  return (
    isRecord(value) && value["type"] === "table" && Array.isArray(value["rows"])
  );
}

function isTableRow(value: unknown): value is TableRow {
  return isRecord(value) && Array.isArray(value["cells"]);
}

function isTableCell(value: unknown): value is TableCell {
  return isRecord(value) && Array.isArray(value["content"]);
}

function isBlockSdt(
  value: unknown,
): value is Extract<BlockContent, { type: "blockSdt" }> {
  return (
    isRecord(value) &&
    value["type"] === "blockSdt" &&
    Array.isArray(value["content"])
  );
}

/**
 * Find matches in a single paragraph
 */
export function findInParagraph(
  paragraph: Paragraph,
  searchText: string,
  options: FindOptions,
  paragraphIndex: number,
): FindMatch[] {
  const matches: FindMatch[] = [];
  const paragraphText = getParagraphPlainText(paragraph);

  if (!paragraphText) {
    return matches;
  }

  const textMatches = findAllMatches(paragraphText, searchText, options);

  for (const match of textMatches) {
    const contentInfo = findContentAtOffset(paragraph, match.start);

    matches.push({
      paragraphIndex,
      contentIndex: contentInfo.contentIndex,
      startOffset: match.start,
      endOffset: match.end,
      text: paragraphText.slice(match.start, match.end),
    });
  }

  return matches;
}

/**
 * Find the content (run) at a specific character offset in a paragraph
 */
function findContentAtOffset(
  paragraph: Paragraph,
  offset: number,
): { contentIndex: number; runIndex: number; offsetInContent: number } {
  let currentOffset = 0;
  let contentIndex = 0;

  for (const item of paragraph.content) {
    let itemText = "";

    if (item.type === "run") {
      itemText = getRunText(item);
    } else if (item.type === "hyperlink") {
      for (const child of item.children) {
        if (child.type === "run") {
          itemText += getRunText(child);
        }
      }
    }

    const itemLength = itemText.length;

    if (currentOffset + itemLength > offset) {
      return {
        contentIndex,
        runIndex: contentIndex,
        offsetInContent: offset - currentOffset,
      };
    }

    currentOffset += itemLength;
    contentIndex++;
  }

  return {
    contentIndex: Math.max(0, paragraph.content.length - 1),
    runIndex: Math.max(0, paragraph.content.length - 1),
    offsetInContent: 0,
  };
}

/**
 * Scroll to a match in the document
 */
export function scrollToMatch(
  containerElement: HTMLElement | null,
  match: FindMatch,
): void {
  if (!containerElement) {
    return;
  }

  const paragraphElement =
    containerElement.querySelector(
      `[data-paragraph-index="${match.paragraphIndex}"]`,
    ) ??
    containerElement.querySelector(
      `.layout-paragraph[data-block-id="block-${match.paragraphIndex + 1}"]`,
    ) ??
    containerElement
      .querySelectorAll(".layout-paragraph")
      .item(match.paragraphIndex);

  paragraphElement.scrollIntoView({ behavior: "smooth", block: "center" });
}
