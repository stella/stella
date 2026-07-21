import type {
  AbstractNumbering,
  BlockContent,
  Document as FolioDocument,
  ListLevel,
  NumberingInstance,
  Paragraph,
} from "@stll/docx-core/model";

/**
 * `fromMarkdown` mints its own small, list-local `numId`s (1, 2, 3, …) on the
 * assumption it owns the whole numbering namespace (see
 * `blocksFromTokens(tokens, { next: 1 })` in folio-core). That assumption
 * breaks once its parsed blocks are merged onto a document that already
 * carries a real numbering part — such as Stella's preset, whose
 * `createLegalNumbering()` reserves `numId` 1-5 for clause / definitions /
 * recitals / parties / bullet numbering. Left alone, a markdown bullet or
 * ordered list silently collides with those reserved ids and renders with
 * Stella's legal clause/definition markers instead of plain bullets/numbers.
 *
 * This module renumbers every markdown-originated list to fresh
 * `numId`/`abstractNumId` values above whatever the target document's
 * numbering already uses, and synthesizes minimal `w:abstractNum` /
 * `w:num` definitions (decimal or bullet, one level per depth used) so the
 * renumbered lists still render correctly — `listRendering` alone is an
 * editor-side hint the DOCX serializer does not consult (see
 * `numberingSerializer.ts`, which reads only `document.package.numbering`).
 */

const LIST_INDENT_STEP_TWIPS = 360;
const LIST_HANGING_INDENT_TWIPS = 360;
const BULLET_MARKER = "•";

type MarkdownListGroup = {
  isBullet: boolean;
  maxLevel: number;
  start: number | undefined;
};

const isParagraphWithListNumId = (
  block: BlockContent,
): block is Paragraph & {
  formatting: NonNullable<Paragraph["formatting"]> & {
    numPr: NonNullable<NonNullable<Paragraph["formatting"]>["numPr"]> & {
      numId: number;
    };
  };
} => block.type === "paragraph" && block.formatting?.numPr?.numId !== undefined;

const collectMarkdownListGroups = (
  content: readonly BlockContent[],
): Map<number, MarkdownListGroup> => {
  const groups = new Map<number, MarkdownListGroup>();
  for (const block of content) {
    if (!isParagraphWithListNumId(block)) {
      continue;
    }
    const { numId, ilvl = 0 } = block.formatting.numPr;
    const rendering = block.listRendering;
    const existing = groups.get(numId);
    groups.set(numId, {
      isBullet: rendering?.isBullet ?? existing?.isBullet ?? false,
      maxLevel: Math.max(existing?.maxLevel ?? 0, ilvl),
      start:
        ilvl === 0
          ? (rendering?.startOverride ?? existing?.start)
          : existing?.start,
    });
  }
  return groups;
};

const buildMarkdownListLevel = ({
  ilvl,
  isBullet,
  start,
}: {
  ilvl: number;
  isBullet: boolean;
  start: number | undefined;
}): ListLevel => ({
  ilvl,
  ...(ilvl === 0 && start !== undefined ? { start } : {}),
  numFmt: isBullet ? "bullet" : "decimal",
  lvlText: isBullet ? BULLET_MARKER : `%${ilvl + 1}.`,
  suffix: "tab",
  pPr: {
    indentLeft: LIST_INDENT_STEP_TWIPS * (ilvl + 1),
    indentFirstLine: -LIST_HANGING_INDENT_TWIPS,
    hangingIndent: true,
  },
});

/**
 * Renumber every markdown-originated list in `content` (mutating each
 * paragraph's `formatting.numPr` / `listRendering` in place — safe because
 * `content` is `fromMarkdown`'s freshly parsed, uniquely-owned array, never
 * shared with a caller) and append matching `abstractNum` / `num`
 * definitions onto `target`'s numbering part. No-op when `content` has no
 * lists.
 */
export const remapMarkdownListNumbering = (
  target: FolioDocument,
  content: BlockContent[],
): void => {
  const groups = collectMarkdownListGroups(content);
  if (groups.size === 0) {
    return;
  }

  const existingNumbering = target.package.numbering;
  let nextAbstractNumId =
    Math.max(
      0,
      ...(existingNumbering?.abstractNums ?? []).map((a) => a.abstractNumId),
    ) + 1;
  let nextNumId =
    Math.max(0, ...(existingNumbering?.nums ?? []).map((n) => n.numId)) + 1;

  const newAbstractNums: AbstractNumbering[] = [];
  const newNums: NumberingInstance[] = [];
  const numIdRemap = new Map<number, number>();

  // Sorted so remapped ids are assigned deterministically (in source order),
  // not in `Map` insertion order (which happens to match here, but sorting
  // keeps this independent of that incidental detail).
  for (const [originalNumId, group] of [...groups.entries()].sort(
    ([a], [b]) => a - b,
  )) {
    const abstractNumId = nextAbstractNumId;
    const numId = nextNumId;
    nextAbstractNumId += 1;
    nextNumId += 1;
    numIdRemap.set(originalNumId, numId);

    const levels: ListLevel[] = [];
    for (let ilvl = 0; ilvl <= group.maxLevel; ilvl += 1) {
      levels.push(
        buildMarkdownListLevel({
          ilvl,
          isBullet: group.isBullet,
          start: ilvl === 0 ? group.start : undefined,
        }),
      );
    }

    newAbstractNums.push({ abstractNumId, levels });
    newNums.push({ numId, abstractNumId });
  }

  for (const block of content) {
    if (!isParagraphWithListNumId(block)) {
      continue;
    }
    const remapped = numIdRemap.get(block.formatting.numPr.numId);
    if (remapped === undefined) {
      continue;
    }
    block.formatting.numPr.numId = remapped;
    if (block.listRendering) {
      block.listRendering.numId = remapped;
    }
  }

  target.package.numbering = {
    abstractNums: [
      ...(existingNumbering?.abstractNums ?? []),
      ...newAbstractNums,
    ],
    nums: [...(existingNumbering?.nums ?? []), ...newNums],
  };
};
