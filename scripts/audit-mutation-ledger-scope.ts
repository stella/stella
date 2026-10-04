// Shared shape of the require-audit-on-mutation ledger: the lint config reads
// budgets from it, the generator writes it, and the membership guard reads
// its members. Kept free of heavy imports because oxlint.config.ts loads it.

import { panic } from "better-result";

/** Source the rule covers beyond handlers, with ledger budgets. */
export const AUDIT_MUTATION_LEDGER_SCOPE = [
  "apps/api/src/mcp/**/*.ts",
  "apps/api/src/lib/**/*.ts",
] as const;

export const AUDIT_MUTATION_LEDGER_REL =
  ".oxlint-plugins/require-audit-on-mutation-ledger.json";

/**
 * One owning function that held unaudited writes when the scope was
 * extended. `id` is `<repo-relative file>::<nearest named function>`; no line
 * numbers, so unrelated edits do not move it.
 */
export type AuditMutationLedgerRow = {
  id: string;
  writes: number;
  reason: string;
};

const isLedgerRow = (value: unknown): value is AuditMutationLedgerRow =>
  typeof value === "object" &&
  value !== null &&
  "id" in value &&
  typeof value.id === "string" &&
  value.id.includes("::") &&
  "writes" in value &&
  typeof value.writes === "number" &&
  Number.isInteger(value.writes) &&
  value.writes > 0 &&
  "reason" in value &&
  typeof value.reason === "string" &&
  value.reason.trim().length > 0;

export const parseAuditMutationLedger = (
  value: unknown,
  label: string,
): AuditMutationLedgerRow[] => {
  if (!Array.isArray(value) || !value.every(isLedgerRow)) {
    return panic(`${label} must be a list of reasoned { id, writes } rows`);
  }
  const ids = value.map((row) => row.id);
  if (new Set(ids).size !== ids.length) {
    return panic(`${label} lists an owner twice`);
  }
  return value;
};

/** The rule's `budgets` option. */
export const auditMutationBudgets = (value: unknown): Record<string, number> =>
  Object.fromEntries(
    parseAuditMutationLedger(value, AUDIT_MUTATION_LEDGER_REL).map((row) => [
      row.id,
      row.writes,
    ]),
  );

/**
 * One member per budgeted write, so the membership guard sees a raised count
 * as an added member and a lowered one as a removal.
 */
export const auditMutationLedgerMembers = (
  rows: readonly AuditMutationLedgerRow[],
): string[] =>
  rows.flatMap((row) =>
    Array.from({ length: row.writes }, (_, index) => `${row.id}#${index + 1}`),
  );
