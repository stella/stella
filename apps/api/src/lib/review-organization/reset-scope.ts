import { panic, Result } from "better-result";
import { eq, inArray, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { chatThreads, userFiles } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { executedRows } from "@/api/lib/db/executed-rows";
import { cleanupFlowDefinitions } from "@/api/lib/flows/reset-cleanup";
import { inOrder } from "@/api/lib/review-organization/in-order";
import {
  REVIEW_RESET_SWEEP,
  SIGNAL_RESET_SCOUT_TABLE,
  SIGNAL_RESET_EVENT_TABLE,
  SIGNAL_RESET_SIGNAL_TABLE,
} from "@/api/lib/review-organization/reset-census";
import {
  cleanupScoutRuns,
  cleanupSignalEvents,
  cleanupSignals,
} from "@/api/lib/signals/reset-cleanup";

/**
 * Organization-scoped tables the reset leaves in place, each with its reason.
 * Every other table that holds organization data is cleared: listed in
 * `REVIEW_RESET_CLEARED_TABLES`, or removed by a cascade from one that is.
 * `reset-scope.test.ts` fails when a table is in neither.
 */
export const REVIEW_RESET_KEPT_TABLES = {
  member: "Membership: the review account stays in its organization.",
  invitation: "Membership: invitations belong to the organization's roster.",
  audit_logs: "Audit trail: append-only, and it records the reset itself.",
  organization_settings: "Organization settings, not reviewer content.",
  organization_access_states: "Organization access state, set by operators.",
  organization_configured_access: "Organization access, set by operators.",
  feature_enrolments:
    "The account's own feature preferences; the seed sets the ones it needs.",
  usage_allocations: "Usage ledger: budgets must survive the nightly reset.",
  usage_entitlements: "Usage ledger: entitlements are operator-managed.",
  usage_events: "Usage ledger: metered history for budgets and billing.",
  usage_lane_counters: "Usage ledger: rate-limit counters.",
  usage_seat_assignments: "Usage ledger: seat assignment of the member.",
  action_cost_calls: "Usage ledger: action cost history.",
  action_cost_records: "Usage ledger: action cost history.",
  hosted_checkout_claims: "Billing state, never reviewer content.",
  legal_list_verification_budgets: "Usage ledger: verification budget.",
  organization_file_objects:
    "Storage accounting, settled by the cleanup workers as objects are erased.",
  organization_file_usage:
    "Storage accounting, settled by the cleanup workers as objects are erased.",
  buffer_object_cleanup_intents:
    "Storage tombstones: they must outlive the rows they erase.",
  entity_deletion_cleanup_requests:
    "Storage tombstones: they must outlive the rows they erase.",
  template_deletion_cleanup_requests:
    "Storage tombstones: they must outlive the rows they erase.",
  mcp_oauth_clients: "OAuth data: never touched by the reset.",
  mcp_oauth_state: "OAuth data: never touched by the reset.",
  mcp_user_connections: "OAuth data: never touched by the reset.",
  mcp_connectors: "Integration credentials: never touched by the reset.",
  mcp_connector_authorization_reviews:
    "Integration authorization history: never touched by the reset.",
  sharepoint_connections: "OAuth data: never touched by the reset.",
  sharepoint_oauth_state: "OAuth data: never touched by the reset.",
  business_registry_credentials:
    "Integration credentials: never touched by the reset.",
  feedback_reports: "Product feedback the operators read.",
  sanctions_organization_marks:
    "Scheduler-maintained screening state; holds no reviewer content.",
  sanctions_monitoring_backfills:
    "Scheduler-maintained screening state; holds no reviewer content.",
} as const satisfies Record<string, string>;

/**
 * Matters leave through the authorized matter deletion before the sweep runs
 * (its own coverage test proves what goes with a matter); the sweep only runs
 * once none is left.
 */
export const REVIEW_RESET_MATTER_TABLE = "workspaces";

/** Tables without an organization column the sweep empties by hand first. */
export const REVIEW_RESET_MANUAL_TABLES = ["user_files"] as const;

const removedCount = (rows: unknown[]): number => {
  const first = rows.at(0);
  return typeof first === "object" &&
    first !== null &&
    "n" in first &&
    typeof first.n === "number"
    ? first.n
    : 0;
};

/**
 * Empty every cleared table for one organization, in the owner transaction
 * that already recorded the organization's storage erasure. Returns generic
 * table counts; feature owners record their own counts in the same transaction.
 */
type SweepReviewOrganizationOptions = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  subject: SafeId<"schedulerJobRun">;
};

export const sweepReviewOrganization = async ({
  tx,
  organizationId,
  subject,
}: SweepReviewOrganizationOptions): Promise<Map<string, number>> => {
  // audit: skip - the reset sweep; the run's totals go to the system audit
  const removed = new Map<string, number>();
  // Chat attachments name no organization; their rows hold their threads
  // (`user_files.thread_id` restricts), and the storage census already
  // recorded their objects. The organization deletion removes them the same way.
  const attachments = await tx
    .delete(userFiles)
    .where(
      inArray(
        userFiles.threadId,
        tx
          .select({ id: chatThreads.id })
          .from(chatThreads)
          .where(eq(chatThreads.organizationId, organizationId)),
      ),
    )
    .returning({ id: userFiles.id });
  const manualCounts = {
    user_files: attachments.length,
  } as const satisfies Record<
    (typeof REVIEW_RESET_MANUAL_TABLES)[number],
    number
  >;
  for (const [name, count] of Object.entries(manualCounts)) {
    removed.set(name, count);
  }
  const swept = await inOrder(REVIEW_RESET_SWEEP, async ([name, auditor]) => {
    switch (auditor) {
      case "flows":
        await cleanupFlowDefinitions({ tx, organizationId, subject });
        return Result.ok(undefined);
      case "signals":
        switch (name) {
          case SIGNAL_RESET_SCOUT_TABLE:
            await cleanupScoutRuns({ tx, organizationId, subject });
            return Result.ok(undefined);
          case SIGNAL_RESET_EVENT_TABLE:
            await cleanupSignalEvents({ tx, organizationId, subject });
            return Result.ok(undefined);
          case SIGNAL_RESET_SIGNAL_TABLE:
            await cleanupSignals({ tx, organizationId, subject });
            return Result.ok(undefined);
          default:
            name satisfies never;
            return panic("Unknown signal reset cleanup table");
        }
      case "generic":
        break;
      default:
        auditor satisfies never;
        return panic("Unknown reset sweep auditor");
    }
    // audit: skip - one table of the reset sweep; totals go to the system audit
    const rows = executedRows(
      await tx.execute(
        sql`WITH removed AS (DELETE FROM ${sql.identifier(name)} WHERE organization_id = ${organizationId} RETURNING 1) SELECT count(*)::int AS n FROM removed`,
      ),
    );
    removed.set(name, removedCount(rows));
    return Result.ok(undefined);
  });
  // Each table's delete either completes or throws out of the transaction.
  swept.unwrap("The sweep's table deletes report no errors");
  return removed;
};
