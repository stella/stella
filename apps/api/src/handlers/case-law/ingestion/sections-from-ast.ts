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

  for (const block of blocks) {
    if (block.type === "heading" && block.level === 1) {
      groups.push({ title: block.plainText, blocks: [] });
      continue;
    }
    const current = groups.at(-1);
    if (current) {
      current.blocks.push(block);
      continue;
    }
    // Anything before the first heading is the untitled opening group.
    groups.push({ title: null, blocks: [block] });
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
      type: sectionType(group.blocks, sections.length),
      title: group.title,
      text,
    });
  }

  return sections;
};

/**
 * Classify a section by the roles its paragraphs carry. The roles are
 * positional (see the parser), so this stays language-independent.
 */
const sectionType = (
  blocks: readonly Block[],
  index: number,
): DecisionSectionType => {
  const hasRole = (role: string): boolean =>
    blocks.some((block) => block.type === "paragraph" && block.role === role);

  if (hasRole("holding")) {
    return "ruling";
  }
  if (hasRole("signature")) {
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
