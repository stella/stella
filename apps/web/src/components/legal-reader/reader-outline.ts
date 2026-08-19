import type { Block, HeadingBlock } from "@stll/legal-ast/document-ast";
import { stripDiacritics } from "@stll/text-normalize";
import type { OutlineItem } from "@stll/ui/components/outline-rail";

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
 * Depth from which a statute outline starts folded. The top two container
 * tiers stay open as the map of the act; everything under them is one entry
 * per section, which is thousands of rows for a code, so it unfolds along the
 * chain the reader is actually in.
 */
export const STATUTE_OUTLINE_COLLAPSE_LEVEL = 2;

/**
 * The two lines a publisher states for one heading: the designation that
 * names the division, and the title that says what it contains. They arrive
 * as one heading split by a line break, in whichever order the parser read
 * them, so the first line leads and the second annotates.
 */
type HeadingLines = {
  label: string;
  secondary: string | undefined;
};

const headingLines = (block: HeadingBlock): HeadingLines | null => {
  const lines = inlinesToPlainText(block.inlines)
    .split("\n")
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
      .sort((a, b) => a - b)
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
      label: lines.label,
      level: depth,
      ...(lines.secondary === undefined ? {} : { meta: lines.secondary }),
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
} as const;

export type ProvisionUnit =
  (typeof PROVISION_UNITS)[keyof typeof PROVISION_UNITS];

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

/** Fold used for designation comparison and outline filtering. */
const foldForMatch = (value: string): string =>
  stripDiacritics(value).toLowerCase();

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

    return { ...item, label: `${item.label} (${spanOf(first, last)})` };
  });

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
 * What the reader typed into the rail's jump field.
 *
 * A designation is a jump (there is one place `§ 10` can mean), anything
 * else narrows the outline. Kept as a union rather than a string plus flags
 * so a caller has to handle the empty field it starts in.
 */
export type OutlineJump =
  | { type: "empty" }
  | { type: "filter"; text: string }
  | { type: "provision"; number: string; unit: ProvisionUnit };

export const parseOutlineJump = (raw: string): OutlineJump => {
  const trimmed = raw.trim();

  if (trimmed.length === 0) {
    return { type: "empty" };
  }

  const designation = parseProvisionDesignation(trimmed);

  if (designation === null) {
    return { type: "filter", text: trimmed };
  }

  return {
    number: designation.number,
    type: "provision",
    unit: designation.unit,
  };
};

/** The outline entry a designation addresses, or null when the act has none. */
export const findProvisionAnchorId = (
  items: readonly OutlineItem[],
  jump: OutlineJump,
): string | null => {
  if (jump.type !== "provision") {
    return null;
  }

  const match = items.find((item) => {
    const designation = parseProvisionDesignation(item.label);

    return (
      designation !== null &&
      designation.unit === jump.unit &&
      foldForMatch(designation.number) === foldForMatch(jump.number)
    );
  });

  return match?.id ?? null;
};

/**
 * Narrow the outline to the entries matching `text`, keeping the ancestors
 * of every match. The rail nests by the level of the entries it is handed,
 * so dropping a matched entry's parents would re-root it under whatever
 * shallower entry happened to survive.
 */
export const filterOutlineItems = (
  items: readonly OutlineItem[],
  jump: OutlineJump,
): OutlineItem[] => {
  if (jump.type === "empty") {
    return [...items];
  }

  const needle = foldForMatch(jump.type === "filter" ? jump.text : jump.number);
  const kept = new Set<number>();

  for (const [index, item] of items.entries()) {
    const haystack = foldForMatch(`${item.label} ${item.meta ?? ""}`);

    if (!haystack.includes(needle)) {
      continue;
    }

    kept.add(index);

    // Walk back to the root the same way the rail nests: a parent is the
    // nearest preceding entry at a shallower level.
    let level = item.level;

    for (let ancestor = index - 1; ancestor >= 0 && level > 0; ancestor -= 1) {
      const candidate = items[ancestor];

      if (candidate !== undefined && candidate.level < level) {
        kept.add(ancestor);
        level = candidate.level;
      }
    }
  }

  return items.filter((_item, index) => kept.has(index));
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
