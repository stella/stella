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
 * extended. `id` is `<repo-relative file>::<dotted path of named enclosing
 * functions>`; no line numbers, so unrelated edits do not move it. `writes`
 * counts them per target (`insert:entities`), so one write cannot be traded
 * for another under the same count.
 */
export type AuditMutationLedgerRow = {
  id: string;
  writes: Readonly<Record<string, number>>;
  reason: string;
};

const isTargetCounts = (value: unknown): value is Record<string, number> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.keys(value).length > 0 &&
  Object.values(value).every(
    (count) =>
      typeof count === "number" && Number.isInteger(count) && count > 0,
  );

const isLedgerRow = (value: unknown): value is AuditMutationLedgerRow =>
  typeof value === "object" &&
  value !== null &&
  "id" in value &&
  typeof value.id === "string" &&
  value.id.includes("::") &&
  "writes" in value &&
  isTargetCounts(value.writes) &&
  "reason" in value &&
  typeof value.reason === "string" &&
  value.reason.trim().length > 0;

export const parseAuditMutationLedger = (
  value: unknown,
  label: string,
): AuditMutationLedgerRow[] => {
  if (!Array.isArray(value) || !value.every(isLedgerRow)) {
    return panic(
      `${label} must be a list of reasoned { id, writes: { target: count } } rows`,
    );
  }
  const ids = value.map((row) => row.id);
  if (new Set(ids).size !== ids.length) {
    return panic(`${label} lists an owner twice`);
  }
  return value;
};

/** The rule's `budgets` option. */
export const auditMutationBudgets = (
  value: unknown,
): Record<string, Readonly<Record<string, number>>> =>
  Object.fromEntries(
    parseAuditMutationLedger(value, AUDIT_MUTATION_LEDGER_REL).map((row) => [
      row.id,
      row.writes,
    ]),
  );

/**
 * One member per budgeted write and target, so the membership guard sees a
 * raised count or a new target as an added member and a lowered one as a
 * removal.
 */
export const auditMutationLedgerMembers = (
  rows: readonly AuditMutationLedgerRow[],
): string[] =>
  rows.flatMap((row) =>
    Object.entries(row.writes).flatMap(([target, count]) =>
      Array.from(
        { length: count },
        (_, index) => `${row.id}#${target}#${index + 1}`,
      ),
    ),
  );
