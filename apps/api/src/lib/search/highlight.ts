import { normalizeSearchText, stripDiacritics } from "@stll/text-normalize";

// Non-HTML delimiters injected by ts_headline / pdb.snippet().
// The headline is HTML-escaped server-side, then these markers
// are replaced with <mark> tags — safe because the markers
// consist only of alphanumerics and underscores.
export const HIGHLIGHT_START = "__HL_START__";
export const HIGHLIGHT_STOP = "__HL_STOP__";
export const SEARCH_PREVIEW_FRAGMENT_DELIMITER = "__HL_FRAGMENT__";
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
// PostgreSQL's unaccent.rules transliterates common Latin letters that
// Unicode NFD leaves intact. Keep the restoration key aligned with the
// normalized text passed to ts_headline.
const POSTGRES_UNACCENT_LATIN_RE = /[ÆÐØÞßæðøþĐđĦħıĸŁłŉŊŋŒœŦŧ]/gu;
const POSTGRES_UNACCENT_LATIN_FOLDS: Readonly<Record<string, string>> = {
  Æ: "AE",
  Ð: "D",
  Ø: "O",
  Þ: "TH",
  ß: "ss",
  æ: "ae",
  ð: "d",
  ø: "o",
  þ: "th",
  Đ: "D",
  đ: "d",
  Ħ: "H",
  ħ: "h",
  ı: "i",
  ĸ: "q",
  Ł: "L",
  ł: "l",
  ŉ: "'n",
  Ŋ: "N",
  ŋ: "n",
  Œ: "OE",
  œ: "oe",
  Ŧ: "T",
  ŧ: "t",
};
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

const normalizePreviewUnit = (text: string, useUnaccent: boolean): string => {
  const normalized = normalizeSearchText(text);
  if (!useUnaccent) {
    return normalized;
  }
  return stripDiacritics(normalized).replace(
    POSTGRES_UNACCENT_LATIN_RE,
    (value) => POSTGRES_UNACCENT_LATIN_FOLDS[value] ?? value,
  );
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
    const previous = mappings.at(-1);
    if (
      isLinear &&
      previous?.type === "linear" &&
      previous.normalizedEnd === normalizedStart &&
      previous.sourceEnd === span.start
    ) {
      previous.normalizedEnd = normalizedEnd;
      previous.sourceEnd = span.end;
      return;
    }
    if (isLinear) {
      mappings.push({
        type: "linear",
        normalizedStart,
        normalizedEnd,
        sourceStart: span.start,
        sourceEnd: span.end,
      });
      return;
    }
    mappings.push({
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

const sourceSpanAt = (
  normalizedSource: NormalizedSource,
  normalizedIndex: number,
): SourceSpan | null => {
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
    if (mapping.type === "atomic") {
      return { start: mapping.sourceStart, end: mapping.sourceEnd };
    }
    const offset = normalizedIndex - mapping.normalizedStart;
    return {
      start: mapping.sourceStart + offset,
      end: mapping.sourceStart + offset + 1,
    };
  }
  return null;
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
  source,
  useUnaccent,
}: {
  headline: string;
  maxLength: number;
  source: string;
  useUnaccent: boolean;
}): string => {
  const normalizedSource = normalizeSourceWithMappings(source, useUnaccent);
  const restored: string[] = [];
  let searchFrom = 0;
  for (const rawFragment of headline.split(SEARCH_PREVIEW_FRAGMENT_DELIMITER)) {
    const parsedFragment = parseHeadlineFragment(rawFragment);
    if (!parsedFragment.text) {
      continue;
    }
    const fragment = restoreFragment({
      fragment: parsedFragment,
      normalizedSource,
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
