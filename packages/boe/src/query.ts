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

const escapeQueryStringPhrase = (value: string): string =>
  value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');

/**
 * Build the JSON-DSL query string the BOE search endpoint expects.
 * Mirrors the shape used by the upstream MCP-BOE client.
 */
export const buildSearchQuery = (input: BoeSearchQuery): string => {
  const parts: string[] = [];
  if (input.text) {
    // Keep user free text literal: the query_string DSL (field clauses,
    // AND/OR, parentheses, colons) must never be reachable from input.
    // Mirror the corpus path (corpusFreeTextClause): keep only unicode
    // word characters, quote each term, AND them.
    const terms = input.text.match(/[\p{L}\p{N}]+/gu);
    if (terms && terms.length > 0) {
      const quoted = terms.map((term) => `"${term}"`).join(" AND ");
      parts.push(`(titulo:(${quoted}) OR texto:(${quoted}))`);
    }
  }
  if (input.title) {
    parts.push(`titulo:"${escapeQueryStringPhrase(input.title)}"`);
  }
  if (input.departmentCode) {
    parts.push(
      `departamento@codigo:"${escapeQueryStringPhrase(input.departmentCode)}"`,
    );
  }
  if (input.legalRangeCode) {
    parts.push(
      `rango@codigo:"${escapeQueryStringPhrase(input.legalRangeCode)}"`,
    );
  }
  if (input.matterCode) {
    parts.push(`materia@codigo:"${escapeQueryStringPhrase(input.matterCode)}"`);
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
