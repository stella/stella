import { panic } from "better-result";
import { diffArrays } from "diff";

import { LIMITS } from "@/api/lib/limits";

import { decisionBlockDeepLink } from "./case-law-decision-link";
import type { LocatedDecisionBlock } from "./case-law-decision-outline";

export const QUOTE_FUZZY_THRESHOLD = 0.75;

const normalizeChunk = (raw: string): string => {
  if (/^č\.\s*j\.$/u.test(raw)) {
    return "č. j.";
  }
  if (raw === "\u00ad" || /^-[ \t]*\r?\n/u.test(raw)) {
    return "";
  }
  if (/^\s/u.test(raw)) {
    return " ";
  }
  if (/^[„“”«»]$/u.test(raw)) {
    return '"';
  }
  if (/^[‚‘’]$/u.test(raw)) {
    return "'";
  }
  if (/^[‐‑‒–—−]$/u.test(raw)) {
    return "-";
  }
  return raw;
};

/** Offsets address UTF-16 code units in the original served text. */
export const normalizeQuote = (source: string) => {
  const characters: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  for (const match of source.matchAll(
    /č\.\s*j\.|(?<=\p{L})-[ \t]*\r?\n[ \t]*(?=\p{L})|\u00ad|\s+|[„“”«»]|[‚‘’]|[‐‑‒–—−]|./gsu,
  )) {
    const raw = match[0];
    const value = normalizeChunk(raw);
    const docketSpacing = /^č\.\s*j\.$/u.test(raw);
    if (value === " " && characters.at(-1) === " ") {
      ends[ends.length - 1] = match.index + raw.length;
      continue;
    }
    for (let index = 0; index < value.length; index += 1) {
      characters.push(value[index] ?? panic("Normalized character exists"));
      const local =
        docketSpacing && index >= 3 ? raw.indexOf("j") + index - 3 : index;
      const localEnd =
        docketSpacing && index === 2 ? raw.indexOf("j") : local + 1;
      starts.push(match.index + (value === raw || docketSpacing ? local : 0));
      ends.push(
        match.index + (value === raw || docketSpacing ? localEnd : raw.length),
      );
    }
  }
  return { text: characters.join(""), starts, ends };
};

const rawQuoteSegments = (text: string) =>
  text
    .split(/\[\s*(?:\.{3}|…)\s*\]|\(\s*(?:\.{3}|…)\s*\)|\.{3}|…/u)
    .map((segment) => segment.trim())
    .filter((segment) => normalizeQuote(segment).text.trim().length > 0);

const quoteSegments = (text: string) =>
  rawQuoteSegments(text).map((segment) => normalizeQuote(segment).text.trim());

const tokensOf = (text: string) =>
  [...text.matchAll(/[\p{L}\p{N}\p{M}]+|[^\s]/gu)].map((match) => ({
    text: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }));

export const quoteInputWithinBudget = (text: string) => {
  const segments = quoteSegments(text);
  return (
    segments.length > 0 &&
    segments.length <= LIMITS.caseLawQuoteMaxSegments &&
    segments.reduce((total, segment) => total + tokensOf(segment).length, 0) <=
      LIMITS.caseLawQuoteMaxTokens
  );
};

type Span = { start: number; end: number };
const exactSpans = (text: string, query: string): Span[] => {
  const spans: Span[] = [];
  let offset = 0;
  while (offset <= text.length - query.length) {
    const start = text.indexOf(query, offset);
    if (start === -1) {
      break;
    }
    spans.push({ start, end: start + query.length });
    offset = start + 1;
  }
  return spans;
};

/** Remove occurrences that cannot participate in any ordered segment chain. */
const orderedSpans = (segments: Span[][]): Span[][] | null => {
  let earliestEnd = 0;
  const forward: Span[][] = [];
  for (const occurrences of segments) {
    const minimumEnd = earliestEnd;
    const eligible = occurrences.filter(({ start }) => start >= minimumEnd);
    const first = eligible.at(0);
    if (first === undefined) {
      return null;
    }
    forward.push(eligible);
    earliestEnd = first.end;
  }
  let latestStart = Infinity;
  const backward: Span[][] = [];
  for (const occurrences of forward.toReversed()) {
    const maximumStart = latestStart;
    const eligible = occurrences.filter(({ end }) => end <= maximumStart);
    latestStart =
      eligible.at(-1)?.start ??
      panic("Forward chain remains possible backward");
    backward.push(eligible);
  }
  return backward.toReversed();
};

/** Semiglobal token edit distance: free document prefix, bounded query width. */
const closestSpan = (text: string, query: string) => {
  const document = tokensOf(text);
  const quote = tokensOf(query).map(({ text: word }) => word);
  const width = quote.length;
  let previous = Array.from({ length: width + 1 }, (_, index) => index);
  let previousStarts = Array.from({ length: width + 1 }, () => 0);
  let best = { distance: Infinity, start: 0, end: 0 };
  for (const [index, token] of document.entries()) {
    const current = [0];
    const starts = [index + 1];
    for (let column = 1; column <= width; column += 1) {
      const substitution =
        (previous[column - 1] ?? panic("DP cell exists")) +
        (quote[column - 1] === token.text ? 0 : 1);
      const insertion = (previous[column] ?? panic("DP cell exists")) + 1;
      const deletion = (current[column - 1] ?? panic("DP cell exists")) + 1;
      const cost = Math.min(substitution, insertion, deletion);
      current.push(cost);
      let alignmentStart = starts[column - 1];
      if (cost === substitution) {
        alignmentStart = previousStarts[column - 1];
      } else if (cost === insertion) {
        alignmentStart = previousStarts[column];
      }
      starts.push(alignmentStart ?? panic("DP start exists"));
    }
    const distance = current[width] ?? panic("Query column exists");
    const start = starts[width] ?? panic("Query start exists");
    if (start <= index && distance < best.distance) {
      best = { distance, start, end: index + 1 };
    }
    previous = current;
    previousStarts = starts;
  }
  const first = document.at(best.start);
  const last = document.at(best.end - 1);
  if (first === undefined || last === undefined) {
    return null;
  }
  const passageWords = document
    .slice(best.start, best.end)
    .map(({ text: word }) => word);
  return {
    start: first.start,
    end: last.end,
    similarity: Math.max(
      0,
      1 - best.distance / Math.max(width, passageWords.length),
    ),
    // Direction is stored passage -> supplied quote: removed means dropped by the quote.
    differences: diffArrays(passageWords, quote).map((change) => {
      if (change.added) {
        return { type: "added" as const, words: change.value };
      }
      if (change.removed) {
        return { type: "dropped" as const, words: change.value };
      }
      return { type: "equal" as const, words: change.value };
    }),
  };
};

type VerifyQuoteOptions = {
  text: string;
  quote: string;
  located: readonly LocatedDecisionBlock[];
  url: string | null;
};
export const verifyQuote = ({
  text,
  quote,
  located,
  url,
}: VerifyQuoteOptions) => {
  const normalized = normalizeQuote(text);
  const queries = quoteSegments(quote);
  if (!quoteInputWithinBudget(quote)) {
    return panic("Quote must pass the shared input schema");
  }
  const originalSpan = ({ start, end }: Span) => ({
    start: normalized.starts[start] ?? panic("Match starts in stored text"),
    end: normalized.ends[end - 1] ?? panic("Match ends in stored text"),
  });
  const locate = ({ start: originalStart, end: originalEnd }: Span) => {
    let low = 0;
    let high = located.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const block = located.at(middle) ?? panic("Located block exists");
      if (block.end <= originalStart) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    const paragraphs = [];
    for (let index = low; index < located.length; index += 1) {
      const block = located.at(index) ?? panic("Located block exists");
      if (block.start >= originalEnd) {
        break;
      }
      paragraphs.push({
        position: index + 1,
        label: block.label,
        headingPath: block.headingPath,
        ...decisionBlockDeepLink({ url, ...block }),
      });
    }
    return {
      start: originalStart,
      end: originalEnd,
      text: text.slice(originalStart, originalEnd),
      paragraphs,
    };
  };
  const exact = orderedSpans(
    queries.map((query, index) => {
      const spans = new Map<string, Span>();
      for (const span of exactSpans(normalized.text, query).map(originalSpan)) {
        spans.set(`${span.start}:${span.end}`, span);
      }
      // A literal substring remains exact even at a normalization boundary,
      // e.g. a quote ending immediately before a line-end hyphen's next word.
      for (const span of exactSpans(
        text,
        rawQuoteSegments(quote).at(index) ?? panic("Raw segment exists"),
      )) {
        spans.set(`${span.start}:${span.end}`, span);
      }
      return [...spans.values()].toSorted(
        (left, right) => left.start - right.start || left.end - right.end,
      );
    }),
  );
  if (exact !== null) {
    return {
      status: "exact" as const,
      verified: true as const,
      segments: queries.map((query, index) => ({
        text: query,
        occurrences: (exact[index] ?? panic("Segment occurrences exist")).map(
          locate,
        ),
      })),
    };
  }
  let after = 0;
  const segments = queries.map((query) => {
    const closest = closestSpan(normalized.text.slice(after), query);
    if (closest === null) {
      return { text: query, closest: null };
    }
    const span = { start: closest.start + after, end: closest.end + after };
    after = span.end;
    return {
      text: query,
      closest: {
        ...locate(originalSpan(span)),
        similarity: closest.similarity,
        differences: closest.differences,
      },
    };
  });
  return {
    verified: false as const,
    status: segments.every(
      ({ closest }) =>
        closest !== null && closest.similarity >= QUOTE_FUZZY_THRESHOLD,
    )
      ? ("fuzzy" as const)
      : ("not_found" as const),
    segments,
  };
};
