import { panic, Result } from "better-result";
import { eq, inArray, sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import type { PgTable } from "drizzle-orm/pg-core";

import {
  GLOBAL_SCOPE_TABLES,
  ORG_SCOPE_TABLES,
} from "@/api/db/org-scope-registry";
import type { Transaction } from "@/api/db/root";
import { chatThreads, userFiles } from "@/api/db/schema";
import type { AuditRecorder } from "@/api/lib/audit-log";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createBackgroundAuditRecorder,
} from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { executedRows } from "@/api/lib/db/executed-rows";
import { cleanupFlowDefinitions } from "@/api/lib/flows/reset-cleanup";
import {
  WORKSPACE_DELETION_RETAINED_STAGES,
  WORKSPACE_DELETION_RETAINED_TABLES,
} from "@/api/lib/organization-storage-teardown";
import { inOrder } from "@/api/lib/review-organization/in-order";
import {
  REVIEW_RESET_SWEEP,
  SIGNAL_RESET_AUDITOR,
  SIGNAL_RESET_EVENT_TABLE,
  SIGNAL_RESET_SCOUT_TABLE,
  SIGNAL_RESET_SIGNAL_TABLE,
} from "@/api/lib/review-organization/reset-census";
import {
  cleanupScoutRuns,
  cleanupSignalEvents,
  cleanupSignals,
} from "@/api/lib/signals/reset-cleanup";
import { isRecord } from "@/api/lib/type-guards";

import { RegisteredReviewReset } from "../../db/review-reset-owner";
import { reviewResetAuditContext } from "./audit";

/**
 * Organization-scoped tables the reset leaves in place, each with its reason.
 * Every other table that holds organization data is cleared: listed in
 * `REVIEW_RESET_CLEARED_TABLES` or `REVIEW_RESET_BILLING_TABLES`, or removed
 * by a cascade from one that is.
 * `reset-scope.test.ts` fails when a table is in neither.
 */
export const REVIEW_RESET_KEPT_TABLES = {
  review_reset_organizations:
    "Migration-owned registration survives the organization reset.",
  member: "Membership: the review account stays in its organization.",
  invitation: "Membership: invitations belong to the organization's roster.",
  audit_logs: "Audit trail: append-only, and it records the reset itself.",
  organization_settings: "Organization settings, not reviewer content.",
  organization_access_states: "Organization access state, set by operators.",
  organization_configured_access: "Organization access, set by operators.",
  feature_enrolments:
    "The account's own feature preferences; the seed sets the ones it needs.",
  usage_allocations: "Usage ledger: budgets must survive the nightly reset.",
  push_devices:
    "The review account's own phone registrations for alerts; no reviewer content.",
  usage_entitlements: "Usage ledger: entitlements are operator-managed.",
  usage_events: "Usage ledger: metered history for budgets and billing.",
  usage_lane_counters: "Usage ledger: rate-limit counters.",
  usage_seat_assignments: "Usage ledger: seat assignment of the member.",
  action_cost_calls: "Usage ledger: action cost history.",
  action_cost_records: "Usage ledger: action cost history.",
  hosted_checkout_claims: "Billing state, never reviewer content.",
  organization_professional_use_acceptances:
    "The organization's professional-use acceptance; written once, never reviewer content.",
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
  mcp_web_handoff: "Short-lived OAuth state; never reviewer content.",
  mcp_oauth_clients: "OAuth data: never touched by the reset.",
  mcp_oauth_state: "OAuth data: never touched by the reset.",
  mcp_user_connections: "OAuth data: never touched by the reset.",
  service_oauth_clients: "OAuth data: never touched by the reset.",
  mcp_connectors: "Integration credentials: never touched by the reset.",
  mcp_connector_authorization_reviews:
    "Integration authorization history: never touched by the reset.",
  sharepoint_connections: "OAuth data: never touched by the reset.",
  sharepoint_oauth_state: "OAuth data: never touched by the reset.",
  business_registry_credentials:
    "Integration credentials: never touched by the reset.",
  feedback_reports: "Product feedback the operators read.",
  chat_content_v3_backfill_receipts:
    "Repair receipts the operators read; identifiers only, never chat content.",
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

const removedCount = (count: unknown): number => {
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
    panic("Reset sweep must return its non-negative deletion count");
  }
  return count;
};

const retainedTables: ReadonlySet<PgTable> = new Set(
  WORKSPACE_DELETION_RETAINED_TABLES,
);

type ReviewResetTableGraph = {
  tablesByName: ReadonlyMap<string, PgTable>;
  descendants: ReadonlyMap<PgTable, ReadonlySet<PgTable>>;
};

let reviewResetTableGraph: ReviewResetTableGraph | undefined;
const getReviewResetTableGraph = (): ReviewResetTableGraph => {
  if (reviewResetTableGraph !== undefined) {
    return reviewResetTableGraph;
  }
  const tables = [
    ...new Set([
      ...Object.values(ORG_SCOPE_TABLES).map(({ table }) => table),
      ...Object.values(GLOBAL_SCOPE_TABLES).map(({ table }) => table),
    ]),
  ];
  const tablesByName = new Map(
    tables.map((table) => [getTableConfig(table).name, table]),
  );
  const childrenByParent = new Map<PgTable, Set<PgTable>>();
  for (const child of tables) {
    for (const key of getTableConfig(child).foreignKeys) {
      const parent = key.reference().foreignTable;
      const children = childrenByParent.get(parent) ?? new Set<PgTable>();
      children.add(child);
      childrenByParent.set(parent, children);
    }
  }
  const descendants = new Map<PgTable, ReadonlySet<PgTable>>();
  for (const root of tables) {
    const found = new Set<PgTable>();
    const pending = [...(childrenByParent.get(root) ?? [])];
    while (pending.length > 0) {
      const table = pending.pop();
      if (table === undefined || found.has(table) || table === root) {
        continue;
      }
      found.add(table);
      pending.push(...(childrenByParent.get(table) ?? []));
    }
    descendants.set(root, found);
  }
  reviewResetTableGraph = { tablesByName, descendants };
  return reviewResetTableGraph;
};

/** Split related tables, including paths through tables outside the batch. */
export const planReviewResetGenericDeleteBatches = (
  names: readonly string[],
): string[][] => {
  const { tablesByName, descendants } = getReviewResetTableGraph();
  const batches: string[][] = [];
  let batch: string[] = [];
  for (const name of names) {
    const table =
      tablesByName.get(name) ?? panic(`Unknown reset table ${name}`);
    const conflicts = batch.some((previousName) => {
      const previous =
        tablesByName.get(previousName) ??
        panic(`Unknown reset table ${previousName}`);
      return (
        descendants.get(previous)?.has(table) === true ||
        descendants.get(table)?.has(previous) === true
      );
    });
    if (conflicts) {
      batches.push(batch);
      batch = [];
    }
    batch.push(name);
  }
  if (batch.length > 0) {
    batches.push(batch);
  }
  return batches;
};

const isBillingRoot = (table: PgTable) =>
  !getTableConfig(table).foreignKeys.some(
    (key) =>
      key.onDelete === "cascade" &&
      key.reference().foreignTable !== table &&
      retainedTables.has(key.reference().foreignTable),
  );

/**
 * Billing records outlive an authorized matter deletion, which refuses a
 * matter that still has them (`WORKSPACE_DELETION_RETAINED_TABLES`), so the
 * reset empties them before the matters, as the owner, stage by stage
 * (`WORKSPACE_DELETION_RETAINED_STAGES`). Only the roots are named: a
 * retained table that cascades from another goes with it.
 */
const REVIEW_RESET_BILLING_STAGES = WORKSPACE_DELETION_RETAINED_STAGES.map(
  (stage) =>
    stage.filter(isBillingRoot).map((table) => getTableConfig(table).name),
);

export const REVIEW_RESET_BILLING_TABLES = REVIEW_RESET_BILLING_STAGES.flat();

/**
 * Delete the organization's rows from `names` in one statement, so
 * restrictive references among them are checked once all are gone. Returns
 * the rows removed per table.
 */
const removeOrganizationRows = async (
  tx: Transaction,
  organizationId: SafeId<"organization">,
  names: readonly string[],
): Promise<Map<string, number>> => {
  const removals = names.map((name, index) => ({
    name,
    alias: sql.identifier(`removed_${index}`),
  }));
  // audit: skip - one step of the reset's table deletes; totals go to the system audit
  const rows = executedRows(
    await tx.execute(
      sql`WITH ${sql.join(
        removals.map(
          ({ name, alias }) =>
            sql`${alias} AS (DELETE FROM ${sql.identifier(name)} WHERE organization_id = ${organizationId} RETURNING 1)`,
        ),
        sql`, `,
      )} SELECT ${sql.join(
        removals.map(
          ({ name, alias }) =>
            sql`(SELECT count(*)::int FROM ${alias}) AS ${sql.identifier(name)}`,
        ),
        sql`, `,
      )}`,
    ),
  );
  const counts = rows.at(0);
  return new Map(
    removals.map(({ name }) => [
      name,
      removedCount(isRecord(counts) ? counts[name] : undefined),
    ]),
  );
};

/**
 * Empty the review organization's billing records while its matters still
 * stand, so the authorized matter deletion that follows can take them: one
 * statement per stage through the registered reset role and its organization
 * policies. Returns the rows removed per table.
 */
export const clearReviewOrganizationBilling = async (
  tx: Transaction,
  organizationId: SafeId<"organization">,
): Promise<Map<string, number>> => {
  const owner = await RegisteredReviewReset.admit({
    tx,
    organizationId,
    userId: null,
  });
  return await owner.run(async (scopedTx) => {
    const removed = new Map<string, number>();
    const cleared = await inOrder(
      REVIEW_RESET_BILLING_STAGES,
      async (stage) => {
        for (const [name, rows] of await removeOrganizationRows(
          scopedTx,
          organizationId,
          stage,
        )) {
          removed.set(name, rows);
        }
        return Result.ok(undefined);
      },
    );
    cleared.unwrap("The billing stages report no errors");
    return removed;
  });
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
  userId: SafeId<"user">;
};

type RemoveReviewAttachmentsOptions = {
  tx: Transaction;
  recordAuditEvent: AuditRecorder;
  organizationId: SafeId<"organization">;
};
const removeReviewAttachments = async ({
  tx: scopedTx,
  recordAuditEvent,
  organizationId,
}: RemoveReviewAttachmentsOptions) => {
  const attachments = await scopedTx
    .delete(userFiles)
    .where(
      inArray(
        userFiles.threadId,
        scopedTx
          .select({ id: chatThreads.id })
          .from(chatThreads)
          .where(eq(chatThreads.organizationId, organizationId)),
      ),
    )
    .returning({ id: userFiles.id });
  if (attachments.length > 0) {
    await recordAuditEvent(scopedTx, {
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
      resourceId: organizationId,
      metadata: {
        change: "review-attachments-cleared",
        deleted: attachments.length,
      },
    });
  }
  return attachments;
};

export const sweepReviewOrganization = async ({
  tx,
  organizationId,
  subject,
  userId,
}: SweepReviewOrganizationOptions): Promise<Map<string, number>> => {
  // audit: skip - the reset sweep; the run's totals go to the system audit
  const owner = await RegisteredReviewReset.admit({
    tx,
    organizationId,
    userId,
  });
  const removed = new Map<string, number>();
  // Chat attachments name no organization; their rows hold their threads
  // (`user_files.thread_id` restricts), and the storage census already
  // recorded their objects. The organization deletion removes them the same way.
  const events: Parameters<AuditRecorder>[1][] = [];
  const recordAttachmentAuditEvent: AuditRecorder = async (_auditTx, event) => {
    events.push(event);
    await Promise.resolve();
  };
  const attachments = await owner.run(
    async (scopedTx) =>
      await removeReviewAttachments({
        tx: scopedTx,
        recordAuditEvent: recordAttachmentAuditEvent,
        organizationId,
      }),
  );
  const recordAuditEvent = createBackgroundAuditRecorder(
    reviewResetAuditContext({
      organizationId,
      userId,
      workspaceId: null,
      runId: subject,
    }),
  );
  for (const event of events) {
    await recordAuditEvent(tx, event);
  }
  const manualCounts = {
    user_files: attachments.length,
  } as const satisfies Record<
    (typeof REVIEW_RESET_MANUAL_TABLES)[number],
    number
  >;
  for (const [name, count] of Object.entries(manualCounts)) {
    removed.set(name, count);
  }
  let genericTables: string[] = [];
  const flushGenericTables = async () => {
    if (genericTables.length === 0) {
      return;
    }
    const names = genericTables;
    genericTables = [];
    await owner.run(async (deleteTx) => {
      for (const batch of planReviewResetGenericDeleteBatches(names)) {
        for (const [name, count] of await removeOrganizationRows(
          deleteTx,
          organizationId,
          batch,
        )) {
          removed.set(name, count);
        }
      }
    });
  };
  for (const [name, auditor] of REVIEW_RESET_SWEEP) {
    if (auditor === "generic") {
      genericTables.push(name);
      continue;
    }
    // Preserve deletion order while lending one scope to each consecutive group.
    await flushGenericTables();
    switch (auditor) {
      case "flows":
        await cleanupFlowDefinitions({ tx, organizationId, subject });
        break;
      case SIGNAL_RESET_AUDITOR:
        switch (name) {
          case SIGNAL_RESET_SCOUT_TABLE:
            await cleanupScoutRuns({ tx, organizationId, subject });
            break;
          case SIGNAL_RESET_EVENT_TABLE:
            await cleanupSignalEvents({ tx, organizationId, subject });
            break;
          case SIGNAL_RESET_SIGNAL_TABLE:
            await cleanupSignals({ tx, organizationId, subject });
            break;
          default:
            name satisfies never;
            panic("Unknown signal reset cleanup table");
        }
        break;
      default:
        auditor satisfies never;
        panic("Unknown reset sweep auditor");
    }
  }
  await flushGenericTables();
  return removed;
};
