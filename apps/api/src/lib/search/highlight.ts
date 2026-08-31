import {
  applyArabicFolds,
  applyArabicFoldsWithOffsets,
  foldToAscii,
  arabicNormalize,
} from "@stll/text-normalize";

// Non-HTML delimiters injected by ts_headline / pdb.snippet(). Keep these
// high-entropy internal tokens distinct from user-typable source text: common
// code and log strings such as "__HL_START__" must remain literal content.
export const HIGHLIGHT_START =
  "__STELLA_HIGHLIGHT_START_516ec7a37cb44bb4b268f27323d58136__";
export const HIGHLIGHT_STOP =
  "__STELLA_HIGHLIGHT_STOP_516ec7a37cb44bb4b268f27323d58136__";
export const SEARCH_PREVIEW_FRAGMENT_DELIMITER =
  "__STELLA_HIGHLIGHT_FRAGMENT_516ec7a37cb44bb4b268f27323d58136__";
export const SEARCH_PREVIEW_FRAGMENT_SEPARATOR = "...\n\n";

// `MaxFragments=3` splits the headline into up to 3 separate
// excerpts joined by `...`, surfacing more occurrences without
// inflating snippet length per result. The delimiter is rendered
// as a fragment separator by the result card.
export const TS_HEADLINE_CONFIG =
  "MaxWords=20, MinWords=8, MaxFragments=3, FragmentDelimiter=..., " +
  `StartSel=${HIGHLIGHT_START}, ` +
  `StopSel=${HIGHLIGHT_STOP}`;

// Preview is fetched for one selected hit, never for the search result list.
// More fragments make the pane useful while keeping the response bounded.
export const SEARCH_PREVIEW_HEADLINE_CONFIG =
  `MaxWords=220, MinWords=80, MaxFragments=8, FragmentDelimiter="${SEARCH_PREVIEW_FRAGMENT_DELIMITER}", ` +
  `StartSel=${HIGHLIGHT_START}, ` +
  `StopSel=${HIGHLIGHT_STOP}`;

const SEARCH_WHITESPACE =
  /^[ \t\n\v\f\r\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+$/u;
const NORMALIZATION_UNIT =
  /[ \t\n\v\f\r\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+|\P{Mark}\p{Mark}*|\p{Mark}+/gu;
const ALIGNMENT_ANCHOR_LENGTHS = [8, 4, 2, 1] as const;
const ALIGNMENT_LOOKAHEAD = 256;
type SourceSpan = {
  end: number;
  start: number;
};

type SourceMapping =
  | {
      normalizedEnd: number;
      normalizedStart: number;
      sourceEnd: number;
      sourceStart: number;
      type: "atomic";
    }
  | {
      normalizedEnd: number;
      normalizedStart: number;
      sourceEnd: number;
      sourceStart: number;
      type: "linear";
    };

type NormalizedSource = {
  mappings: SourceMapping[];
  text: string;
};

// `useUnaccent` means the persisted passage was normalized with `unaccent()`,
// so the local scaffold has to fold the same way; a plain mark strip leaves
// `ł` standing where the stored text holds `l`.
const normalizePreviewUnit = (text: string, useUnaccent: boolean): string => {
  const normalized = arabicNormalize(text);
  return useUnaccent ? foldToAscii(normalized) : normalized;
};

const appendSourceMapping = (
  mappings: SourceMapping[],
  mapping: SourceMapping,
): void => {
  const previous = mappings.at(-1);
  if (
    mapping.type === "linear" &&
    previous?.type === "linear" &&
    previous.normalizedEnd === mapping.normalizedStart &&
    previous.sourceEnd === mapping.sourceStart
  ) {
    previous.normalizedEnd = mapping.normalizedEnd;
    previous.sourceEnd = mapping.sourceEnd;
    return;
  }
  mappings.push(mapping);
};

const normalizeSourceWithMappings = (
  source: string,
  useUnaccent: boolean,
): NormalizedSource => {
  let text = "";
  const mappings: SourceMapping[] = [];
  let pendingWhitespace: SourceSpan | null = null;

  const append = (normalized: string, span: SourceSpan) => {
    const normalizedStart = text.length;
    text += normalized;
    const normalizedEnd = text.length;
    const isLinear = normalized.length === span.end - span.start;
    if (isLinear) {
      appendSourceMapping(mappings, {
        type: "linear",
        normalizedStart,
        normalizedEnd,
        sourceStart: span.start,
        sourceEnd: span.end,
      });
      return;
    }
    appendSourceMapping(mappings, {
      type: "atomic",
      normalizedStart,
      normalizedEnd,
      sourceStart: span.start,
      sourceEnd: span.end,
    });
  };

  for (const match of source.matchAll(NORMALIZATION_UNIT)) {
    const value = match[0];
    const start = match.index;
    const span = { start, end: start + value.length };
    if (SEARCH_WHITESPACE.test(value)) {
      pendingWhitespace = pendingWhitespace
        ? { start: pendingWhitespace.start, end: span.end }
        : span;
      continue;
    }

    const normalized = normalizePreviewUnit(value, useUnaccent);
    if (!normalized) {
      continue;
    }
    if (pendingWhitespace && text.length > 0) {
      append(" ", pendingWhitespace);
    }
    pendingWhitespace = null;
    append(normalized, span);
  }

  return { mappings, text };
};

const sourceMappingIndexAt = (
  normalizedSource: NormalizedSource,
  normalizedIndex: number,
): number | null => {
  if (normalizedIndex < 0 || normalizedIndex >= normalizedSource.text.length) {
    return null;
  }

  let low = 0;
  let high = normalizedSource.mappings.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const mapping = normalizedSource.mappings.at(middle);
    if (!mapping) {
      return null;
    }
    if (normalizedIndex < mapping.normalizedStart) {
      high = middle - 1;
      continue;
    }
    if (normalizedIndex >= mapping.normalizedEnd) {
      low = middle + 1;
      continue;
    }
    return middle;
  }
  return null;
};

const sourceSpanAt = (
  normalizedSource: NormalizedSource,
  normalizedIndex: number,
): SourceSpan | null => {
  const mappingIndex = sourceMappingIndexAt(normalizedSource, normalizedIndex);
  if (mappingIndex === null) {
    return null;
  }
  const mapping = normalizedSource.mappings.at(mappingIndex);
  if (!mapping) {
    return null;
  }
  if (mapping.type === "atomic") {
    return { start: mapping.sourceStart, end: mapping.sourceEnd };
  }
  const offset = normalizedIndex - mapping.normalizedStart;
  return {
    start: mapping.sourceStart + offset,
    end: mapping.sourceStart + offset + 1,
  };
};

type TruncateSearchPreviewAroundCandidatesOptions = {
  candidates: readonly string[];
  maxLength: number;
  source: string;
};

const isLowSurrogate = (value: number): boolean =>
  value >= 0xdc_00 && value <= 0xdf_ff;

const isHighSurrogate = (value: number): boolean =>
  value >= 0xd8_00 && value <= 0xdb_ff;

const utf16CodeUnitAt = (source: string, index: number): number =>
  source.at(index)?.codePointAt(0) ?? Number.NaN;

const sliceWithoutSplitSurrogate = (
  source: string,
  requestedStart: number,
  maxLength: number,
): string => {
  let start = Math.max(0, Math.min(source.length, Math.floor(requestedStart)));
  if (isLowSurrogate(utf16CodeUnitAt(source, start))) {
    start += 1;
  }
  let end = Math.min(source.length, start + maxLength);
  if (isHighSurrogate(utf16CodeUnitAt(source, end - 1))) {
    end -= 1;
  }
  return source.slice(start, end);
};

const SEARCH_LEXEME = /[\p{L}\p{N}]+/gu;

type CandidatePrefixMatch = {
  length: number;
  start: number;
};

type SearchLexeme = {
  start: number;
  value: string;
};

const getSearchLexemes = (text: string): SearchLexeme[] =>
  Array.from(text.matchAll(SEARCH_LEXEME), (match) => ({
    start: match.index,
    value: match[0],
  }));

const findCandidatePrefix = (
  sourceLexemes: readonly SearchLexeme[],
  candidate: string,
): CandidatePrefixMatch | null => {
  const candidateLexemes = Array.from(
    candidate.matchAll(SEARCH_LEXEME),
    (match) => match[0],
  );
  if (candidateLexemes.length === 0) {
    return null;
  }
  const lastStartIndex = sourceLexemes.length - candidateLexemes.length;
  for (let startIndex = 0; startIndex <= lastStartIndex; startIndex += 1) {
    const matches = candidateLexemes.every((lexeme, offset) =>
      sourceLexemes.at(startIndex + offset)?.value.startsWith(lexeme),
    );
    if (!matches) {
      continue;
    }
    const first = sourceLexemes.at(startIndex);
    const last = sourceLexemes.at(startIndex + candidateLexemes.length - 1);
    const lastCandidate = candidateLexemes.at(-1);
    if (!first || !last || !lastCandidate) {
      return null;
    }
    return {
      length: last.start + lastCandidate.length - first.start,
      start: first.start,
    };
  }
  return null;
};

export const truncateSearchPreviewAroundCandidates = ({
  candidates,
  maxLength,
  source,
}: TruncateSearchPreviewAroundCandidatesOptions): string => {
  const boundedLength = Math.max(0, Math.floor(maxLength));
  if (boundedLength === 0) {
    return "";
  }
  if (source.length <= boundedLength) {
    return source;
  }

  const normalizedSource = normalizeSourceWithMappings(source, true);
  const foldedSource = applyArabicFoldsWithOffsets(normalizedSource.text);
  const sourceLexemes = getSearchLexemes(foldedSource.text);
  let foldedMatchStart = Number.POSITIVE_INFINITY;
  let foldedMatchLength = 0;
  for (const candidate of candidates) {
    const normalizedCandidate = applyArabicFolds(
      normalizePreviewUnit(candidate.trim(), true),
    );
    if (!normalizedCandidate) {
      continue;
    }
    const match = findCandidatePrefix(sourceLexemes, normalizedCandidate);
    if (match && match.start < foldedMatchStart) {
      foldedMatchStart = match.start;
      foldedMatchLength = match.length;
    }
  }

  if (!Number.isFinite(foldedMatchStart)) {
    return sliceWithoutSplitSurrogate(source, 0, boundedLength);
  }
  const normalizedMatchStart = foldedSource.sourceIndex.at(foldedMatchStart);
  const normalizedMatchEnd = foldedSource.sourceEndIndex.at(
    foldedMatchStart + foldedMatchLength - 1,
  );
  if (
    normalizedMatchStart === undefined ||
    normalizedMatchEnd === undefined ||
    normalizedMatchEnd <= normalizedMatchStart
  ) {
    return sliceWithoutSplitSurrogate(source, 0, boundedLength);
  }
  const firstSpan = sourceSpanAt(normalizedSource, normalizedMatchStart);
  const lastSpan = sourceSpanAt(normalizedSource, normalizedMatchEnd - 1);
  if (!firstSpan || !lastSpan) {
    return sliceWithoutSplitSurrogate(source, 0, boundedLength);
  }

  const matchCenter = Math.floor((firstSpan.start + lastSpan.end) / 2);
  const start = Math.max(
    0,
    Math.min(source.length - boundedLength, matchCenter - boundedLength / 2),
  );
  return sliceWithoutSplitSurrogate(source, start, boundedLength);
};

type AlignmentAnchor = {
  normalizedStart: number;
  scaffoldStart: number;
};

const findAlignmentAnchor = ({
  normalized,
  normalizedFrom,
  scaffold,
  scaffoldFrom,
}: {
  normalized: string;
  normalizedFrom: number;
  scaffold: string;
  scaffoldFrom: number;
}): AlignmentAnchor | null => {
  for (const anchorLength of ALIGNMENT_ANCHOR_LENGTHS) {
    const normalizedAnchors = new Map<string, number>();
    const normalizedLimit = Math.min(
      normalized.length - anchorLength,
      normalizedFrom + ALIGNMENT_LOOKAHEAD,
    );
    for (let index = normalizedFrom + 1; index <= normalizedLimit; index += 1) {
      const anchor = normalized.slice(index, index + anchorLength);
      if (!normalizedAnchors.has(anchor)) {
        normalizedAnchors.set(anchor, index);
      }
    }

    const scaffoldLimit = Math.min(
      scaffold.length - anchorLength,
      scaffoldFrom + ALIGNMENT_LOOKAHEAD,
    );
    let best: AlignmentAnchor | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let index = scaffoldFrom + 1; index <= scaffoldLimit; index += 1) {
      const anchor = scaffold.slice(index, index + anchorLength);
      const normalizedStart = normalizedAnchors.get(anchor);
      if (normalizedStart === undefined) {
        continue;
      }
      const distance = index - scaffoldFrom + normalizedStart - normalizedFrom;
      if (distance < bestDistance) {
        best = { scaffoldStart: index, normalizedStart };
        bestDistance = distance;
      }
    }
    if (best) {
      return best;
    }
  }

  const scaffoldSpace = scaffold.indexOf(" ", scaffoldFrom);
  const normalizedSpace = normalized.indexOf(" ", normalizedFrom);
  return scaffoldSpace <= scaffoldFrom || normalizedSpace <= normalizedFrom
    ? null
    : {
        scaffoldStart: scaffoldSpace,
        normalizedStart: normalizedSpace,
      };
};

const appendPositionAlignedMappings = ({
  mappings,
  normalizedStart,
  scaffold,
  scaffoldEnd,
  scaffoldStart,
}: {
  mappings: SourceMapping[];
  normalizedStart: number;
  scaffold: NormalizedSource;
  scaffoldEnd: number;
  scaffoldStart: number;
}): void => {
  const firstMappingIndex = sourceMappingIndexAt(scaffold, scaffoldStart);
  if (firstMappingIndex === null) {
    return;
  }
  for (
    let mappingIndex = firstMappingIndex;
    mappingIndex < scaffold.mappings.length;
    mappingIndex += 1
  ) {
    const mapping = scaffold.mappings.at(mappingIndex);
    if (!mapping || mapping.normalizedStart >= scaffoldEnd) {
      break;
    }
    const overlapStart = Math.max(mapping.normalizedStart, scaffoldStart);
    const overlapEnd = Math.min(mapping.normalizedEnd, scaffoldEnd);
    if (overlapStart >= overlapEnd) {
      continue;
    }
    const alignedNormalizedStart =
      normalizedStart + overlapStart - scaffoldStart;
    const alignedNormalizedEnd = normalizedStart + overlapEnd - scaffoldStart;
    if (mapping.type === "atomic") {
      appendSourceMapping(mappings, {
        type: "atomic",
        normalizedStart: alignedNormalizedStart,
        normalizedEnd: alignedNormalizedEnd,
        sourceStart: mapping.sourceStart,
        sourceEnd: mapping.sourceEnd,
      });
      continue;
    }
    const sourceOffset = overlapStart - mapping.normalizedStart;
    appendSourceMapping(mappings, {
      type: "linear",
      normalizedStart: alignedNormalizedStart,
      normalizedEnd: alignedNormalizedEnd,
      sourceStart: mapping.sourceStart + sourceOffset,
      sourceEnd: mapping.sourceStart + sourceOffset + overlapEnd - overlapStart,
    });
  }
};

const appendChangedAlignment = ({
  mappings,
  normalizedEnd,
  normalizedStart,
  scaffold,
  scaffoldEnd,
  scaffoldStart,
}: {
  mappings: SourceMapping[];
  normalizedEnd: number;
  normalizedStart: number;
  scaffold: NormalizedSource;
  scaffoldEnd: number;
  scaffoldStart: number;
}): void => {
  if (normalizedStart >= normalizedEnd) {
    return;
  }
  if (normalizedEnd - normalizedStart === scaffoldEnd - scaffoldStart) {
    appendPositionAlignedMappings({
      mappings,
      normalizedStart,
      scaffold,
      scaffoldEnd,
      scaffoldStart,
    });
    return;
  }
  const fallbackSpan =
    scaffoldStart >= scaffoldEnd
      ? (sourceSpanAt(scaffold, scaffoldStart - 1) ??
        sourceSpanAt(scaffold, scaffoldStart))
      : null;
  const firstSpan = fallbackSpan ?? sourceSpanAt(scaffold, scaffoldStart);
  const lastSpan = fallbackSpan ?? sourceSpanAt(scaffold, scaffoldEnd - 1);
  if (!firstSpan || !lastSpan) {
    return;
  }
  appendSourceMapping(mappings, {
    type: "atomic",
    normalizedStart,
    normalizedEnd,
    sourceStart: firstSpan.start,
    sourceEnd: lastSpan.end,
  });
};

const alignDatabaseNormalizedSource = ({
  normalized,
  source,
  useUnaccent,
}: {
  normalized: string;
  source: string;
  useUnaccent: boolean;
}): NormalizedSource => {
  // The database value is authoritative for fragment lookup. The local
  // normalizer only supplies source offsets; any PostgreSQL-only fold becomes
  // an atomic changed range, so restoration cannot depend on mirroring
  // unaccent.rules in JavaScript.
  const scaffold = normalizeSourceWithMappings(source, useUnaccent);
  const mappings: SourceMapping[] = [];
  let normalizedCursor = 0;
  let scaffoldCursor = 0;

  while (
    normalizedCursor < normalized.length &&
    scaffoldCursor < scaffold.text.length
  ) {
    const exactNormalizedStart = normalizedCursor;
    const exactScaffoldStart = scaffoldCursor;
    while (
      normalizedCursor < normalized.length &&
      scaffoldCursor < scaffold.text.length
    ) {
      const normalizedCodePoint = normalized.codePointAt(normalizedCursor);
      if (normalizedCodePoint !== scaffold.text.codePointAt(scaffoldCursor)) {
        break;
      }
      const codeUnitLength =
        normalizedCodePoint !== undefined && normalizedCodePoint > 0xff_ff
          ? 2
          : 1;
      normalizedCursor += codeUnitLength;
      scaffoldCursor += codeUnitLength;
    }
    appendPositionAlignedMappings({
      mappings,
      normalizedStart: exactNormalizedStart,
      scaffold,
      scaffoldEnd: scaffoldCursor,
      scaffoldStart: exactScaffoldStart,
    });
    if (
      normalizedCursor >= normalized.length ||
      scaffoldCursor >= scaffold.text.length
    ) {
      break;
    }

    const normalizedCodePoint = normalized.codePointAt(normalizedCursor);
    const scaffoldCodePoint = scaffold.text.codePointAt(scaffoldCursor);
    const nextNormalized =
      normalizedCursor +
      (normalizedCodePoint !== undefined && normalizedCodePoint > 0xff_ff
        ? 2
        : 1);
    const nextScaffold =
      scaffoldCursor +
      (scaffoldCodePoint !== undefined && scaffoldCodePoint > 0xff_ff ? 2 : 1);
    if (
      normalized.codePointAt(nextNormalized) ===
      scaffold.text.codePointAt(nextScaffold)
    ) {
      appendChangedAlignment({
        mappings,
        normalizedEnd: nextNormalized,
        normalizedStart: normalizedCursor,
        scaffold,
        scaffoldEnd: nextScaffold,
        scaffoldStart: scaffoldCursor,
      });
      normalizedCursor = nextNormalized;
      scaffoldCursor = nextScaffold;
      continue;
    }

    const anchor = findAlignmentAnchor({
      normalized,
      normalizedFrom: normalizedCursor,
      scaffold: scaffold.text,
      scaffoldFrom: scaffoldCursor,
    });
    const nextNormalizedAnchor = anchor?.normalizedStart ?? normalized.length;
    const nextScaffoldAnchor = anchor?.scaffoldStart ?? scaffold.text.length;
    appendChangedAlignment({
      mappings,
      normalizedEnd: nextNormalizedAnchor,
      normalizedStart: normalizedCursor,
      scaffold,
      scaffoldEnd: nextScaffoldAnchor,
      scaffoldStart: scaffoldCursor,
    });
    normalizedCursor = nextNormalizedAnchor;
    scaffoldCursor = nextScaffoldAnchor;
  }

  appendChangedAlignment({
    mappings,
    normalizedEnd: normalized.length,
    normalizedStart: normalizedCursor,
    scaffold,
    scaffoldEnd: scaffold.text.length,
    scaffoldStart: scaffoldCursor,
  });
  return { mappings, text: normalized };
};

type ParsedHeadlineFragment = {
  highlights: SourceSpan[];
  text: string;
};

const parseHeadlineFragment = (fragment: string): ParsedHeadlineFragment => {
  let cursor = 0;
  let highlightStart: number | null = null;
  const highlights: SourceSpan[] = [];
  let text = "";

  while (cursor < fragment.length) {
    if (fragment.startsWith(HIGHLIGHT_START, cursor)) {
      highlightStart = text.length;
      cursor += HIGHLIGHT_START.length;
      continue;
    }
    if (fragment.startsWith(HIGHLIGHT_STOP, cursor)) {
      if (highlightStart !== null) {
        highlights.push({ start: highlightStart, end: text.length });
        highlightStart = null;
      }
      cursor += HIGHLIGHT_STOP.length;
      continue;
    }
    const codePoint = fragment.codePointAt(cursor);
    if (codePoint === undefined) {
      break;
    }
    const value = String.fromCodePoint(codePoint);
    text += value;
    cursor += value.length;
  }
  if (highlightStart !== null) {
    highlights.push({ start: highlightStart, end: text.length });
  }
  return { highlights, text };
};

const restoreFragment = ({
  fragment,
  normalizedSource,
  searchFrom,
  source,
}: {
  fragment: ParsedHeadlineFragment;
  normalizedSource: NormalizedSource;
  searchFrom: number;
  source: string;
}): { nextSearchFrom: number; text: string } | null => {
  if (!fragment.text) {
    return null;
  }
  const normalizedStart = normalizedSource.text.indexOf(
    fragment.text,
    searchFrom,
  );
  if (normalizedStart === -1) {
    return null;
  }
  const normalizedEnd = normalizedStart + fragment.text.length;
  const firstSpan = sourceSpanAt(normalizedSource, normalizedStart);
  const lastSpan = sourceSpanAt(normalizedSource, normalizedEnd - 1);
  if (!firstSpan || !lastSpan) {
    return null;
  }

  const sourceStart = firstSpan.start;
  const sourceEnd = lastSpan.end;
  let text = source.slice(sourceStart, sourceEnd);
  const restoredHighlights = fragment.highlights.flatMap((highlight) => {
    if (highlight.start >= highlight.end) {
      return [];
    }
    const firstHighlightSpan = sourceSpanAt(
      normalizedSource,
      normalizedStart + highlight.start,
    );
    const lastHighlightSpan = sourceSpanAt(
      normalizedSource,
      normalizedStart + highlight.end - 1,
    );
    return firstHighlightSpan && lastHighlightSpan
      ? [
          {
            start: firstHighlightSpan.start - sourceStart,
            end: lastHighlightSpan.end - sourceStart,
          },
        ]
      : [];
  });
  for (const highlight of restoredHighlights.toReversed()) {
    text =
      text.slice(0, highlight.start) +
      HIGHLIGHT_START +
      text.slice(highlight.start, highlight.end) +
      HIGHLIGHT_STOP +
      text.slice(highlight.end);
  }
  return { nextSearchFrom: normalizedEnd, text };
};

const truncateHighlightAware = (text: string, maxLength: number): string => {
  if (maxLength <= 0) {
    return "";
  }

  let cursor = 0;
  let highlightOpen = false;
  let highlightSuppressed = false;
  let truncated = "";
  while (cursor < text.length) {
    if (text.startsWith(HIGHLIGHT_START, cursor)) {
      cursor += HIGHLIGHT_START.length;
      if (
        !highlightOpen &&
        !highlightSuppressed &&
        truncated.length + HIGHLIGHT_START.length + HIGHLIGHT_STOP.length <=
          maxLength
      ) {
        truncated += HIGHLIGHT_START;
        highlightOpen = true;
      } else {
        highlightSuppressed = true;
      }
      continue;
    }
    if (text.startsWith(HIGHLIGHT_STOP, cursor)) {
      cursor += HIGHLIGHT_STOP.length;
      if (highlightOpen) {
        truncated += HIGHLIGHT_STOP;
        highlightOpen = false;
      }
      highlightSuppressed = false;
      continue;
    }

    const codePoint = text.codePointAt(cursor);
    if (codePoint === undefined) {
      break;
    }
    const value = String.fromCodePoint(codePoint);
    const reservedLength = highlightOpen ? HIGHLIGHT_STOP.length : 0;
    if (truncated.length + value.length + reservedLength > maxLength) {
      break;
    }
    truncated += value;
    cursor += value.length;
  }
  if (highlightOpen) {
    truncated += HIGHLIGHT_STOP;
  }
  return truncated;
};

export const restoreOriginalSearchPreview = ({
  headline,
  maxLength,
  normalizedSource,
  source,
  useUnaccent,
}: {
  headline: string;
  maxLength: number;
  normalizedSource: string;
  source: string;
  useUnaccent: boolean;
}): string => {
  const alignedSource = alignDatabaseNormalizedSource({
    normalized: normalizedSource,
    source,
    useUnaccent,
  });
  const restored: string[] = [];
  let searchFrom = 0;
  for (const rawFragment of headline.split(SEARCH_PREVIEW_FRAGMENT_DELIMITER)) {
    const parsedFragment = parseHeadlineFragment(rawFragment);
    if (!parsedFragment.text) {
      continue;
    }
    const fragment = restoreFragment({
      fragment: parsedFragment,
      normalizedSource: alignedSource,
      searchFrom,
      source,
    });
    if (!fragment) {
      break;
    }
    restored.push(fragment.text);
    searchFrom = fragment.nextSearchFrom;
  }
  const content =
    restored.length > 0
      ? restored.join(SEARCH_PREVIEW_FRAGMENT_SEPARATOR)
      : source;
  return truncateHighlightAware(content, maxLength);
};

/** HTML-escape text, then replace highlight markers with `<mark>` tags. */
export const escapeAndHighlight = (text: string): string => {
  const escaped = text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;");
  return escaped
    .replaceAll(HIGHLIGHT_START, "<mark>")
    .replaceAll(HIGHLIGHT_STOP, "</mark>");
};
