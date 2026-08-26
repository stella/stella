/**
 * The clause map under the results header: where in the document a run's
 * findings actually sit.
 *
 * The document's own block order is the only honest x-axis. It comes from the
 * live editor's `createAIEditSnapshot()` — the same walk the server extractor
 * uses to mint citation block ids — so a finding's `citations[0].blockId`
 * indexes straight into it without a mapping table.
 *
 * Everything here is pure: the strip is a picture of two lists, and a picture
 * that cannot be tested is a picture nobody can trust.
 */

/** One block of the reviewed document, projected from a folio snapshot. */
export type DealStripBlock = {
  id: string;
  /** 1-based heading depth, or `null` when the block is body text. */
  headingLevel: number | null;
  /** Folio's `displayLabel`: a list marker (`1.`, `(a)`) for a numbered
   *  block, otherwise the heading style id, which is not a clause number. */
  displayLabel: string | null;
  text: string;
};

/** One finding, reduced to what the strip paints. */
export type DealStripFinding = {
  id: string;
  title: string;
  /** The first cited block of the reviewed document, or `null` when the
   *  finding cites none (a missing clause has nothing to point at). */
  blockId: string | null;
  /** Painted in the strip's single accent rather than neutral ink. */
  accent: boolean;
};

/** One finding's tick inside a clause. */
export type DealStripMark = {
  findingId: string;
  title: string;
  blockId: string;
  /** Where along the whole document the cited block sits, `0`–`1`. */
  offset: number;
  accent: boolean;
};

export type DealStripSegment = {
  /** The id of the block the clause starts at; stable across re-reads. */
  key: string;
  label: string;
  /** Where the clause starts and ends along the document, `0`–`1`. */
  start: number;
  end: number;
  marks: DealStripMark[];
  /** How crowded this clause is against the busiest one, `0`–`1`. Opacity,
   *  not colour: several findings on one clause is the signal. */
  density: number;
};

export type DealStrip = {
  segments: DealStripSegment[];
  /** Findings whose cited block is not in the document any more, plus every
   *  finding that cites nothing. They have no place on the strip. */
  unplacedFindingIds: string[];
};

// TODO(i18n): English until the review surface is localized as a whole.
/** Everything before the first top-level clause: title, parties, recitals. */
const PREAMBLE_SEGMENT_LABEL = "Preamble";
/** A document folio found no headings in: one clause, the whole of it. */
const UNSECTIONED_SEGMENT_LABEL = "Document";

/** Folio hands back the heading style id as `displayLabel` when a heading
 *  carries no list marker. `Heading2` is not a clause number. */
const HEADING_STYLE_LABEL = /^heading/iu;

/** A clause number a drafter typed into the heading itself: `4`, `4.2`,
 *  `4.2.1`, optionally closed by `.` or `)`. */
const LEADING_CLAUSE_NUMBER = /^\s*(?<number>\d+(?:\.\d+)*)\s*[.)]?\s+/u;

const clauseNumber = (block: DealStripBlock): string | null => {
  const { displayLabel } = block;
  if (displayLabel !== null && !HEADING_STYLE_LABEL.test(displayLabel)) {
    return displayLabel;
  }
  return LEADING_CLAUSE_NUMBER.exec(block.text)?.groups?.["number"] ?? null;
};

/**
 * What one clause reads as on hover: its number and its heading, with the
 * number written once even when the drafter typed it into the heading text.
 */
export const dealStripSegmentLabel = (block: DealStripBlock): string => {
  const number = clauseNumber(block);
  const title = block.text.replace(LEADING_CLAUSE_NUMBER, "").trim();
  if (number === null) {
    return title.length === 0 ? UNSECTIONED_SEGMENT_LABEL : title;
  }
  return title.length === 0 ? number : `${number} ${title}`;
};

type SegmentDraft = {
  key: string;
  label: string;
  startIndex: number;
  endIndex: number;
  marks: DealStripMark[];
};

/**
 * Where the clauses begin. The shallowest heading depth the document actually
 * uses is its top level, so a contract whose clauses are `Heading2` segments
 * the same way as one whose clauses are `Heading1`.
 */
const topLevelHeadingStarts = (blocks: readonly DealStripBlock[]): number[] => {
  let topLevel: number | null = null;
  for (const block of blocks) {
    const level = block.headingLevel;
    if (level !== null && (topLevel === null || level < topLevel)) {
      topLevel = level;
    }
  }
  if (topLevel === null) {
    return [];
  }
  const starts: number[] = [];
  for (const [index, block] of blocks.entries()) {
    if (block.headingLevel === topLevel) {
      starts.push(index);
    }
  }
  return starts;
};

const draftSegments = (blocks: readonly DealStripBlock[]): SegmentDraft[] => {
  const starts = topLevelHeadingStarts(blocks);
  const drafts: SegmentDraft[] = [];
  const leadIn = starts.at(0) ?? blocks.length;
  if (leadIn > 0) {
    const first = blocks[0];
    drafts.push({
      key: first === undefined ? "lead-in" : first.id,
      label:
        starts.length === 0
          ? UNSECTIONED_SEGMENT_LABEL
          : PREAMBLE_SEGMENT_LABEL,
      startIndex: 0,
      endIndex: leadIn,
      marks: [],
    });
  }
  for (const [ordinal, startIndex] of starts.entries()) {
    const heading = blocks[startIndex];
    if (heading === undefined) {
      continue;
    }
    drafts.push({
      key: heading.id,
      label: dealStripSegmentLabel(heading),
      startIndex,
      endIndex: starts[ordinal + 1] ?? blocks.length,
      marks: [],
    });
  }
  return drafts;
};

type BuildDealStripArgs = {
  blocks: readonly DealStripBlock[];
  findings: readonly DealStripFinding[];
};

export const buildDealStrip = ({
  blocks,
  findings,
}: BuildDealStripArgs): DealStrip => {
  const total = blocks.length;
  if (total === 0) {
    return {
      segments: [],
      unplacedFindingIds: findings.map((finding) => finding.id),
    };
  }

  const indexById = new Map(blocks.map((block, index) => [block.id, index]));
  const drafts = draftSegments(blocks);
  const unplacedFindingIds: string[] = [];

  for (const finding of findings) {
    const index =
      finding.blockId === null ? undefined : indexById.get(finding.blockId);
    // A finding with no citation, or one whose clause was edited away, has no
    // point on the axis. Saying so is the honest answer; dropping it onto
    // block zero would draw a mark at a clause it does not belong to.
    if (index === undefined || finding.blockId === null) {
      unplacedFindingIds.push(finding.id);
      continue;
    }
    const draft = drafts.find(
      (candidate) =>
        index >= candidate.startIndex && index < candidate.endIndex,
    );
    if (draft === undefined) {
      unplacedFindingIds.push(finding.id);
      continue;
    }
    draft.marks.push({
      findingId: finding.id,
      title: finding.title,
      blockId: finding.blockId,
      // Mid-block, so the first and last blocks of a document sit inside the
      // strip rather than on its edges.
      offset: (index + 0.5) / total,
      accent: finding.accent,
    });
  }

  let busiest = 0;
  for (const draft of drafts) {
    busiest = Math.max(busiest, draft.marks.length);
  }
  return {
    segments: drafts.map((draft) => ({
      key: draft.key,
      label: draft.label,
      start: draft.startIndex / total,
      end: draft.endIndex / total,
      marks: draft.marks,
      density: busiest === 0 ? 0 : draft.marks.length / busiest,
    })),
    unplacedFindingIds,
  };
};
