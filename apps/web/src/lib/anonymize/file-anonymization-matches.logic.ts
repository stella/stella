import { panic } from "better-result";

import { findSearchMatchRanges } from "@stll/text-normalize";

type NormalizedText = { text: string; originalBoundaries: number[] };

export const normalizeWhitespaceWithOffsets = (
  text: string,
): NormalizedText => {
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

export const findFileAnonymizationMatches = (
  content: NormalizedText,
  term: string,
) =>
  findSearchMatchRanges(content.text, term.replaceAll(/\s+/gu, " ").trim()).map(
    ({ start, end }) => {
      const originalStart = content.originalBoundaries[start];
      const originalEnd = content.originalBoundaries[end];
      if (originalStart === undefined || originalEnd === undefined) {
        return panic("Anonymization match escaped the source offset map");
      }
      return { start: originalStart, end: originalEnd };
    },
  );
