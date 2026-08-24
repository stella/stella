import type { Block } from "@stll/legal-ast/document-ast";

import { inlinesToPlainText } from "@/components/legal-reader/document-ast-text";
import {
  dropOverlappingSpans,
  escapeRegExp,
} from "@/features/case-law/citation-anchors";
import type { ProvisionReference } from "@/features/case-law/provision-label";

/**
 * A provision reference to locate: the sentence the extractor read it from
 * and the reference itself. `id` keys the rendered anchor.
 */
export type ProvisionAnchorSource<T = unknown> = {
  id: string;
  reference: Pick<
    ProvisionReference,
    "letter" | "section" | "sectionSuffix" | "subsection" | "unit"
  >;
  sentenceText: string;
  target: T;
};

export type ProvisionAnchorSpan<T = unknown> = {
  end: number;
  source: ProvisionAnchorSource<T>;
  start: number;
};

/** Enough of the sentence to find it once; a whole sentence may wrap oddly. */
const SENTENCE_HEAD_TOKENS = 8;

/**
 * The stored sentence has no reliable offsets into the rendered text, so the
 * sentence itself is found first, by its opening words with any whitespace
 * between them, and the reference is then read inside it.
 */
const sentenceHeadPattern = (sentenceText: string): RegExp | null => {
  const tokens = sentenceText.trim().split(/\s+/u).filter(Boolean);
  if (tokens.length === 0) {
    return null;
  }
  // A period may or may not be followed by a space in either text
  // ("1.Žalobce" against "1. Žalobce"), so it tolerates one.
  const source = tokens
    .slice(0, SENTENCE_HEAD_TOKENS)
    .map((token) => escapeRegExp(token).replaceAll("\\.", "\\.\\s*"))
    .join("\\s*");
  return new RegExp(source, "u");
};

/**
 * The reference as the decision prints it: the sign or the article word, the
 * number with its inserted-provision letter, then whichever named
 * subdivisions the reference carries, each optional in print. `§ 90` also
 * matches "§ 90 odst. 5" when the row states no subsection; a row that does
 * state one extends the match over it when the text agrees.
 */
const referencePattern = ({
  letter,
  section,
  sectionSuffix,
  subsection,
  unit,
}: ProvisionAnchorSource["reference"]): RegExp => {
  const head =
    unit === "article" ? String.raw`(?:čl\.|článk\p{Ll}*|art\.|Art\.)` : "§";
  const number = `${String(section)}${sectionSuffix === null ? "" : escapeRegExp(sectionSuffix)}`;
  const parts = [String.raw`${head}\s*${number}(?![\p{N}\p{L}])`];
  if (subsection !== null) {
    parts.push(
      String.raw`(?:\s*(?:odst\.|ods\.|ust\.|para\.)\s*${escapeRegExp(subsection)}(?![\p{N}\p{L}]))?`,
    );
  }
  if (letter !== null) {
    parts.push(
      String.raw`(?:\s*(?:písm\.|písmeno|lit\.)\s*${escapeRegExp(letter)}\)?)?`,
    );
  }
  return new RegExp(parts.join(""), "u");
};

/**
 * Where each provision reference stands in each block, keyed by block id.
 *
 * A reference is located in the first block that carries its sentence and
 * only inside that sentence's reach, so `§ 7` in one paragraph never lights
 * up every `§ 7` in the judgment. A table is skipped because its text is
 * split across cell pieces.
 */
export const locateProvisionAnchors = <T>({
  blocks,
  provisions,
}: {
  blocks: readonly Block[];
  provisions: readonly ProvisionAnchorSource<T>[];
}): Record<string, ProvisionAnchorSpan<T>[]> => {
  if (provisions.length === 0) {
    return {};
  }

  const texts: { block: Block; text: string }[] = [];
  for (const block of blocks) {
    if (block.type === "table") {
      continue;
    }
    texts.push({ block, text: inlinesToPlainText(block.inlines) });
  }

  const hitsByBlock = new Map<string, ProvisionAnchorSpan<T>[]>();
  for (const source of provisions) {
    const head = sentenceHeadPattern(source.sentenceText);
    if (head === null) {
      continue;
    }
    const reference = referencePattern(source.reference);
    for (const { block, text } of texts) {
      const sentenceStart = head.exec(text)?.index;
      if (sentenceStart === undefined) {
        continue;
      }
      // The sentence may print longer than it was stored (wrapped lines,
      // publisher spacing); a margin keeps a reference near its end in reach.
      const window = text.slice(
        sentenceStart,
        sentenceStart + Math.ceil(source.sentenceText.length * 1.5) + 40,
      );
      const match = reference.exec(window);
      if (match === null) {
        break;
      }
      const start = sentenceStart + match.index;
      const spans = hitsByBlock.get(block.id) ?? [];
      spans.push({ end: start + match[0].length, source, start });
      hitsByBlock.set(block.id, spans);
      break;
    }
  }

  const result: Record<string, ProvisionAnchorSpan<T>[]> = {};
  for (const [blockId, spans] of hitsByBlock) {
    result[blockId] = dropOverlappingSpans(spans);
  }
  return result;
};
