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
 * Build the JSON-DSL query string the BOE search endpoint expects.
 * Mirrors the shape used by the upstream MCP-BOE client.
 */
export const buildSearchQuery = (input: BoeSearchQuery): string => {
  const parts: string[] = [];
  if (input.text) {
    const terms = input.text.trim();
    parts.push(`(titulo:(${terms}) OR texto:(${terms}))`);
  }
  if (input.title) {
    parts.push(`titulo:"${input.title}"`);
  }
  if (input.departmentCode) {
    parts.push(`departamento@codigo:${input.departmentCode}`);
  }
  if (input.legalRangeCode) {
    parts.push(`rango@codigo:${input.legalRangeCode}`);
  }
  if (input.matterCode) {
    parts.push(`materia@codigo:${input.matterCode}`);
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
