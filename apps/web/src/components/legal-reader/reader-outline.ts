import type { Block, HeadingBlock } from "@stll/legal-ast/document-ast";
import type { ProvisionUnit } from "@stll/legal-ast/provision-reference";
import type { OutlineItem } from "@stll/ui/outline-rail";

import { inlinesToPlainText } from "@/components/legal-reader/document-ast-text";

/**
 * Outline over a document's own headings, for the shared rail.
 *
 * The rail nests by `level`, and it wants a dense depth rather than the AST's
 * 1..6: a document that uses only levels 1, 2 and 6 has three tiers, not six,
 * and indenting the third one five steps in would read as a broken tree. The
 * levels present are therefore mapped onto 0, 1, 2 in order.
 */

/**
 * Depth from which a statute outline starts folded. Only the act's top tier
 * (its parts) stays open, the way a printed table of contents opens: what is
 * under it is thousands of rows for a code, and it unfolds along the chain
 * the reader is actually in.
 */
export const STATUTE_OUTLINE_COLLAPSE_LEVEL = 1;

/**
 * The two lines a publisher states for one heading: the designation that
 * names the division, and the title that says what it contains. They arrive
 * as one heading split by a line break, in whichever order the parser read
 * them; the designation leads either way, because it is what the outline is
 * read by and what a jump addresses.
 */
type HeadingLines = {
  label: string;
  secondary: string | undefined;
};

/**
 * A heading's lines as the publisher broke them, unfiltered: an index here
 * is the number of breaks the renderer counts to reach the same line.
 */
const headingTextLines = (block: HeadingBlock): string[] =>
  inlinesToPlainText(block.inlines).split("\n");

const ROMAN_NUMERAL_RE = /^[IVXLCDM]+$/u;

/**
 * A heading the publisher set in capitals, in sentence case: the outline
 * lists hundreds of these in a narrow column, where capitals read heavier
 * than the hierarchy they mark and truncate sooner. Mixed-case headings pass
 * through untouched, and a Roman numeral keeps its capitals because it is
 * a number, not a word.
 */
export const headingCase = (text: string): string => {
  if (text !== text.toLocaleUpperCase() || !/\p{L}/u.test(text)) {
    return text;
  }

  return text
    .split(" ")
    .map((word, index) => {
      if (ROMAN_NUMERAL_RE.test(word)) {
        return word;
      }

      const lower = word.toLocaleLowerCase();

      return index === 0
        ? lower.charAt(0).toLocaleUpperCase() + lower.slice(1)
        : lower;
    })
    .join(" ");
};

const headingLines = (block: HeadingBlock): HeadingLines | null => {
  const raw = headingTextLines(block);
  const designationIndex = provisionHeadingLine(block)?.index ?? -1;
  const designation = raw[designationIndex];
  const ordered =
    designation === undefined
      ? raw
      : [
          designation,
          ...raw.filter((_line, index) => index !== designationIndex),
        ];
  const lines = ordered
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const [label, ...rest] = lines;

  if (label === undefined) {
    return null;
  }

  const secondary = rest.join(" ");

  return { label, secondary: secondary.length > 0 ? secondary : undefined };
};

export const outlineFromHeadings = (
  blocks: readonly Block[],
): OutlineItem[] => {
  const headings = blocks.filter((block) => block.type === "heading");
  const depthByLevel = new Map(
    [...new Set(headings.map((heading) => heading.level))]
      .toSorted((a, b) => a - b)
      .map((level, depth) => [level, depth]),
  );
  const items: OutlineItem[] = [];

  for (const heading of headings) {
    const lines = headingLines(heading);
    const depth = depthByLevel.get(heading.level);

    if (lines === null || depth === undefined) {
      continue;
    }

    items.push({
      id: heading.anchorId,
      label: headingCase(lines.label),
      level: depth,
      ...(lines.secondary === undefined
        ? {}
        : { title: headingCase(lines.secondary) }),
    });
  }

  return items;
};

/**
 * The two designations a provision is published under across the
 * jurisdictions in the corpus: the section sign (Czech, Slovak, German,
 * Hungarian acts) and the article (Polish, Spanish, French, EU acts). They
 * are separate kinds, not spellings of one: an act can number both.
 */
export const PROVISION_UNITS = {
  article: "article",
  section: "section",
} as const satisfies Record<ProvisionUnit, ProvisionUnit>;

export type ProvisionDesignation = {
  /** The designation as the document prints it (`§`, `Čl.`, `Art.`). */
  marker: string;
  /** Digits plus any letter suffix, as printed: `265b`, `1a`. */
  number: string;
  unit: ProvisionUnit;
};

/**
 * A provision designation opening a heading: `§ 265b`, `§265b`, `Čl. 10`,
 * `Art. 5a`, `par. 3`. Anchored at the start because that is where a
 * publisher puts it; whatever follows (a title on the same line) is not
 * part of the designation.
 */
const PROVISION_DESIGNATION_RE = /^(§|[cč]l|art|par)\.?\s*(\d+[a-z]*)/iu;

/** `par.` is the section sign spelled out, not an article. */
const isSectionMarker = (marker: string): boolean =>
  marker.startsWith("§") || marker.toLowerCase().startsWith("par");

/**
 * The provision a heading opens, or null when the heading is a container
 * (`ČÁST PRVNÍ`, `HLAVA I`) or plain prose.
 */
export const parseProvisionDesignation = (
  label: string,
): ProvisionDesignation | null => {
  const trimmed = label.trim();
  const match = PROVISION_DESIGNATION_RE.exec(trimmed);
  const designation = match?.[0];
  const number = match?.[2];

  if (designation === undefined || number === undefined) {
    return null;
  }

  // The designation minus its number, as printed: `§`, `Čl.`, `Art.`.
  const marker = designation.slice(0, -number.length).trim();

  return {
    marker,
    number,
    unit: isSectionMarker(marker)
      ? PROVISION_UNITS.section
      : PROVISION_UNITS.article,
  };
};

/** The designation a heading opens a provision with, and where it is stated. */
export type ProvisionHeadingLine = {
  designation: ProvisionDesignation;
  /** Index of the line among the heading's lines, in document order. */
  index: number;
  /** The line as printed: what the provision is named by. */
  text: string;
};

/**
 * The provision a heading opens, wherever the publisher states it.
 *
 * A section is published three ways — the designation alone (`§ 56`), the
 * designation above its title, or the title above the designation
 * (`Omezení svéprávnosti` / `§ 55`) — and is the same citable unit in all
 * three. Searching the heading's lines rather than only the first is what
 * keeps one section from reading as a container because of line order.
 */
export const provisionHeadingLine = (
  block: HeadingBlock,
): ProvisionHeadingLine | null => {
  for (const [index, line] of headingTextLines(block).entries()) {
    const designation = parseProvisionDesignation(line);

    if (designation !== null) {
      return { designation, index, text: line.trim() };
    }
  }

  return null;
};

/** En dash: a range of provisions is a range, not a subtraction. */
const RANGE_DASH = "–";

/**
 * Descendants of the entry at `index`: every following entry nested under
 * it, which is exactly the run before the next entry at its level or above.
 */
const descendantsOf = (
  items: readonly OutlineItem[],
  index: number,
): OutlineItem[] => {
  const parent = items[index];

  if (parent === undefined) {
    return [];
  }

  const descendants: OutlineItem[] = [];

  for (const item of items.slice(index + 1)) {
    if (item.level <= parent.level) {
      break;
    }
    descendants.push(item);
  }

  return descendants;
};

/**
 * Annotate each container with the span of provisions it holds, the way a
 * printed act's table of contents does: `HLAVA I (§ 976–978)`.
 *
 * The span is stated in document order, not numeric order, because that is
 * the order the act is read in and the only one that survives a suffixed
 * designation (`§ 265a` sits between `§ 265` and `§ 266`). Entries that are
 * themselves provisions are left alone: a section is not a range.
 */
export const withProvisionRanges = (
  items: readonly OutlineItem[],
): OutlineItem[] =>
  items.map((item, index) => {
    if (parseProvisionDesignation(item.label) !== null) {
      return item;
    }

    const provisions = descendantsOf(items, index)
      .map((descendant) => parseProvisionDesignation(descendant.label))
      .filter((designation) => designation !== null);

    const first = provisions.at(0);
    const last = provisions.at(-1);

    if (first === undefined || last === undefined) {
      return item;
    }

    return { ...item, meta: spanOf(first, last) };
  });

/**
 * A statute's navigable structure: provisions and the containers that own
 * them. Publishers sometimes promote mastheads and every preamble clause to
 * headings; those blocks remain visible in the document, but do not become a
 * flat list of prose in its table of contents.
 */
export const statuteOutlineFromHeadings = (
  blocks: readonly Block[],
): OutlineItem[] =>
  withProvisionRanges(outlineFromHeadings(blocks)).filter(
    (item) =>
      parseProvisionDesignation(item.label) !== null || item.meta !== undefined,
  );

/**
 * The span between two designations. A container that numbers sections and
 * articles alike states the marker at both ends: `§ 1` through `Art. 2` is
 * not two sections, and dropping the second marker would say it was.
 */
const spanOf = (
  first: ProvisionDesignation,
  last: ProvisionDesignation,
): string => {
  if (first.unit !== last.unit) {
    return `${first.marker} ${first.number}${RANGE_DASH}${last.marker} ${last.number}`;
  }

  return first.number === last.number
    ? `${first.marker} ${first.number}`
    : `${first.marker} ${first.number}${RANGE_DASH}${last.number}`;
};

/**
 * The members of a scroll container an anchor jump needs. Narrower than
 * `HTMLElement` so the arithmetic below can be exercised without a DOM.
 */
type ClientTop = { top: number };

export type AnchorScrollContainer = {
  querySelector: (
    selector: string,
  ) => { getBoundingClientRect: () => ClientTop } | null;
  getBoundingClientRect: () => ClientTop;
  scrollTop: number;
  scrollHeight: number;
  scrollTo: (options: { top: number; behavior: ScrollBehavior }) => void;
};

const offsetWithin = (
  anchorId: string,
  container: AnchorScrollContainer,
): number | null => {
  const target = container.querySelector(`#${CSS.escape(anchorId)}`);

  if (target === null) {
    return null;
  }

  return (
    target.getBoundingClientRect().top -
    container.getBoundingClientRect().top +
    container.scrollTop
  );
};

/** Vertical position of an anchored block, as the rail's 0-100 percentage. */
export const resolveAnchorPct = (
  anchorId: string,
  container: AnchorScrollContainer,
): number | null => {
  if (container.scrollHeight <= 0) {
    return null;
  }

  const top = offsetWithin(anchorId, container);

  return top === null
    ? null
    : Math.min(99, Math.max(1, (top / container.scrollHeight) * 100));
};

/**
 * Scroll an anchored block into view and put its anchor in the URL.
 *
 * The hash is set first and by assignment, not `replaceState`: it is what
 * makes `:target` fire and what the reader copies out of the address bar, so
 * a jump and a followed permalink leave the page in the same state. The
 * container scroll then overrides whatever the browser did with the hash.
 */
export const jumpToAnchor = (
  anchorId: string,
  container: AnchorScrollContainer,
): void => {
  const top = offsetWithin(anchorId, container);

  if (top === null) {
    return;
  }

  window.location.hash = anchorId;
  container.scrollTo({ top, behavior: "instant" });
};
