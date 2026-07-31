const COMBINING_MARKS = /\p{M}+/gu;

export type SearchTextMatch = {
  start: number;
  end: number;
};

export const normalizeSearchText = (value: string): string =>
  value.normalize("NFKD").replace(COMBINING_MARKS, "").toLowerCase();

export const getSearchTextCandidates = (searchText: string): string[] => {
  const normalizedSearchText = searchText.trim();
  if (normalizedSearchText.length === 0) {
    return [];
  }

  const terms = normalizedSearchText.match(/[\p{L}\p{N}]+/gu) ?? [];
  return [normalizedSearchText, ...terms].filter(
    (candidate, index, candidates) =>
      candidate.length > 1 && candidates.indexOf(candidate) === index,
  );
};

export const findNormalizedSearchTextMatches = (
  content: string,
  searchText: string,
): SearchTextMatch[] => {
  const normalizedContentParts: string[] = [];
  const originalRanges: SearchTextMatch[] = [];
  let originalOffset = 0;

  for (const character of content) {
    const start = originalOffset;
    originalOffset += character.length;
    const normalizedCharacter = normalizeSearchText(character);
    normalizedContentParts.push(normalizedCharacter);
    for (const _codeUnit of normalizedCharacter.split("")) {
      originalRanges.push({ start, end: originalOffset });
    }
  }

  const normalizedContent = normalizedContentParts.join("");
  const normalizedQuery = normalizeSearchText(searchText.trim());
  if (normalizedQuery.length <= 1) {
    return [];
  }

  const matches: SearchTextMatch[] = [];
  let searchFrom = 0;
  while (searchFrom <= normalizedContent.length - normalizedQuery.length) {
    const normalizedStart = normalizedContent.indexOf(
      normalizedQuery,
      searchFrom,
    );
    if (normalizedStart === -1) {
      break;
    }
    const normalizedEnd = normalizedStart + normalizedQuery.length;
    const firstRange = originalRanges.at(normalizedStart);
    const lastRange = originalRanges.at(normalizedEnd - 1);
    if (firstRange && lastRange) {
      matches.push({ start: firstRange.start, end: lastRange.end });
    }
    searchFrom = normalizedEnd;
  }

  return matches;
};
