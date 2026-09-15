/**
 * Where a decision names another decision, and which of those mentions the
 * citation row was classified from.
 *
 * One rule, because two would disagree: the reader marks every mention in the
 * text it renders, and the agent-facing read returns one paragraph beside the
 * treatment a classifier gave that citation. If those two located the citation
 * differently, the same citation would be highlighted in one paragraph and
 * quoted from another.
 */

import { escapeRegExp } from "@stll/text-normalize";

import { hasBlockInlines, plainTextOf } from "./document-ast.js";
import type { Block } from "./document-ast.js";
import { dropOverlappingSpans } from "./text-spans.js";

/** What locating needs of a citation: the text the decision printed. */
export type CitationSource = { citationText: string };

export type CitationSpan<Source extends CitationSource> = {
  end: number;
  source: Source;
  start: number;
};

/**
 * Citations whose text is long enough to locate without false hits. A very
 * short case number would match inside longer ones and inside dates.
 */
const MIN_ANCHOR_TEXT_LENGTH = 5;

/**
 * A pattern for the citation as the text may print it: the extractor stored
 * the verbatim match, which can carry a wrapped line or a double space where
 * the rendered paragraph has one, so whitespace runs match any whitespace.
 */
const patternFor = (citationText: string): RegExp | null => {
  const trimmed = citationText.trim();
  if (trimmed.length < MIN_ANCHOR_TEXT_LENGTH) {
    return null;
  }
  const source = trimmed
    .split(/\s+/u)
    .map((part) => escapeRegExp(part))
    .join("\\s+");
  // Citation-safe boundaries, not `\b`: a case number ends in a digit and
  // may be followed by a page suffix ("-493") or a period, both fine, but
  // "II CSK 123/20" must not match inside "II CSK 123/201", and a number
  // must not start in the middle of a word or a longer number.
  return new RegExp(`(?<![\\p{L}\\p{N}])${source}(?![\\p{L}\\p{N}/])`, "gu");
};

/**
 * Where each cited decision is named in each block, keyed by block id.
 *
 * One citation row stands for every mention of its case in the decision,
 * so every occurrence is located. Overlapping hits keep the earlier, longer
 * one; a table is skipped because its text is split across cell pieces.
 */
export const locateCitationSpans = <Source extends CitationSource>({
  blocks,
  citations,
}: {
  blocks: readonly Block[];
  citations: readonly Source[];
}): Record<string, CitationSpan<Source>[]> => {
  const patterns: { pattern: RegExp; source: Source }[] = [];
  for (const source of citations) {
    const pattern = patternFor(source.citationText);
    if (pattern !== null) {
      patterns.push({ pattern, source });
    }
  }
  if (patterns.length === 0) {
    return {};
  }

  const result: Record<string, CitationSpan<Source>[]> = {};
  for (const block of blocks) {
    if (!hasBlockInlines(block)) {
      continue;
    }
    // The reader renders and highlights over the inline flattening, not
    // `block.plainText`, which the pipeline may have normalised; offsets
    // must come from the same characters the renderer walks.
    const text = plainTextOf(block.inlines);
    const hits: CitationSpan<Source>[] = [];
    for (const { pattern, source } of patterns) {
      pattern.lastIndex = 0;
      for (
        let match = pattern.exec(text);
        match !== null;
        match = pattern.exec(text)
      ) {
        hits.push({
          end: match.index + match[0].length,
          source,
          start: match.index,
        });
        if (match[0].length === 0) {
          pattern.lastIndex += 1;
        }
      }
    }
    if (hits.length === 0) {
      continue;
    }

    result[block.id] = dropOverlappingSpans(hits);
  }

  return result;
};

/**
 * Which mention of the cited decision a returned paragraph carries, so a
 * reader knows whether it is the mention a treatment was classified from.
 *
 * Ingestion records a `sectionIndex` into the decision's section
 * segmentation and the classifier reads that section's first occurrence.
 * Sections are not blocks and no stored anchor ties one to the other, so the
 * section is matched by its text:
 *
 * - `sole`: one block carries the citation, so there is no other mention.
 * - `classified_section`: the paragraph came from the recorded section.
 * - `latest_of_several`: no section survived to narrow by, so the last of
 *   several mentions stands in and a treatment may belong to another.
 */
export const CITATION_PASSAGE_MENTIONS = [
  "sole",
  "classified_section",
  "latest_of_several",
] as const;

export type CitationPassageMention = (typeof CITATION_PASSAGE_MENTIONS)[number];

/** The paragraph a citation sits in, and where in it the citation starts. */
export type CitationPassageMatch = {
  anchorId: string;
  blockId: string;
  end: number;
  mention: CitationPassageMention;
  start: number;
  /** The block's text as the renderer walks it, never an excerpt. */
  text: string;
};

export type FindCitationPassageOptions = {
  blocks: readonly Block[];
  citationText: string;
  /**
   * The text of the section the citation row was extracted from, when the
   * decision still carries its segmentation. Absent, the last mention stands
   * in and `mention` says so.
   */
  sectionText: string | undefined;
};

/**
 * The paragraph in which a decision names another, anchored to the mention a
 * treatment was read from wherever the decision still says which that was.
 *
 * A case is commonly listed bare in the header and then discussed in the
 * reasoning, which is why the fallback prefers the last mention: ingestion
 * prefers the later section for the same reason.
 */
export const findCitationPassage = ({
  blocks,
  citationText,
  sectionText,
}: FindCitationPassageOptions): CitationPassageMatch | null => {
  const spans = locateCitationSpans({
    blocks,
    citations: [{ citationText }],
  });
  let latest: CitationPassageMatch | null = null;
  let classified: CitationPassageMatch | null = null;
  // Blocks, not occurrences: two mentions inside one block are one paragraph,
  // so only a second carrying block makes the paragraph a choice.
  let carryingBlocks = 0;
  for (const block of blocks) {
    const hit = spans[block.id]?.at(0);
    if (hit === undefined || !hasBlockInlines(block)) {
      continue;
    }
    const text = plainTextOf(block.inlines);
    carryingBlocks += 1;
    latest = {
      anchorId: block.anchorId,
      blockId: block.id,
      end: hit.end,
      mention: "latest_of_several",
      start: hit.start,
      text,
    };
    if (
      classified === null &&
      sectionText !== undefined &&
      text.length > 0 &&
      sectionText.includes(text)
    ) {
      classified = { ...latest, mention: "classified_section" };
    }
  }
  const chosen = classified ?? latest;
  if (chosen === null) {
    return null;
  }
  return carryingBlocks === 1 ? { ...chosen, mention: "sole" } : chosen;
};
