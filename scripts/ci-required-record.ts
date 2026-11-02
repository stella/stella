// The top-level keys of the required-jobs record ci-result writes, in order.
// Merge tooling outside this repository parses the record with exactly this
// key set, so a new or renamed key rejects every record until that parser
// changes too. The keys live here once: the workflow's record literal and
// every parser of the record in this repository are checked against them.
export const REQUIRED_RECORD_KEYS = [
  "version",
  "event",
  "head_sha",
  "base_sha",
  "run_id",
  "run_attempt",
  "depth",
  "coverage_profile",
  "reused_from_run_id",
  "basis",
  "pass_through_reason",
  "required",
  "not_required",
  "verdict",
] as const;
