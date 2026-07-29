import { normalizeSearchText, stripDiacritics } from "@stll/text-normalize";

// Non-HTML delimiters injected by ts_headline / pdb.snippet().
// The headline is HTML-escaped server-side, then these markers
// are replaced with <mark> tags — safe because the markers
// consist only of alphanumerics and underscores.
export const HIGHLIGHT_START = "__HL_START__";
export const HIGHLIGHT_STOP = "__HL_STOP__";
export const SEARCH_PREVIEW_FRAGMENT_DELIMITER = "__HL_FRAGMENT__";

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

type SourceSpan = {
  end: number;
  start: number;
};

type NormalizedSource = {
  spans: SourceSpan[];
  text: string;
};

const normalizePreviewUnit = (text: string, useUnaccent: boolean): string => {
  const normalized = normalizeSearchText(text);
  return useUnaccent ? stripDiacritics(normalized) : normalized;
};

const normalizeSourceWithSpans = (
  source: string,
  useUnaccent: boolean,
): NormalizedSource => {
  let text = "";
  const spans: SourceSpan[] = [];
  let pendingWhitespace: SourceSpan | null = null;

  for (const match of source.matchAll(NORMALIZATION_UNIT)) {
    const value = match.at(0);
    const start = match.index;
    if (value === undefined || start === undefined) {
      continue;
    }
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
      text += " ";
      spans.push(pendingWhitespace);
    }
    pendingWhitespace = null;
    text += normalized;
    for (let index = 0; index < normalized.length; index += 1) {
      spans.push(span);
    }
  }

  return { spans, text };
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
  if (normalizedStart < 0) {
    return null;
  }
  const normalizedEnd = normalizedStart + fragment.text.length;
  const firstSpan = normalizedSource.spans.at(normalizedStart);
  const lastSpan = normalizedSource.spans.at(normalizedEnd - 1);
  if (!firstSpan || !lastSpan) {
    return null;
  }

  const sourceStart = firstSpan.start;
  const sourceEnd = lastSpan.end;
  let text = source.slice(sourceStart, sourceEnd);
  const restoredHighlights = fragment.highlights.flatMap((highlight) => {
    const firstHighlightSpan = normalizedSource.spans.at(
      normalizedStart + highlight.start,
    );
    const lastHighlightSpan = normalizedSource.spans.at(
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

export const restoreOriginalSearchPreview = ({
  headline,
  maxLength,
  source,
  useUnaccent,
}: {
  headline: string;
  maxLength: number;
  source: string;
  useUnaccent: boolean;
}): string => {
  const normalizedSource = normalizeSourceWithSpans(source, useUnaccent);
  const restored: string[] = [];
  let searchFrom = 0;
  for (const rawFragment of headline.split(SEARCH_PREVIEW_FRAGMENT_DELIMITER)) {
    const fragment = restoreFragment({
      fragment: parseHeadlineFragment(rawFragment),
      normalizedSource,
      searchFrom,
      source,
    });
    if (!fragment) {
      return source.slice(0, maxLength);
    }
    restored.push(fragment.text);
    searchFrom = fragment.nextSearchFrom;
  }
  return restored.join("...\n\n").slice(0, maxLength);
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
