import type { Block } from "@/api/handlers/case-law/document-ast";
import type {
  DecisionSection,
  DecisionSectionType,
} from "@/api/handlers/case-law/types";

/**
 * Derive a decision's sections from a parsed AST.
 *
 * `segmentDecision` finds section boundaries by matching heading
 * wording ("Odůvodnění", "Uzasadnienie", …), which cannot scale to a
 * court that publishes in 24 languages. Where a parser has already
 * recovered the document's structure, the headings are the boundaries
 * and the section's kind follows from what it contains, so no wording
 * is consulted at all.
 *
 * Sections are cut at level-1 headings: those are the parts a reader
 * navigates between. Deeper headings stay inside their section, as
 * part of its text.
 */
export const sectionsFromAst = (
  blocks: readonly Block[],
): DecisionSection[] => {
  const groups: { title: string | null; blocks: Block[] }[] = [];
  let openKind: BlockKind = "body";

  for (const block of blocks) {
    if (block.type === "heading" && block.level === 1) {
      groups.push({ title: block.plainText, blocks: [] });
      openKind = "body";
      continue;
    }

    // The operative part carries no heading of its own: courts
    // introduce it with a sentence ("On those grounds, the Court hereby
    // rules:"), so a heading-only split leaves the ruling buried at the
    // end of whichever section preceded it — for CJEU judgments that is
    // "Costs", which then reads as the section holding the ruling.
    const kind = blockKind(block);
    const current = groups.at(-1);
    if (!current || kind !== openKind) {
      groups.push({ title: null, blocks: [block] });
      openKind = kind;
      continue;
    }
    current.blocks.push(block);
  }

  const sections: DecisionSection[] = [];
  for (const group of groups) {
    const text = group.blocks
      .map((block) => block.plainText.trim())
      .filter((line) => line !== "")
      .join("\n\n");

    if (text === "" && group.title === null) {
      continue;
    }

    sections.push({
      index: sections.length,
      type: sectionType(group.blocks, sections.length, sections.at(-1)?.type),
      title: group.title,
      text,
    });
  }

  return sections;
};

/**
 * Which run of the document a block belongs to. The ruling and the
 * signatures that close it are one run; everything else, including the
 * footnotes that follow, is body.
 */
type BlockKind = "body" | "ruling";

const blockKind = (block: Block): BlockKind =>
  block.type === "paragraph" &&
  (block.role === "holding" || block.role === "signature")
    ? "ruling"
    : "body";

/**
 * Classify a section by the roles its paragraphs carry. The roles are
 * positional (see the parser), so this stays language-independent.
 */
const sectionType = (
  blocks: readonly Block[],
  index: number,
  previous: DecisionSectionType | undefined,
): DecisionSectionType => {
  const hasRole = (role: string): boolean =>
    blocks.some((block) => block.type === "paragraph" && block.role === role);

  if (hasRole("holding")) {
    return "ruling";
  }
  if (hasRole("signature")) {
    return "footer";
  }
  // Whatever trails the ruling is the document's tail: footnotes, the
  // language-of-the-case line, and nothing a reader navigates to.
  if (previous === "ruling") {
    return "footer";
  }
  if (index === 0 || hasRole("intro")) {
    return "header";
  }
  return blocks.some(
    (block) => block.type === "paragraph" && block.number !== undefined,
  )
    ? "argumentation"
    : "unknown";
};
