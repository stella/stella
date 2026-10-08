/** Query payload fields are excluded from every error-output boundary. */
export const QUERY_ERROR_OUTPUT_FIELDS = [
  "params",
  "parameters",
  "query",
  "querytext",
  "sql",
  "sqltext",
] as const;

/** Normalize field spelling, including qualified keys such as `db.sql_text`. */
export const isQueryErrorOutputKey = (key: string): boolean => {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, "");
  return QUERY_ERROR_OUTPUT_FIELDS.some((field) => normalized.endsWith(field));
};
