/**
 * Convert free user text into a safe corpus-index query clause. The
 * engine's query string syntax (field clauses, AND/OR, parentheses,
 * quotes) must never be reachable from user input, mirroring how the
 * pg-fts path keeps user text literal via plainto_tsquery: keep only
 * unicode word characters, quote each term, AND them. Returns null when
 * no searchable term remains; callers return an empty page without
 * querying the engine.
 */
export const corpusFreeTextClause = (text: string): string | null => {
  const terms = text.match(/[\p{L}\p{N}]+/gu);
  if (!terms) {
    return null;
  }
  return `(${terms.map((term) => `"${term}"`).join(" AND ")})`;
};

/**
 * Quote a trusted-shape filter value for a corpus-index field clause.
 * Backslashes are escaped before quotes so a trailing backslash cannot
 * swallow the closing quote and let the remainder parse as DSL.
 */
export const quoteCorpusValue = (value: string): string =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
