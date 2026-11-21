import { panic } from "better-result";

import {
  findSearchMatchRanges,
  foldSearchMatchTextWithOffsets,
} from "@stll/text-normalize";
import type { FoldedSearchText } from "@stll/text-normalize";

type NormalizedText = { text: string; originalBoundaries: number[] };

/** Whitespace-normalized and search-folded once, then matched for every term. */
export type PreparedAnonymizationText = {
  normalized: NormalizedText;
  folded: FoldedSearchText;
};

const normalizeWhitespaceWithOffsets = (text: string): NormalizedText => {
  const normalized: string[] = [];
  const originalBoundaries = [0];
  let index = 0;
  while (index < text.length) {
    if (/\s/u.test(text.charAt(index))) {
      while (index < text.length && /\s/u.test(text.charAt(index))) {
        index += 1;
      }
      normalized.push(" ");
      originalBoundaries.push(index);
      continue;
    }
    normalized.push(text.charAt(index));
    index += 1;
    originalBoundaries.push(index);
  }
  return { text: normalized.join(""), originalBoundaries };
};

export const prepareFileAnonymizationText = (
  text: string,
): PreparedAnonymizationText => {
  const normalized = normalizeWhitespaceWithOffsets(text);
  return {
    normalized,
    folded: foldSearchMatchTextWithOffsets(normalized.text),
  };
};

export const findFileAnonymizationMatches = (
  { normalized, folded }: PreparedAnonymizationText,
  term: string,
) =>
  findSearchMatchRanges(folded, term.replaceAll(/\s+/gu, " ").trim()).map(
    ({ start, end }) => {
      const originalStart = normalized.originalBoundaries[start];
      const originalEnd = normalized.originalBoundaries[end];
      if (originalStart === undefined || originalEnd === undefined) {
        return panic("Anonymization match escaped the source offset map");
      }
      return { start: originalStart, end: originalEnd };
    },
  );
