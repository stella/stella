// Which modules write only as a system run actor. A module listed here has
// every database write it holds attributed to its actor: the run that drives
// it records one aggregated `system_audit_runs` row through
// `recordSystemAudit`, so the require-audit-on-mutation rule accepts the
// module's writes without a per-function recorder or a skip directive.
//
// Only modules that no member request reaches belong here. Work a member
// started (flow runs, member-dispatched queues) records through that member's
// own actor instead, and MEMBER_RUN_MODULES keeps it out at compile time and
// in the lint rule.
//
// Only a type import: the lint rule loads this file.

import type { SystemRunActor } from "./actors";

export const SYSTEM_AUDIT_MODULES = {
  "apps/api/src/lib/db/operator-activity/read.ts": "system:operator-activity",
  "apps/api/src/lib/lists/sanctions/monitoring-fanout.ts":
    "system:sanctions-monitoring-fanout",
  "apps/api/src/lib/db/operator-registrations/read.ts":
    "system:operator-registrations",
  "apps/api/src/lib/lists/sanctions/refresh.ts": "system:sanctions-refresh",
  "apps/api/src/lib/case-law/sitemap-shard-refresh.ts":
    "system:case-law-sitemap-refresh",
  "apps/api/src/lib/legal-search/statute-sitemap-shard-refresh.ts":
    "system:statute-sitemap-refresh",
  "apps/api/src/lib/legal-search/pg-fts-browse-facet-refresh.ts":
    "system:case-law-browse-facet-refresh",
  "apps/api/src/lib/legal-search/legislation-facet-refresh.ts":
    "system:legislation-facet-refresh",
  "apps/api/src/lib/case-law/source-arrivals-refresh.ts":
    "system:case-law-source-arrivals-refresh",
  "apps/api/src/lib/scheduler/tasks/case-law-raw-storage.ts":
    "system:case-law-raw-storage",
  "apps/api/src/lib/scheduler/tasks/registration-retention.ts":
    "system:registration-retention",
  "apps/api/src/lib/hosted-usage-provider/webhook-retention.ts":
    "system:usage-webhook-retention",
  "apps/api/src/lib/uploads/file-comparison/sweep.ts":
    "system:file-comparison-sweep",
  "apps/api/src/lib/scheduler/tasks/corpus-index-job-detail-backfill.ts":
    "system:corpus-index-job-detail-backfill",
  "apps/api/src/lib/scheduler/tasks/legislation-expression-id-backfill.ts":
    "system:legislation-expression-id-backfill",
  "apps/api/src/lib/scheduler/tasks/system-audit-retention.ts":
    "system:audit-retention",
  "apps/api/src/handlers/case-law/ingestion/background-replay-store.ts":
    "system:case-law-background-replay",
  "apps/api/src/lib/legal-search/case-law-replay-audit.ts":
    "system:case-law-background-replay",
  "apps/api/src/handlers/case-law/ingestion/eu-completion-store.ts":
    "system:eu-corpus-completion",
} as const satisfies Record<string, SystemRunActor>;

export type SystemAuditModule = keyof typeof SYSTEM_AUDIT_MODULES;

/**
 * Modules whose writes run on behalf of a member (a flow run, a
 * member-dispatched queue). They can never be registered as system modules.
 */
export const MEMBER_RUN_MODULES = [
  "apps/api/src/lib/flows/flow-executor.ts",
  "apps/api/src/lib/workflow-queue.ts",
] as const;

type MemberRunModule = (typeof MEMBER_RUN_MODULES)[number];

/** Fails to compile when a member-run module is registered as a system module. */
export const MEMBER_RUN_MODULES_ARE_NEVER_SYSTEM: [
  Extract<SystemAuditModule, MemberRunModule>,
] extends [never]
  ? true
  : never = true;
