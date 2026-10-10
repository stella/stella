import { HIGH_VOLUME_TABLES } from "./high-volume-tables";

/** Tables whose access paths are checked by the query-plan registry. */
export const PLAN_GUARD_TABLES = [
  ...HIGH_VOLUME_TABLES,
  "legislation_documents",
  "legislation_search_documents",
  // Not corpus-sized, but its retention purge reads it by age every day.
  "system_audit_runs",
] as const;
