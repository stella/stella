/**
 * Which blocks one provision owns, and which of them a citation shows.
 *
 * The rule lives here rather than beside a reader because two runtimes apply
 * it to the same document: the API narrows a stored AST down to a preview
 * payload, and the statute reader narrows the document it already holds.
 */
import { panic } from "better-result";

import {
  resolveDocumentAnchor,
  resolveDocumentHeadingAnchor,
} from "./document-ast.js";
import type { Block, HeadingBlock } from "./document-ast.js";
import {
  anchorContinuesSubsection,
  anchorWithin,
  provisionAncestorAnchors,
  unfiledAnchor,
  wordingOwnerAnchor,
} from "./statute-anchor-scheme.js";
import type {
  StatuteAnchorNesting,
  StatuteAnchorScheme,
  StatuteBlocks,
} from "./statute-anchor-scheme.js";

const blocksOwnedByHeading = (
  blocks: readonly Block[],
  heading: HeadingBlock,
): Block[] | null => {
  const start = blocks.indexOf(heading);
  if (start === -1) {
    return null;
  }

  const owned: Block[] = [heading];
  for (const block of blocks.slice(start + 1)) {
    if (block.type === "heading" && block.level <= heading.level) {
      break;
    }
    owned.push(block);
  }
  return owned;
};

/**
 * The blocks a cited subdivision owns: itself, the subdivisions nested under
 * it and, for a subsection, the unnumbered wording that carries it on.
 *
 * Statute subdivisions are not headings, so their nesting lives in the anchor
 * path rather than in a level: `par_3-odst_2` owns `par_3-odst_2-pism_a`,
 * which in turn owns `par_3-odst_2-pism_d-bod_1`, as `paragraf-3.odsek-2`
 * owns `paragraf-3.odsek-2.pismeno-a`. Descendants follow their parent
 * contiguously, so the range ends at the first block that is neither — a
 * cited paragraph therefore runs from its number up to the next paragraph,
 * with its closing line, and a cited letter stops before that line.
 *
 * Unfiled wording (a bare `frag_…`) that sits between two blocks the cited
 * unit owns is the cited unit's own text, so the range runs through it rather
 * than ending there and dropping every block after it.
 */
export const blocksNestedUnder = <T extends Pick<Block, "anchorId">>(
  { blocks, scheme }: StatuteBlocks<T>,
  cited: T,
): T[] => {
  const start = blocks.indexOf(cited);
  if (start === -1) {
    return [cited];
  }

  const owns = (block: T) =>
    anchorWithin(scheme, {
      ancestor: cited.anchorId,
      anchor: block.anchorId,
    }) ||
    anchorContinuesSubsection(scheme, {
      anchor: block.anchorId,
      subsection: cited.anchorId,
    });

  const owned: T[] = [cited];
  let index = start + 1;
  while (index < blocks.length) {
    const block = blocks[index] ?? panic("Block index out of range");
    if (owns(block)) {
      owned.push(block);
      index += 1;
      continue;
    }
    if (!unfiledAnchor(scheme, block.anchorId)) {
      break;
    }
    // A run of unfiled wording belongs to the cited unit only when the unit
    // carries on after it.
    let end = index;
    while (
      end < blocks.length &&
      unfiledAnchor(scheme, (blocks[end] ?? panic("Block index")).anchorId)
    ) {
      end += 1;
    }
    const next = blocks[end];
    if (next === undefined || !owns(next)) {
      break;
    }
    owned.push(...blocks.slice(index, end));
    index = end;
  }
  return owned;
};

/** The complete block range owned by one provision heading. */
export const provisionBlocks = (
  statute: StatuteBlocks<Block>,
  anchorId: string,
): Block[] | null => {
  const heading = resolveDocumentHeadingAnchor(statute, anchorId);
  return heading === null
    ? null
    : blocksOwnedByHeading(statute.blocks, heading);
};

type ProvisionPreviewTarget = {
  provisionAnchorId: string;
  citedAnchorId: string | undefined;
};

/**
 * The narrowest truthful wording for a citation preview: the cited unit and
 * everything it owns. A cited paragraph shows its letters, their points and
 * its unnumbered wording, a cited letter shows its points, a cited point
 * shows itself, and a cited
 * nested heading keeps its owned text. A provision-level citation shows the
 * provision body.
 */
export const provisionPreviewBlocks = (
  statute: StatuteBlocks<Block>,
  { provisionAnchorId, citedAnchorId }: ProvisionPreviewTarget,
): Block[] | null => {
  const provision = provisionBlocks(statute, provisionAnchorId);
  if (provision === null) {
    return null;
  }

  const owned = { blocks: provision, scheme: statute.scheme };
  const cited = resolveDocumentAnchor(
    owned,
    citedAnchorId ?? provisionAnchorId,
  );
  if (cited === null || cited.anchorId === provision.at(0)?.anchorId) {
    return provision.slice(1);
  }
  if (cited.type !== "heading") {
    return blocksNestedUnder(owned, cited);
  }
  return blocksOwnedByHeading(provision, cited);
};

/**
 * The heading a cited subdivision belongs to: `par_90-odst_5` is filed, cited
 * and versioned under `par_90`, `s1983/a/1` under `s1983`. The separator is
 * the citing country's scheme's, because a section number may itself carry
 * another one (`s2000e-2/a`). A flat scheme files every anchor under itself.
 * The subdivision stays the highlight target.
 */
export const provisionHeadingAnchor = (
  anchor: string,
  nesting: StatuteAnchorNesting,
): string => {
  switch (nesting.type) {
    case "nested":
      return anchor.split(nesting.separator)[0] ?? anchor;
    case "flat":
      return anchor;
    default:
      nesting satisfies never;
      return panic("Unhandled statute anchor nesting");
  }
};

/**
 * The heading in a statute an anchor is nested under: the longest heading
 * anchor the anchor continues in the publisher's scheme. Read off the
 * document, for a reader that holds the statute but not the citation that
 * named the anchor. Null when the anchor continues no heading.
 */
export const enclosingHeadingAnchor = (
  { blocks, scheme }: StatuteBlocks<Block>,
  anchor: string,
): string | null => {
  let enclosing: string | null = null;
  for (const block of blocks) {
    if (
      block.type === "heading" &&
      anchorWithin(scheme, { ancestor: block.anchorId, anchor }) &&
      (enclosing === null || block.anchorId.length > enclosing.length)
    ) {
      enclosing = block.anchorId;
    }
  }
  return enclosing;
};

/**
 * The headings a provision sits under, outermost first, without the
 * provision's own heading: the part, title and division a reader needs to
 * place a section quoted out of its statute.
 */
export const provisionHeadingChain = (
  statute: StatuteBlocks<Block>,
  anchorId: string,
): HeadingBlock[] | null => {
  const heading = resolveDocumentHeadingAnchor(statute, anchorId);
  if (heading === null) {
    return null;
  }

  const { blocks } = statute;
  const start = blocks.indexOf(heading);
  if (start === -1) {
    return null;
  }

  const chain: HeadingBlock[] = [];
  let depth = heading.level;
  for (let index = start - 1; index >= 0 && depth > 1; index -= 1) {
    const block = blocks[index];
    if (block?.type !== "heading" || block.level >= depth) {
      continue;
    }
    chain.push(block);
    depth = block.level;
  }

  return chain.toReversed();
};

type UnfiledGoverningOptions = {
  provision: readonly Block[];
  scheme: StatuteAnchorScheme;
  inRange: ReadonlySet<Block>;
  rangeEnd: number;
  ancestors: ReadonlySet<string>;
};

/**
 * Bare `frag_…` wording, which states no owner, read by where it stands: a
 * run right after an ancestor's own block leads that ancestor in; a run
 * right after the cited unit's range, or after the last block an ancestor
 * owns, closes it.
 */
const unfiledGoverningWording = ({
  provision,
  scheme,
  inRange,
  rangeEnd,
  ancestors,
}: UnfiledGoverningOptions): Map<Block, GoverningWordingPosition> => {
  const governing = new Map<Block, GoverningWordingPosition>();
  const blockAt = (at: number) =>
    provision[at] ?? panic("Block index out of range");
  const unfiledOutsideRange = (block: Block) =>
    !inRange.has(block) && unfiledAnchor(scheme, block.anchorId);
  const withinAncestor = (block: Block, ancestor: string) =>
    block.anchorId === ancestor ||
    anchorWithin(scheme, { ancestor, anchor: block.anchorId });

  let index = 1;
  while (index < provision.length) {
    if (!unfiledOutsideRange(blockAt(index))) {
      index += 1;
      continue;
    }
    let end = index;
    while (end < provision.length && unfiledOutsideRange(blockAt(end))) {
      end += 1;
    }
    const before = blockAt(index - 1);
    const after = provision[end];
    const leadsIn =
      before === provision[0] ||
      (ancestors.has(before.anchorId) && before.type !== "heading");
    const closesCited = index - 1 === rangeEnd;
    const closesAncestor = [...ancestors].some(
      (ancestor) =>
        withinAncestor(before, ancestor) &&
        (after === undefined || !withinAncestor(after, ancestor)),
    );
    if (leadsIn || closesCited || closesAncestor) {
      for (const block of provision.slice(index, end)) {
        governing.set(block, leadsIn && !closesCited ? "lead-in" : "closing");
      }
    }
    index = end;
  }
  return governing;
};

/** Where governing wording sits against the unit it governs. */
export const GOVERNING_WORDING_POSITIONS = ["lead-in", "closing"] as const;

export type GoverningWordingPosition =
  (typeof GOVERNING_WORDING_POSITIONS)[number];

export type GoverningWording<T> = {
  block: T;
  position: GoverningWordingPosition;
};

type GoverningWordingTarget = {
  provisionAnchorId: string;
  citedAnchorId: string;
};

/**
 * The wording outside a cited subdivision that governs it: the lead-in of
 * every unit it is nested in (`(1) Přestupku se dopustí ten, kdo`, `Pro účely
 * tohoto zákona se rozumí`) and the closing text after their lists (`Pro
 * posouzení … není podstatná délka výkonu`). A read of one letter that
 * returned only the letter would state a rule its parent qualifies, so every
 * read of a subdivision carries this beside its own text, and no wording a
 * parent files around the cited unit is left out silently.
 *
 * Wording is matched to the units it governs by the path the publisher files
 * it under: an ancestor's own block, and unnumbered wording filed under an
 * ancestor (`par_5-frag_6062863`). Rows parsed before that filing existed
 * carry bare `frag_…` anchors, which state no owner; a run of them is read by
 * where it stands instead: right after an ancestor's own block it is that
 * ancestor's lead-in, right after the cited unit's range or after the last
 * block an ancestor owns it is closing text. Empty for a whole provision,
 * which already holds all of its wording.
 */
export const governingWording = (
  statute: StatuteBlocks<Block>,
  { provisionAnchorId, citedAnchorId }: GoverningWordingTarget,
): GoverningWording<Block>[] => {
  const provision = provisionBlocks(statute, provisionAnchorId);
  if (provision === null) {
    return [];
  }
  const owned = { blocks: provision, scheme: statute.scheme };
  const cited = resolveDocumentAnchor(owned, citedAnchorId);
  if (cited === null || cited.anchorId === provision.at(0)?.anchorId) {
    return [];
  }
  const range =
    cited.type === "heading"
      ? (blocksOwnedByHeading(provision, cited) ?? [cited])
      : blocksNestedUnder(owned, cited);
  const inRange = new Set<Block>(range);
  const citedAt = provision.indexOf(cited);
  const rangeEnd = citedAt + range.length - 1;
  const ancestors = new Set(
    provisionAncestorAnchors(statute.scheme, {
      anchor: cited.anchorId,
      provision: provisionAnchorId,
    }),
  );
  const { scheme } = statute;

  const governing = new Map<Block, GoverningWordingPosition>();
  const positionOf = (index: number): GoverningWordingPosition =>
    index < citedAt ? "lead-in" : "closing";

  for (const [index, block] of provision.entries()) {
    if (inRange.has(block) || block.type === "heading") {
      continue;
    }
    if (ancestors.has(block.anchorId)) {
      governing.set(block, "lead-in");
      continue;
    }
    const owner = wordingOwnerAnchor(scheme, block.anchorId);
    if (owner !== null && ancestors.has(owner)) {
      governing.set(block, positionOf(index));
    }
  }

  for (const [block, position] of unfiledGoverningWording({
    provision,
    scheme,
    inRange,
    rangeEnd,
    ancestors,
  })) {
    governing.set(block, position);
  }

  return provision.flatMap((block) => {
    const position = governing.get(block);
    return position === undefined ? [] : [{ block, position }];
  });
};
