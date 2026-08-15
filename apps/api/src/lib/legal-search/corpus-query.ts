/**
 * Quote a trusted-shape filter value for a corpus-index field clause.
 * Backslashes are escaped before quotes so a trailing backslash cannot
 * swallow the closing quote and let the remainder parse as DSL.
 */
export const quoteCorpusValue = (value: string): string =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

/**
 * Quote pairs a phrase may be written in. Straight quotes are symmetric; the
 * others are the typographic conventions of the corpus's own jurisdictions
 * (Czech/German „…“, Polish „…”, French/Russian «…», German »…«), so a phrase
 * pasted out of a judgment is read as a phrase rather than as loose words.
 *
 * Single quotes are deliberately absent: an apostrophe inside a word (l'État,
 * d'une) would open a span that never closes and swallow the rest of the query.
 * `“` is both an opener (English) and a valid closer for `„` (Czech); reading
 * it as an opener only where it starts a span keeps both conventions working.
 */
const PHRASE_QUOTE_CLOSERS = new Map<string, string>([
  ['"', '"'],
  ["“", "”"],
  ["„", "“”"],
  ["«", "»"],
  ["»", "«"],
]);

/**
 * Unicode word characters only, or null when the text holds none. Everything
 * the engine could parse as DSL is dropped here rather than escaped, inside a
 * phrase exactly as outside one.
 */
const corpusTerms = (text: string): RegExpMatchArray | null =>
  text.match(/[\p{L}\p{N}]+/gu);

/**
 * Index of the first character in `closers`, or -1. Every quote character is
 * in the BMP, so scanning UTF-16 units cannot split a surrogate pair into a
 * false match.
 */
const findPhraseEnd = (text: string, from: number, closers: string): number => {
  for (let index = from; index < text.length; index += 1) {
    if (closers.includes(text.charAt(index))) {
      return index;
    }
  }
  return -1;
};

/**
 * What one piece of user text asks the engine for. `value` is already reduced
 * to unicode word characters (a phrase's words separated by single spaces), so
 * a consumer never has to re-derive the safety rule. The distinction is not
 * cosmetic: a term may be rewritten — expanded to morphological variants, say —
 * where a phrase may not, because rewriting a phrase's words would silently
 * change what the reader asked to match adjacently.
 */
export type CorpusQueryToken =
  | { type: "phrase"; value: string }
  | { type: "term"; value: string };

/**
 * Split free user text into phrase and term tokens. The single splitter over
 * this input: anything that reads the query's structure (clause building,
 * rewriting) consumes these tokens rather than re-scanning the raw string,
 * so two scanners cannot drift into two answers about where a phrase ends.
 *
 * A balanced quoted span becomes one phrase token. An unbalanced quote carries
 * no span, so its text degrades to ordinary terms rather than to an engine
 * parse error; an empty span yields no token at all. Text without quotes yields
 * exactly the terms it always did.
 */
export const tokenizeCorpusFreeText = (text: string): CorpusQueryToken[] => {
  const tokens: CorpusQueryToken[] = [];
  let plain = "";

  const flushPlain = () => {
    const terms = corpusTerms(plain);
    plain = "";
    if (terms === null) {
      return;
    }
    for (const term of terms) {
      tokens.push({ type: "term", value: term });
    }
  };

  let index = 0;
  while (index < text.length) {
    const char = text.charAt(index);
    const closers = PHRASE_QUOTE_CLOSERS.get(char);
    if (closers === undefined) {
      plain += char;
      index += 1;
      continue;
    }

    const end = findPhraseEnd(text, index + 1, closers);
    if (end === -1) {
      index += 1;
      continue;
    }

    flushPlain();
    const words = corpusTerms(text.slice(index + 1, end));
    if (words !== null) {
      tokens.push({ type: "phrase", value: words.join(" ") });
    }
    index = end + 1;
  }
  flushPlain();

  return tokens;
};

/**
 * Convert free user text into a safe corpus-index query clause. The engine's
 * query string syntax (field clauses, AND/OR, parentheses, quotes) must never
 * be reachable from user input, mirroring how the pg-fts path keeps user text
 * literal via plainto_tsquery: keep only unicode word characters, quote each
 * token, AND them. Returns null when no searchable token remains; callers
 * return an empty page without querying the engine.
 *
 * `title` and `text` — the default search fields — record positions, so a bare
 * quoted clause is a positional phrase match over both. A phrase and a term are
 * quoted identically because a phrase is no more expressive than a term here:
 * only the grouping differs.
 */
export const corpusFreeTextClause = (text: string): string | null => {
  const clauses = tokenizeCorpusFreeText(text).map((token) => {
    switch (token.type) {
      case "phrase": {
        return quoteCorpusValue(token.value);
      }
      case "term": {
        return quoteCorpusValue(token.value);
      }
      default: {
        return token satisfies never;
      }
    }
  });

  if (clauses.length === 0) {
    return null;
  }
  return `(${clauses.join(" AND ")})`;
};

/**
 * Filters a case-law corpus query may carry, named after the index fields
 * rather than after either caller's request shape. `jurisdiction` is absent by
 * design: it selects the index, so a scoped query never needs a clause for it.
 */
export type CaseLawCorpusFilters = {
  court?: string | undefined;
  dateFrom?: string | undefined;
  dateTo?: string | undefined;
  documentType?: string | undefined;
  language?: string | undefined;
  source?: string | undefined;
};

/**
 * The one assembler for a case-law corpus-index query. Both read paths (the
 * public search handler and the shared search provider) go through it, so
 * there is a single answer to what the engine sees and a single escaping rule
 * to audit. Null when the free text carries no searchable term: callers return
 * an empty page rather than querying the engine.
 */
export const caseLawCorpusQuery = (
  text: string,
  filters: CaseLawCorpusFilters,
): string | null => {
  const freeText = corpusFreeTextClause(text);
  if (freeText === null) {
    return null;
  }

  const clauses: string[] = [freeText];
  if (filters.documentType) {
    clauses.push(`document_type:${quoteCorpusValue(filters.documentType)}`);
  }
  if (filters.source) {
    clauses.push(`source:${quoteCorpusValue(filters.source)}`);
  }
  if (filters.language) {
    clauses.push(`language:${quoteCorpusValue(filters.language)}`);
  }
  if (filters.court) {
    clauses.push(`court:${quoteCorpusValue(filters.court)}`);
  }
  if (filters.dateFrom || filters.dateTo) {
    clauses.push(
      `decision_date:[${filters.dateFrom ?? "*"} TO ${filters.dateTo ?? "*"}]`,
    );
  }
  return clauses.join(" AND ");
};
