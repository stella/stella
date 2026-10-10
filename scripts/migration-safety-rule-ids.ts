// Every rule scripts/check-migration-safety.ts enforces, which binds its rule
// definitions to this list at compile time. scripts/check-migration-baseline.ts
// diffs it against the merge base to tell whether a change introduces a rule,
// so the file must stay import-free: it is evaluated standalone from git.
export const MIGRATION_SAFETY_RULE_IDS = [
  "drop-object",
  "drop-column",
  "drop-column-identity",
  "drop-constraint",
  "rename-table-or-column",
  "rename-enum-value",
  "alter-column-type",
  "truncate-table",
  "delete-data",
  "set-unlogged",
  "disable-trigger",
  "unbounded-update",
  "insert-select",
  "merge",
  "create-table-as",
  "materialized-view-populate",
  "recursive-cte",
  "disable-row-level-security",
  "grant-privileges",
  "alter-policy",
  "permissive-policy",
  "security-definer",
  "change-owner",
  "set-schema",
  "high-volume-index-build",
  "on-conflict-column-target",
  "code-owned-table-write",
  "volatile-data-write",
  "high-volume-table-dml",
  "missing-lock-timeout",
  "missing-statement-timeout",
] as const;

export type MigrationSafetyRuleId = (typeof MIGRATION_SAFETY_RULE_IDS)[number];
