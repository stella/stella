// The closed set of system actors: the identities a write takes when no
// member performed it. Two kinds:
//
// - Run actors write one aggregated `system_audit_runs` row per scheduler run
//   that changed something, with the counts their run declares below. Public
//   corpus maintenance, retention sweeps and other jobs with no tenant land
//   here, because `audit_logs` is keyed by organization.
// - Tenant actors stamp `audit_logs.user_id` on per-organization events whose
//   change no member made (memory lifecycle, provider webhooks).
//
// No imports: the require-audit-on-mutation lint rule loads this file.

/** Each run actor with the counts one of its runs reports. */
export const SYSTEM_RUN_ACTOR_COUNTS = {
  "system:sanctions-monitoring-fanout": [
    "freshnessQueued",
    "requestedOrganizations",
    "fannedOrganizations",
    "transitions",
  ],
  "system:operator-registrations": [
    "sinceEpochMilliseconds",
    "pageSize",
    "returned",
  ],
  "system:sanctions-refresh": [
    "activated",
    "activatedEntries",
    "unchanged",
    "held",
    "failed",
  ],
  "system:case-law-sitemap-refresh": ["shards", "pages"],
  "system:statute-sitemap-refresh": ["shards"],
  "system:case-law-browse-facet-refresh": ["buckets"],
  "system:case-law-raw-storage": [
    "sweptPrefixes",
    "failedSweeps",
    "migratedRows",
    "queuedSweeps",
  ],
  "system:registration-retention": [
    "verifications",
    "assertions",
    "replays",
    "registrations",
    "clients",
    "budgets",
  ],
  "system:usage-webhook-retention": ["redactedEvents"],
  "system:file-comparison-sweep": ["sweptUploads"],
  "system:corpus-index-job-detail-backfill": ["movedJobs"],
  "system:legislation-expression-id-backfill": ["claimedDocuments"],
  "system:audit-retention": ["deletedRuns"],
  "system:case-law-background-replay": [
    "attempted",
    "applied",
    "blocked",
    "failed",
  ],
  "system:review-organization-reset": [
    "deletedMatters",
    "deletedContacts",
    "deletedClauses",
    "deletedTemplates",
    "deletedPlaybooks",
    "sweptRows",
    "failedDeletes",
    "seededContacts",
    "seededMatters",
    "seededDocuments",
    "seededTasks",
    "seededTimeEntries",
    "seededClauses",
    "seededTemplates",
    "seededPlaybooks",
    "seededRateTables",
    "enabledTimeBilling",
    "seedFailed",
  ],
  "system:eu-corpus-completion": [
    "attempted",
    "applied",
    "unchanged",
    "reviewRequired",
    "failed",
  ],
} as const satisfies Record<`system:${string}`, readonly string[]>;

export type SystemRunActor = keyof typeof SYSTEM_RUN_ACTOR_COUNTS;

export const isSystemRunActor = (value: string): value is SystemRunActor =>
  Object.hasOwn(SYSTEM_RUN_ACTOR_COUNTS, value);

/** What one run of `A` changed, by the counts its actor declares. */
export type SystemAuditCounts<A extends SystemRunActor> = Readonly<
  Record<(typeof SYSTEM_RUN_ACTOR_COUNTS)[A][number], number>
>;

/** Actors stamped on organization audit rows no member performed. */
export const TENANT_SYSTEM_ACTOR = {
  sanctionsMonitoringDrain: "system:sanctions-monitoring-drain",
  sanctionsMonitoringBackfill: "system:sanctions-monitoring-backfill",
  memoryCurator: "system:memory-curator",
  memoryExtractor: "system:memory-extractor",
  usageProvider: "system:usage-provider",
} as const;

/** The shape the database CHECK enforces on `system_audit_runs.actor`. */
export const SYSTEM_ACTOR_PATTERN = /^system:[a-z][a-z0-9-]*$/u;
