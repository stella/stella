declare const sql: (text: TemplateStringsArray, ...values: unknown[]) => unknown;
declare const rows: unknown;
declare const payload: string;
// Planted list whose length follows the data; no-variable-arity-values must report it.
// oxlint-disable-next-line no-variable-arity-values/no-variable-arity-values -- planted list must stay reported
export const reported = sql`WITH e(id) AS (VALUES ${rows}) SELECT * FROM e`;
// expect-clean: no-variable-arity-values/no-variable-arity-values
export const clean = sql`SELECT * FROM jsonb_to_recordset(${payload}::text::jsonb) AS row(id uuid)`;
