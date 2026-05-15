export type SearchPiece = {
  id: string;
  text: string;
};

export type SearchMatchRange = {
  end: number;
  matchIndex: number;
  start: number;
};

export type SearchResults = {
  matchCount: number;
  rangesByPieceId: Record<string, SearchMatchRange[]>;
};

const DIACRITIC_RE = /\p{Diacritic}+/gu;
const LETTER_OR_NUMBER_RE = /[\p{L}\p{N}]/u;

// Matches runs of single-letter words separated by spaces,
// optionally followed by punctuation (e.g. "r o z h o d o l :"
// or "z a m i e t a"). Collapsed to the concatenated letters
// so users can search "rozhodol" and find the spaced heading.
// Mirrors `collapseSpacedLetters` in the API pipeline.
const SPACED_LETTER_RUN_RE =
  /(?<=\s|^)(\p{L} (?:\p{L} )*\p{L})( ?[,:;.!?])?(?=\s|$)/gu;

type NormalizedText = {
  endMap: number[];
  startMap: number[];
  text: string;
};

const normalizeSearchText = (text: string): NormalizedText => {
  const normalizedChars: string[] = [];
  const startMap: number[] = [];
  const endMap: number[] = [];

  let originalIndex = 0;
  let lastWasSeparator = true;

  // Mark every space that sits between single letters inside a
  // spaced-letter run — we'll treat those spaces as letter-like
  // so the letters collapse into one searchable word while each
  // letter's startMap/endMap still points at its original char.
  const dropSpaceAt = new Set<number>();
  for (const match of text.matchAll(SPACED_LETTER_RUN_RE)) {
    const matchStart = match.index;
    const matched = match[0];
    for (let i = 0; i < matched.length; i++) {
      if (matched[i] === " ") {
        const ch = matched[i - 1];
        if (ch !== undefined && ch !== " " && LETTER_OR_NUMBER_RE.test(ch)) {
          dropSpaceAt.add(matchStart + i);
        }
      }
    }
  }

  // startMap/endMap are indexed by UTF-16 code units of the
  // joined normalized text, because `String.indexOf` returns
  // code-unit offsets. When we append a character that spans
  // multiple code units (e.g., an astral-plane letter encoded
  // as a surrogate pair), we push one map entry per unit so
  // `startMap[matchStart]` and `endMap[matchEnd - 1]` stay
  // valid for every code-unit index the matcher can produce.
  const pushEntry = (char: string, origStart: number, origEnd: number) => {
    normalizedChars.push(char);
    // Push one map entry per UTF-16 code unit the char
    // occupies (2 for surrogate pairs, 1 otherwise).
    // `char.length` returns code units, not code points.
    const units = Array.from<number>({ length: char.length });
    startMap.push(...units.fill(origStart));
    endMap.push(...units.fill(origEnd));
  };

  for (const rawChar of text) {
    const normalizedChar = rawChar.normalize("NFD").replace(DIACRITIC_RE, "");
    const origStart = originalIndex;
    const origEnd = originalIndex + rawChar.length;

    for (const candidate of normalizedChar) {
      if (LETTER_OR_NUMBER_RE.test(candidate)) {
        pushEntry(candidate, origStart, origEnd);
        lastWasSeparator = false;
        continue;
      }

      // Spaces inside a spaced-letter run are suppressed entirely
      // so "r o z h o d o l" normalizes to "rozhodol".
      if (rawChar === " " && dropSpaceAt.has(originalIndex)) {
        continue;
      }

      if (lastWasSeparator || normalizedChars.length === 0) {
        continue;
      }

      pushEntry(" ", origStart, origEnd);
      lastWasSeparator = true;
    }

    originalIndex += rawChar.length;
  }

  if (normalizedChars.at(-1) === " ") {
    normalizedChars.pop();
    startMap.pop();
    endMap.pop();
  }

  // Fold with the invariant locale so matching stays stable
  // regardless of the browser's locale. `toLocaleLowerCase()`
  // folds "I" → "ı" on Turkish systems, which would make
  // "INDICTMENT" vs "indictment" look like different strings
  // to two users opening the same decision.
  //
  // Preferred path: fold the whole joined string so
  // context-sensitive rules (Greek final sigma: "Σ" at end of
  // word lowers to "ς", elsewhere to "σ") apply. Keep that
  // result only if it stays the same UTF-16 length as the
  // pre-fold text; otherwise the pre-built startMap/endMap no
  // longer align. In that rare case, fall back to per-char
  // folding and rebuild the maps alongside it.
  const joined = normalizedChars.join("");
  const loweredJoined = joined.toLowerCase();
  if (loweredJoined.length === joined.length) {
    return { text: loweredJoined, startMap, endMap };
  }

  const loweredStartMap: number[] = [];
  const loweredEndMap: number[] = [];
  const loweredParts: string[] = [];
  let unitCursor = 0;
  for (const char of normalizedChars) {
    const lowered = char.toLowerCase();
    loweredParts.push(lowered);
    const origStart = startMap[unitCursor] ?? 0;
    const origEnd = endMap[unitCursor] ?? 0;
    const units = Array.from<number>({ length: lowered.length });
    loweredStartMap.push(...units.fill(origStart));
    loweredEndMap.push(...units.fill(origEnd));
    unitCursor += char.length;
  }

  return {
    text: loweredParts.join(""),
    startMap: loweredStartMap,
    endMap: loweredEndMap,
  };
};

const normalizeQuery = (query: string): string =>
  normalizeSearchText(query).text.trim();

export const buildSearchResults = ({
  pieces,
  query,
}: {
  pieces: SearchPiece[];
  query: string;
}): SearchResults => {
  const normalizedQuery = normalizeQuery(query);
  if (normalizedQuery.length === 0) {
    return { matchCount: 0, rangesByPieceId: {} };
  }

  const rangesByPieceId: Record<string, SearchMatchRange[]> = {};
  let matchCount = 0;

  for (const piece of pieces) {
    const normalizedPiece = normalizeSearchText(piece.text);
    if (normalizedPiece.text.length === 0) {
      continue;
    }

    let fromIndex = 0;
    while (fromIndex < normalizedPiece.text.length) {
      const matchStart = normalizedPiece.text.indexOf(
        normalizedQuery,
        fromIndex,
      );
      if (matchStart === -1) {
        break;
      }

      const matchEnd = matchStart + normalizedQuery.length;
      const originalStart = normalizedPiece.startMap[matchStart];
      const originalEnd = normalizedPiece.endMap[matchEnd - 1];

      if (originalStart !== undefined && originalEnd !== undefined) {
        const ranges = rangesByPieceId[piece.id] ?? [];
        ranges.push({
          start: originalStart,
          end: originalEnd,
          matchIndex: matchCount,
        });
        rangesByPieceId[piece.id] = ranges;
        matchCount += 1;
      }

      fromIndex = matchStart + normalizedQuery.length;
    }
  }

  return {
    matchCount,
    rangesByPieceId,
  };
};
