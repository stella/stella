/**
 * "Search within results" as a change to `q`, because `q` is the only text the
 * search endpoint reads: there is no second field to put a narrowing term in.
 *
 * Grammar assumption, verified against both read paths:
 *
 * - Corpus index (`apps/api/src/lib/legal-search/corpus-query.ts`):
 *   `tokenizeCorpusFreeText` splits `q` into phrase and term tokens and
 *   `corpusFreeTextClause` joins every token with `AND`, so an appended token
 *   is an additional *required* match. A span between straight double quotes
 *   is one phrase token, matched adjacently and verbatim (a phrase is never
 *   rewritten into other inflections).
 * - Postgres (`apps/api/src/lib/search/query.ts`): `q` is compiled with
 *   `plainto_tsquery`, which drops punctuation (quotes included) and ANDs
 *   every lexeme, so the same appended text is required there too — as
 *   separate lexemes rather than as one adjacent phrase.
 *
 * Narrowing therefore holds on both engines; only adjacency differs. Quoting
 * is also what makes the term removable: a quoted span is a segment this
 * module can find and strip again, where a bare word appended to the query
 * would be indistinguishable from the reader's own wording.
 */

const QUOTE = '"';

/** A balanced straight-quoted span of `query`, with its slice bounds. */
type QuotedSpan = { start: number; end: number; term: string };

/**
 * Balanced straight-quoted spans, in order. An unbalanced quote carries no
 * span: the engines degrade it to ordinary terms, so reading one as a phrase
 * here would offer a chip for a phrase the search never applied.
 */
const quotedSpans = (query: string): QuotedSpan[] => {
  const spans: QuotedSpan[] = [];
  let index = 0;
  while (index < query.length) {
    const open = query.indexOf(QUOTE, index);
    if (open === -1) {
      break;
    }
    const close = query.indexOf(QUOTE, open + 1);
    if (close === -1) {
      break;
    }
    spans.push({
      start: open,
      end: close + 1,
      term: query.slice(open + 1, close),
    });
    index = close + 1;
  }
  return spans;
};

/**
 * The refine entry as it will be written into `q`, or null when it carries
 * nothing to search for. Quotes are removed rather than escaped: a quote
 * inside the span would close it early and hand the remainder to the engine
 * as loose terms.
 */
export const normalizeRefineTerm = (entry: string): string | null => {
  const collapsed = entry.replaceAll(QUOTE, " ").replace(/\s+/gu, " ").trim();
  return collapsed.length === 0 ? null : collapsed;
};

/** The required phrases `q` carries, in order, without repeats. */
export const refineTermsOfQuery = (
  query: string | undefined,
): readonly string[] => {
  if (query === undefined) {
    return [];
  }
  const terms: string[] = [];
  for (const span of quotedSpans(query)) {
    const term = normalizeRefineTerm(span.term);
    if (term !== null && !terms.includes(term)) {
      terms.push(term);
    }
  }
  return terms;
};

/**
 * The query with every quote that has no partner dropped.
 *
 * Both engines already read an unbalanced quote as loose terms, so removing it
 * changes no result. It has to go before anything is appended: the stray quote
 * would otherwise pair with the one this module opens, and the phrase the
 * reader just asked for would be read as the text between the two — a chip
 * naming words they never refined, and no way to take the real one back out.
 */
const withoutUnpairedQuotes = (query: string): string => {
  const paired = new Set<number>();
  for (const span of quotedSpans(query)) {
    paired.add(span.start);
    paired.add(span.end - 1);
  }
  let kept = "";
  for (let index = 0; index < query.length; index += 1) {
    const character = query.charAt(index);
    if (character === QUOTE && !paired.has(index)) {
      continue;
    }
    kept += character;
  }
  return kept.replace(/\s+/gu, " ").trim();
};

/**
 * `q` with one more required phrase. Unchanged when the entry is blank or the
 * phrase is already required, so a second submit of the same words is a no-op
 * rather than a query that asks for them twice.
 */
export const addRefineTerm = (
  query: string | undefined,
  entry: string,
): string | undefined => {
  const term = normalizeRefineTerm(entry);
  if (term === null) {
    return query;
  }
  if (refineTermsOfQuery(query).includes(term)) {
    return query;
  }
  const base = withoutUnpairedQuotes(query ?? "");
  return base.length === 0
    ? `${QUOTE}${term}${QUOTE}`
    : `${base} ${QUOTE}${term}${QUOTE}`;
};

/**
 * `q` with every required phrase dropped and the words the reader typed kept,
 * or undefined when the phrases were all it asked for. What "clear filters"
 * does to the chips that live in the query rather than in a facet.
 */
export const withoutRefineTerms = (
  query: string | undefined,
): string | undefined => {
  if (query === undefined) {
    return undefined;
  }
  let next = query;
  // Back to front, so an earlier span's bounds still address `next`.
  for (const span of quotedSpans(query).toReversed()) {
    next = next.slice(0, span.start) + next.slice(span.end);
  }
  const collapsed = next.replace(/\s+/gu, " ").trim();
  return collapsed.length === 0 ? undefined : collapsed;
};

/**
 * `q` without a required phrase, or undefined when removing it leaves nothing
 * to search for.
 */
export const removeRefineTerm = (
  query: string | undefined,
  term: string,
): string | undefined => {
  if (query === undefined) {
    return undefined;
  }
  const normalized = normalizeRefineTerm(term);
  if (normalized === null) {
    return query;
  }
  let next = query;
  // Back to front, so an earlier span's bounds still address `next`.
  for (const span of quotedSpans(query).toReversed()) {
    if (normalizeRefineTerm(span.term) === normalized) {
      next = next.slice(0, span.start) + next.slice(span.end);
    }
  }
  const collapsed = next.replace(/\s+/gu, " ").trim();
  return collapsed.length === 0 ? undefined : collapsed;
};
