import type { MigrationLockAllowance } from "../migration-lock-census";

export const REQUEST_IDEMPOTENCY_LOCK_ALLOWANCES = [
  {
    migration: "20261025180100_request_idempotency_receipts",
    form: "add-foreign-key",
    reason:
      "The foreign keys are added to a newly created, empty receipt table and reference existing organization and user tables; validation scans no receipt rows. SHARE ROW EXCLUSIVE on the referenced tables is held until the migration transaction commits; lock acquisition is bounded by 1s lock_timeout and each statement by 5s statement_timeout.",
  },
  {
    migration: "20261025180100_request_idempotency_receipts",
    form: "row-level-security",
    reason:
      "RLS is enabled and forced only on the newly created, empty receipt table, without scanning rows. ACCESS EXCLUSIVE on that new table is held until the migration transaction commits; lock acquisition is bounded by 1s lock_timeout and each statement by 5s statement_timeout.",
  },
  {
    migration: "20261025180100_request_idempotency_receipts",
    form: "create-policy",
    reason:
      "The policies are installed only on the newly created, empty receipt table; their catalog lookups do not scan receipt rows. ACCESS EXCLUSIVE on that new table is held until the migration transaction commits; lock acquisition is bounded by 1s lock_timeout and each statement by 5s statement_timeout.",
  },
] as const satisfies readonly MigrationLockAllowance[];
