import type { Block, ParagraphBlock } from "./document-ast.js";

/** Closing formula: `V Brně dne 6. ledna 2016`, `Brno 15. května 2023`. */
export const CZ_CLOSING_RE =
  /^(?:V\s+)?\p{Lu}\p{Ll}+\s+(?:dne\s+)?\d{1,2}\.\s*(?:\p{Ll}+\s+|\d{1,2}\.\s*)?\d{4}/u;

/** Signatory name prefix used in Czech public legal documents. */
export const CZ_JUDGE_NAME_RE =
  /^(?:JUDr\.|Mgr\.|doc\.|prof\.|PhDr\.|Ing\.|Bc\.|RNDr\.|MUDr\.)\s+/u;

/**
 * Court signature marker. Kept as a shared legal-document primitive because
 * every Czech court adapter and the statute reader assign the same AST role.
 */
export const CZ_JUDGE_TITLE_RE =
  /(?:předsed(?:a|kyně|y)\s+senátu:?|samosoudce|samosoudkyně|soud(?:ce|kyně)\s+zpravodaj|v\.\s*r\.\s*$)/iu;

/** An office printed beside a signed name in Czech public documents. */
const CZ_PUBLIC_OFFICE_TITLE_RE = /^(?:vice)?guvernér(?:ka)?\s*:?$/iu;
const SIGNATURE_LINE_MAX_CHARS = 80;

const isSignatureSeed = (block: Block | undefined): boolean =>
  block !== undefined &&
  (block.type === "heading" || block.type === "paragraph") &&
  block.plainText.trim().length < SIGNATURE_LINE_MAX_CHARS &&
  CZ_JUDGE_TITLE_RE.test(block.plainText.trim());

const isSignatureCompanion = (block: Block | undefined): boolean =>
  block !== undefined &&
  (block.type === "heading" || block.type === "paragraph") &&
  block.plainText.trim().length < SIGNATURE_LINE_MAX_CHARS &&
  (CZ_JUDGE_NAME_RE.test(block.plainText.trim()) ||
    CZ_PUBLIC_OFFICE_TITLE_RE.test(block.plainText.trim()));

const asSignatureParagraph = (block: Block): Block => {
  if (block.type === "paragraph") {
    return { ...block, role: "signature" };
  }
  if (block.type !== "heading") {
    return block;
  }

  return {
    anchorId: block.anchorId,
    id: block.id,
    inlines: block.inlines,
    plainText: block.plainText,
    role: "signature",
    type: "paragraph",
  } satisfies ParagraphBlock;
};

/**
 * Refine recognisable Czech signature lines into the canonical paragraph
 * role. A `v. r.` or court-title line is the seed; an adjacent short name or
 * public-office title joins that signature block. Body prose is untouched.
 */
export const withInferredCzechSignatureRoles = (
  blocks: readonly Block[],
): Block[] => {
  const signatureIndexes = new Set<number>();

  for (const [index, block] of blocks.entries()) {
    if (!isSignatureSeed(block)) {
      continue;
    }
    signatureIndexes.add(index);
    if (isSignatureCompanion(blocks[index - 1])) {
      signatureIndexes.add(index - 1);
    }
    if (isSignatureCompanion(blocks[index + 1])) {
      signatureIndexes.add(index + 1);
    }
  }

  return blocks.map((block, index) =>
    signatureIndexes.has(index) ? asSignatureParagraph(block) : block,
  );
};
