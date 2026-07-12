export type BoeSearchQuery = {
  /** Free-text search across both titulo and texto fields. */
  text?: string | undefined;
  /** Phrase-exact search restricted to the title. */
  title?: string | undefined;
  /** Department code (see /tablas-auxiliares/departamentos). */
  departmentCode?: string | undefined;
  /** Legal range code (Ley, Real Decreto, Orden, ...). */
  legalRangeCode?: string | undefined;
  /** Subject-matter code from the controlled vocabulary. */
  matterCode?: string | undefined;
  /** YYYYMMDD lower bound on fecha_publicacion. */
  dateFrom?: string | undefined;
  /** YYYYMMDD upper bound on fecha_publicacion. */
  dateTo?: string | undefined;
};

type QueryStringClause = { query_string: { query: string } };
type RangeClause = {
  range: { fecha_publicacion: { gte?: string; lte?: string } };
};
type CompoundQuery = QueryStringClause & Partial<RangeClause>;

/**
 * Branded marker for fragments of the BOE query_string Lucene DSL that are
 * known, by construction, to be free of unescaped attacker-controlled
 * reserved syntax (quotes, colons, parens, boolean keywords). A plain
 * `string` is not assignable to `QueryStringSafe`, so
 * `parts.push(\`x:${someRawInput}\`)` is a type error: the only ways to
 * produce a `QueryStringSafe` are `escapeQueryStringPhrase` (quote-escapes
 * untrusted input), `freeTextClause` (the tokenizer strips everything but
 * unicode word characters before quoting), and `fieldClause` (prefixes an
 * already-safe phrase with a compile-time-literal field name).
 */
declare const __queryStringSafeBrand: unique symbol;
type QueryStringSafe = string & {
  readonly [__queryStringSafeBrand]: "QueryStringSafe";
};

/** Wrap a fragment assembled entirely from literal DSL syntax (parens,
 * AND/OR, field prefixes) plus already-safe pieces. Not exported: every
 * call site lives in this module and is reviewable alongside the DSL it
 * emits. */
const rawClause = (value: string): QueryStringSafe =>
  // SAFETY: caller asserts `value` is composed only of literal DSL syntax
  // and already brand-verified-safe fragments; see call site.
  // eslint-disable-next-line typescript/no-unsafe-type-assertion
  value as QueryStringSafe;

const escapeQueryStringPhrase = (value: string): QueryStringSafe => {
  const escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  // SAFETY: quotes and backslashes are escaped above, so this phrase cannot
  // break out of the surrounding `"..."` it is wrapped in by `fieldClause`.
  // eslint-disable-next-line typescript/no-unsafe-type-assertion
  return escaped as QueryStringSafe;
};

/**
 * Build a `field:"phrase"` clause. `field` is always a compile-time string
 * literal from this module (never derived from `BoeSearchQuery` input);
 * `phrase` must already carry the `QueryStringSafe` brand, so the escaping
 * invariant cannot be bypassed by a future caller.
 */
const fieldClause = (field: string, phrase: QueryStringSafe): QueryStringSafe =>
  rawClause(`${field}:"${phrase}"`);

/**
 * Build the tokenized free-text OR-clause across titulo/texto. Terms are
 * extracted with a unicode word-character regex, so by construction they
 * cannot contain quotes, colons, parens, or boolean keywords; quoting and
 * ANDing them together needs no further escaping. Mirrors the corpus path
 * (corpusFreeTextClause).
 */
const freeTextClause = (text: string): QueryStringSafe | undefined => {
  const terms = text.match(/[\p{L}\p{N}]+/gu);
  if (!terms || terms.length === 0) {
    return undefined;
  }
  const quoted = terms.map((term) => `"${term}"`).join(" AND ");
  return rawClause(`(titulo:(${quoted}) OR texto:(${quoted}))`);
};

/**
 * Build the JSON-DSL query string the BOE search endpoint expects.
 * Mirrors the shape used by the upstream MCP-BOE client.
 */
export const buildSearchQuery = (input: BoeSearchQuery): string => {
  const parts: QueryStringSafe[] = [];
  if (input.text) {
    // Keep user free text literal: the query_string DSL (field clauses,
    // AND/OR, parentheses, colons) must never be reachable from input.
    const clause = freeTextClause(input.text);
    if (clause) {
      parts.push(clause);
    }
  }
  if (input.title) {
    parts.push(fieldClause("titulo", escapeQueryStringPhrase(input.title)));
  }
  if (input.departmentCode) {
    parts.push(
      fieldClause(
        "departamento@codigo",
        escapeQueryStringPhrase(input.departmentCode),
      ),
    );
  }
  if (input.legalRangeCode) {
    parts.push(
      fieldClause(
        "rango@codigo",
        escapeQueryStringPhrase(input.legalRangeCode),
      ),
    );
  }
  if (input.matterCode) {
    parts.push(
      fieldClause("materia@codigo", escapeQueryStringPhrase(input.matterCode)),
    );
  }

  const queryString = parts.join(" AND ");

  const compound: CompoundQuery = {
    query_string: { query: queryString },
  };

  if (input.dateFrom || input.dateTo) {
    const dateRange: { gte?: string; lte?: string } = {};
    if (input.dateFrom) {
      dateRange.gte = input.dateFrom;
    }
    if (input.dateTo) {
      dateRange.lte = input.dateTo;
    }
    compound.range = { fecha_publicacion: dateRange };
  }

  return JSON.stringify({ query: compound });
};
