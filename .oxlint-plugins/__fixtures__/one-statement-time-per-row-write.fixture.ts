// Passive regression fixture for `one-statement-time-per-row-write/one-statement-time-per-row-write`.
//
// `oxlint-disable-next-line` directives suppress cases the rule MUST flag; if
// the rule regresses the directive goes unused and
// `--report-unused-disable-directives-severity=error` fails CI. Lines without a
// directive cover the allow-list and must keep passing.

declare const sql: (strings: TemplateStringsArray, ...values: unknown[]) => unknown;
declare const update: { set: (values: Record<string, unknown>) => unknown };

// --- Flagged: two clock reads in one row write ---
export const _a = update.set({
  expiresAt: sql`clock_timestamp()`,
  // oxlint-disable-next-line one-statement-time-per-row-write/one-statement-time-per-row-write
  updatedAt: sql`clock_timestamp()`,
});

// --- Allowed: one statement time for the whole row ---
// expect-clean: one-statement-time-per-row-write/one-statement-time-per-row-write
export const _b = update.set({
  expiresAt: sql`statement_timestamp()`,
  updatedAt: sql`statement_timestamp()`,
});
