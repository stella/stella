import { withInferredCzechSignatureRoles } from "@stll/legal-ast/czech-document-roles";
import {
  hasInlineChildren,
  resolveDocumentAnchor,
} from "@stll/legal-ast/document-ast";
import type {
  Block,
  HeadingBlock,
  HeadingLevel,
  Inline,
  ParagraphBlock,
  ParagraphListDepth,
} from "@stll/legal-ast/document-ast";

import {
  parseProvisionDesignation,
  statuteOutlineFromHeadings,
} from "@/components/legal-reader/reader-outline";

export type StatuteMasthead = {
  anchorId: string;
  citation: string;
  date: string | null;
  instrument: string;
  issuer: string | null;
  title: string;
};

export type PreparedStatuteReader = {
  blocks: Block[];
  masthead: StatuteMasthead | null;
};

type ProvisionCitationCount = {
  anchor: string;
  decisionCount: number;
};

/**
 * Citation extraction stores the local provision id, while publisher ASTs
 * may namespace that id below an attachment. Resolve through the same legal
 * AST rule as deep links, then key the UI by the block it actually renders.
 */
export const provisionCitationCountByBlockAnchor = (
  blocks: readonly Block[],
  counts: readonly ProvisionCitationCount[],
): ReadonlyMap<string, number> => {
  const byAnchor = new Map<string, number>();
  for (const count of counts) {
    const resolved = resolveDocumentAnchor(blocks, count.anchor);
    if (resolved !== null) {
      byAnchor.set(resolved.anchorId, count.decisionCount);
    }
  }
  return byAnchor;
};

/**
 * The provision each block sits in, by the block's own anchor: the
 * designation of the nearest preceding provision heading, as the document
 * prints it. A quotation carries this as its locator, so a citation names the
 * provision rather than the whole act. Blocks before the first provision (a
 * masthead, a preamble) sit in none and are absent.
 */
export const provisionByBlockAnchor = (
  blocks: readonly Block[],
): ReadonlyMap<string, string> => {
  const byAnchor = new Map<string, string>();
  let current: string | null = null;
  for (const block of blocks) {
    if (block.type === "heading") {
      const designation = parseProvisionDesignation(block.plainText);
      if (designation !== null) {
        current = `${designation.marker} ${designation.number}`.trim();
      }
    }
    if (current !== null) {
      byAnchor.set(block.anchorId, current);
    }
  }
  return byAnchor;
};

const asIntroParagraph = (block: Block): Block => {
  if (block.type !== "heading") {
    return block;
  }

  return {
    anchorId: block.anchorId,
    id: block.id,
    inlines: block.inlines,
    plainText: block.plainText,
    role: "intro",
    type: "paragraph",
  } satisfies ParagraphBlock;
};

const STATUTE_CITATION_RE = /^\s*(\d+\/\d{4}\s+[^\s,]+)/u;
const SOURCE_NUMBER_RE = /^\s*\d+\s+/u;
const CZECH_DATE_LINE_RE = /\bze dne\s+\d{1,2}\.\s+\p{L}+\s+\d{4},?/iu;

type MastheadExtraction = {
  masthead: StatuteMasthead | null;
  sourceBlockIds: readonly string[];
};

/**
 * e-Sbírka flattens a visual masthead into one or two title headings. Split
 * only that publisher front matter back into its semantic lines; the source
 * blocks remain the authority for the words, while the work title supplies
 * the complete official citation omitted by the flattened heading.
 */
const extractStatuteMasthead = (
  blocks: readonly Block[],
  statuteTitle: string,
  firstStructuralHeadingIndex: number,
): MastheadExtraction => {
  const frontMatterEnd =
    firstStructuralHeadingIndex < 0
      ? blocks.length
      : firstStructuralHeadingIndex;
  const titleEntries = blocks
    .slice(0, frontMatterEnd)
    .map((block, index) => ({ block, index }))
    .filter(
      (entry) =>
        entry.block.type === "heading" && entry.block.role === "decision-title",
    );
  const firstTitle = titleEntries.at(0);
  const lastTitle = titleEntries.at(-1);
  const citation = STATUTE_CITATION_RE.exec(statuteTitle)?.at(1)?.trim();
  if (
    firstTitle === undefined ||
    lastTitle === undefined ||
    citation === undefined
  ) {
    return { masthead: null, sourceBlockIds: [] };
  }

  const titleText = titleEntries
    .map(({ block }) => block.plainText.trim())
    .join(" ");
  const dateMatch = CZECH_DATE_LINE_RE.exec(titleText);
  if (dateMatch === null) {
    return { masthead: null, sourceBlockIds: [] };
  }
  const firstTitleWithoutNumber = firstTitle.block.plainText
    .replace(SOURCE_NUMBER_RE, "")
    .trim();
  const dateStart = firstTitleWithoutNumber.search(CZECH_DATE_LINE_RE);
  const instrument = firstTitleWithoutNumber
    .slice(0, dateStart < 0 ? undefined : dateStart)
    .trim();
  if (instrument === "") {
    return { masthead: null, sourceBlockIds: [] };
  }

  const titleFromSource = titleText
    .slice(dateMatch.index + dateMatch[0].length)
    .trim();
  const titleFromMetadata = statuteTitle
    .slice(citation.length)
    .replace(/^,?\s*/u, "");
  const title = titleFromSource === "" ? titleFromMetadata : titleFromSource;
  if (title === "") {
    return { masthead: null, sourceBlockIds: [] };
  }

  const issuerEntries =
    titleEntries.length < 2
      ? []
      : blocks
          .slice(firstTitle.index + 1, lastTitle.index)
          .filter(
            (block): block is ParagraphBlock => block.type === "paragraph",
          );
  const issuer = issuerEntries
    .map((block) => block.plainText.trim())
    .filter((text) => text !== "")
    .join(" ");

  return {
    masthead: {
      anchorId: firstTitle.block.anchorId,
      citation,
      date: dateMatch[0].replace(/,$/u, ""),
      instrument,
      issuer: issuer === "" ? null : issuer,
      title,
    },
    sourceBlockIds: [
      ...titleEntries.map(({ block }) => block.id),
      ...issuerEntries.map((block) => block.id),
    ],
  };
};

const FOOTNOTE_ANCHOR_RE = /^ppc_(\d+)$/u;

type FootnoteReference = {
  label: string;
  start: number;
  text: string;
};

const isAsciiDigit = (character: string | undefined): boolean =>
  character !== undefined && character >= "0" && character <= "9";

const footnoteReferencesIn = (text: string): FootnoteReference[] => {
  const references: FootnoteReference[] = [];
  let start = 0;
  while (start < text.length) {
    if (!isAsciiDigit(text.at(start))) {
      start += 1;
      continue;
    }
    let end = start + 1;
    while (isAsciiDigit(text.at(end))) {
      end += 1;
    }
    if (text.at(end) === ")") {
      references.push({
        label: text.slice(start, end),
        start,
        text: text.slice(start, end + 1),
      });
    }
    start = end + 1;
  }
  return references;
};

const noteLabelsFrom = (blocks: readonly Block[]): Set<string> => {
  const labels = new Set<string>();
  for (const block of blocks) {
    if (block.type !== "paragraph") {
      continue;
    }
    const label = FOOTNOTE_ANCHOR_RE.exec(block.anchorId)?.at(1);
    if (
      label !== undefined &&
      block.plainText.trimStart().startsWith(`${label})`)
    ) {
      labels.add(label);
    }
  }
  return labels;
};

const textInline = (text: string, anonymized: true | undefined): Inline => ({
  ...(anonymized === true ? { anonymized } : {}),
  text,
  type: "text",
});

/** A printed `2)` glued to the preceding word is a note reference only when
 * this document actually carries note `ppc_2`. Parenthesized list numbers and
 * unmatched markers remain untouched. */
const linkFootnoteMarkersInText = (
  inline: Extract<Inline, { type: "text" }>,
  noteLabels: ReadonlySet<string>,
): Inline[] => {
  const inlines: Inline[] = [];
  let cursor = 0;

  for (const reference of footnoteReferencesIn(inline.text)) {
    const { label, start } = reference;
    const preceding = start > 0 ? inline.text.at(start - 1) : undefined;
    if (
      !noteLabels.has(label) ||
      preceding === undefined ||
      /[\s(]/u.test(preceding)
    ) {
      continue;
    }

    if (start > cursor) {
      inlines.push(
        textInline(inline.text.slice(cursor, start), inline.anonymized),
      );
    }
    inlines.push({
      children: [textInline(reference.text, inline.anonymized)],
      href: `#ppc_${label}`,
      type: "link",
    });
    cursor = start + reference.text.length;
  }

  if (cursor === 0) {
    return [inline];
  }
  if (cursor < inline.text.length) {
    inlines.push(textInline(inline.text.slice(cursor), inline.anonymized));
  }
  return inlines;
};

const linkFootnoteMarkers = (
  inline: Inline,
  noteLabels: ReadonlySet<string>,
): Inline[] => {
  if (inline.type === "text") {
    return linkFootnoteMarkersInText(inline, noteLabels);
  }
  if (
    inline.type === "link" ||
    inline.type === "citation" ||
    inline.type === "superscript" ||
    inline.type === "subscript" ||
    !hasInlineChildren(inline)
  ) {
    return [inline];
  }

  return [
    {
      ...inline,
      children: inline.children.flatMap((child) =>
        linkFootnoteMarkers(child, noteLabels),
      ),
    },
  ];
};

const withLinkedFootnotes = (blocks: readonly Block[]): Block[] => {
  const noteLabels = noteLabelsFrom(blocks);
  if (noteLabels.size === 0) {
    return [...blocks];
  }

  return blocks.map((block) => {
    if (block.type !== "heading" && block.type !== "paragraph") {
      return block;
    }

    const noteLabel = FOOTNOTE_ANCHOR_RE.exec(block.anchorId)?.at(1);
    if (block.type === "paragraph" && noteLabel !== undefined) {
      return {
        ...block,
        note: {
          label: noteLabel,
          noteId: block.anchorId,
          type: "footnote",
        },
      };
    }

    return {
      ...block,
      inlines: block.inlines.flatMap((inline) =>
        linkFootnoteMarkers(inline, noteLabels),
      ),
    };
  });
};

const listDepthFromAnchor = (anchorId: string): ParagraphListDepth | null => {
  if (/(?:^|-)bod_[^-]+/u.test(anchorId)) {
    return 2;
  }
  if (/(?:^|-)pism_[^-]+/u.test(anchorId)) {
    return 1;
  }
  return null;
};

/** e-Sbírka stores a flat block stream, but its stable anchor path retains
 * the list hierarchy: `pism` is nested once and `bod` twice. */
const withStatuteListDepth = (blocks: readonly Block[]): Block[] =>
  blocks.map((block) => {
    if (block.type !== "paragraph" || block.listDepth !== undefined) {
      return block;
    }
    const listDepth = listDepthFromAnchor(block.anchorId);
    return listDepth === null ? block : { ...block, listDepth };
  });

export type PreviewBlock = { anchorId: string; id: string; text: string };

/**
 * A provision read's block as a paragraph the reader can render. The read
 * carries text without kinds or inline formatting; its anchor still states
 * the list nesting, so the letters and points indent as the reader sets them.
 */
export const paragraphFromPreview = ({
  anchorId,
  id,
  text,
}: PreviewBlock): ParagraphBlock => {
  const listDepth = listDepthFromAnchor(anchorId);

  return {
    anchorId,
    id,
    inlines: [{ text, type: "text" }],
    plainText: text,
    type: "paragraph",
    ...(listDepth === null ? {} : { listDepth }),
  };
};

export type PreviewHeading = PreviewBlock & { level: HeadingLevel };

/**
 * A provision read's own heading as a heading the reader can render. Its
 * lines are the heading's line breaks, so the designation keeps a row of its
 * own the way the reader sets it.
 */
export const headingFromPreview = ({
  anchorId,
  id,
  level,
  text,
}: PreviewHeading): HeadingBlock => ({
  anchorId,
  id,
  inlines: text
    .split("\n")
    .flatMap((line, index): Inline[] =>
      index === 0
        ? [{ text: line, type: "text" }]
        : [{ type: "line-break" }, { text: line, type: "text" }],
    ),
  level,
  plainText: text,
  type: "heading",
});

type PrepareStatuteReaderOptions = {
  blocks: readonly Block[];
  statuteTitle: string;
};

/**
 * Reader-only repair for legacy statute ASTs. Publisher mastheads become one
 * structured introduction, preamble clauses stop masquerading as headings,
 * source-shaped footnotes regain note links, and signature inference uses the
 * same legal-AST primitive as case law.
 */
export const prepareStatuteReader = ({
  blocks,
  statuteTitle,
}: PrepareStatuteReaderOptions): PreparedStatuteReader => {
  const structuralHeadingIds = new Set(
    statuteOutlineFromHeadings(blocks).map(({ id }) => id),
  );
  const firstStructuralHeadingIndex = blocks.findIndex(
    (block) =>
      block.type === "heading" && structuralHeadingIds.has(block.anchorId),
  );
  const { masthead, sourceBlockIds } = extractStatuteMasthead(
    blocks,
    statuteTitle,
    firstStructuralHeadingIndex,
  );
  const mastheadBlockIds = new Set(sourceBlockIds);
  const withoutMasthead = blocks.filter(
    (block) => !mastheadBlockIds.has(block.id),
  );
  const repairedStructuralIndex = withoutMasthead.findIndex(
    (block) =>
      block.type === "heading" && structuralHeadingIds.has(block.anchorId),
  );
  const preambleRepaired = withoutMasthead.map((block, index) =>
    repairedStructuralIndex !== -1 &&
    index < repairedStructuralIndex &&
    block.type === "heading" &&
    !structuralHeadingIds.has(block.anchorId)
      ? asIntroParagraph(block)
      : block,
  );

  return {
    blocks: withLinkedFootnotes(
      withStatuteListDepth(withInferredCzechSignatureRoles(preambleRepaired)),
    ),
    masthead,
  };
};
