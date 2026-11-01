import { panic, Result } from "better-result";
import { and, inArray, isNull, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { LEGAL_HOLD_ACTIVE } from "@stll/api-contract/legal-holds";

import { organization } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  aiMemories,
  chatMessages,
  chatThreads,
  desktopEditSessions,
  documentProcessingRuns,
  entities,
  entityVersions,
  fields,
  fileChatThreads,
  folioCollabRooms,
  legalHolds,
  pdfSigningSessions,
  pendingUploads,
  userFiles,
  workspaceContacts,
  workspaces,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import {
  lockLegalHoldOrganizations,
  lockOrganizationRowWithLegalHoldFence,
  readLockedLegalHolds,
} from "@/api/lib/db/aggregate-lock";

import { LegalHoldActiveError, LegalHoldRecord } from "./errors";
import type { HoldSummary } from "./errors";

export type HoldTarget =
  | { type: "matter"; workspaceId: SafeId<"workspace"> }
  | { type: "entity"; entityId: SafeId<"entity"> }
  | { type: "entities"; entityIds: readonly SafeId<"entity">[] }
  | { type: "entityVersion"; entityVersionId: SafeId<"entityVersion"> }
  | {
      type: "file";
      fileId: string;
      workspaceId?: SafeId<"workspace">;
      objectKey?: string;
    }
  | { type: "files"; objectKeys: readonly string[] }
  | { type: "contacts"; ids: readonly SafeId<"contact">[] }
  | { type: "thread"; threadId: SafeId<"chatThread"> }
  | { type: "account"; userId: SafeId<"user"> }
  | { type: "organization" };

type FenceMode = "share" | "update";

/**
 * What one transaction already holds: the organization fences it took and the
 * hold targets it proved clear under them. Both last until the transaction
 * ends (the fences are transaction-scoped advisory locks), so a second take
 * of a fence the transaction holds, or a second check of a target it proved
 * clear, is answered here without a statement.
 */
type TransactionHoldState = {
  fences: Map<string, FenceMode>;
  clear: Set<string>;
  /** Organizations this transaction read without any active hold. */
  clearOrganizations: Set<string>;
};
const transactionHoldStates = new WeakMap<Transaction, TransactionHoldState>();

const holdStateOf = (tx: Transaction): TransactionHoldState => {
  const existing = transactionHoldStates.get(tx);
  if (existing !== undefined) {
    return existing;
  }
  const created: TransactionHoldState = {
    fences: new Map(),
    clear: new Set(),
    clearOrganizations: new Set(),
  };
  transactionHoldStates.set(tx, created);
  return created;
};

const holdsFence = (held: FenceMode | undefined, mode: FenceMode) =>
  held === "update" || (held === "share" && mode === "share");

// An empty active-hold set cannot be locked with FOR SHARE. The organization
// row is the placement fence, including the first hold. Lock order is the
// organization fence, then hold rows, then resource rows. One statement takes
// every fence the transaction does not hold yet, in organization ID order.
const fenceOrganizations = async ({
  tx,
  organizationIds,
  mode,
}: {
  tx: Transaction;
  organizationIds: readonly SafeId<"organization">[];
  mode: FenceMode;
}) => {
  const state = holdStateOf(tx);
  const missing = [...new Set(organizationIds)].filter(
    (id) => !holdsFence(state.fences.get(id), mode),
  );
  if (missing.length === 0) {
    return;
  }
  await lockLegalHoldOrganizations({
    tx,
    predicate: inArray(organization.id, missing),
    mode,
  });
  for (const id of missing) {
    state.fences.set(id, mode);
  }
};

export const lockLegalHoldOrganization = async ({
  tx,
  organizationId,
  mode = "update",
}: {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  mode?: FenceMode;
}) => {
  await fenceOrganizations({ tx, organizationIds: [organizationId], mode });
};

/**
 * Placement and release change the hold set under the exclusive fence, so a
 * target this transaction proved clear before must be checked again.
 */
export const forgetClearHoldTargets = (tx: Transaction) => {
  const state = holdStateOf(tx);
  state.clear.clear();
  state.clearOrganizations.clear();
};

/**
 * Open a transaction that works on a whole organization (the review reset):
 * one statement locks the organization row, takes the object-intent lifecycle
 * lock and the exclusive hold fence, in the order every deletion takes them.
 * Later takes of either lock in this transaction are no-ops. Returns whether
 * the organization exists.
 */
export const lockOrganizationForWholeOrganizationWork = async ({
  tx,
  organizationId,
}: {
  tx: Transaction;
  organizationId: SafeId<"organization">;
}): Promise<boolean> => {
  const exists = await lockOrganizationRowWithLegalHoldFence({
    tx,
    organizationId,
  });
  if (exists) {
    holdStateOf(tx).fences.set(organizationId, "update");
  }
  return exists;
};

/**
 * Whether the organization has an active hold, as a column for a statement
 * that runs after the organization's fence in the same transaction.
 */
export const organizationHasActiveHold = (
  organizationId: SafeId<"organization">,
): SQL<boolean> =>
  sql<boolean>`EXISTS (SELECT 1 FROM ${legalHolds} WHERE ${legalHolds.organizationId} = ${organizationId} AND ${legalHolds.releasedAt} IS NULL)`;

/**
 * Settle an `organizationHasActiveHold` read taken under this transaction's
 * fence. A clear organization answers every later hold check in the
 * transaction without a statement; an active hold refuses with the holds
 * that block it.
 */
export const settleOrganizationHoldRead = async ({
  tx,
  organizationId,
  activeHold,
}: {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  activeHold: boolean;
}): Promise<Result<void, LegalHoldActiveError>> => {
  const state = holdStateOf(tx);
  if (state.fences.get(organizationId) === undefined) {
    return panic("A hold read must follow the organization's fence");
  }
  if (!activeHold) {
    state.clearOrganizations.add(organizationId);
    return Result.ok();
  }
  return await requireNoHold({
    tx,
    organizationId,
    target: { type: "organization" },
  });
};

const heldWorkspace = sql`coalesce(${legalHolds.workspaceId}, (SELECT e.workspace_id FROM ${entities} e WHERE e.id = ${legalHolds.entityId}))`;

const threadMatterPredicate = sql`c.id IN (
  SELECT id FROM ${chatThreads} WHERE workspace_id = ${heldWorkspace} OR data_workspace_ids @> ARRAY[${heldWorkspace}]::uuid[]
  UNION SELECT thread_id FROM ${chatMessages} WHERE workspace_id = ${heldWorkspace}
  UNION SELECT chat_thread_id FROM ${fileChatThreads} WHERE workspace_id = ${heldWorkspace}
)`;

const accountMatterPredicate = (userId: SafeId<"user">) => sql`EXISTS (
  SELECT 1 FROM ${chatThreads} c WHERE c.user_id = ${userId} AND ${threadMatterPredicate}
  UNION ALL SELECT 1 FROM ${folioCollabRooms} r WHERE r.seed_claimed_by = ${userId} AND r.workspace_id = ${heldWorkspace}
  UNION ALL SELECT 1 FROM ${desktopEditSessions} d WHERE d.created_by = ${userId} AND d.workspace_id = ${heldWorkspace}
  UNION ALL SELECT 1 FROM ${pdfSigningSessions} p WHERE p.created_by = ${userId} AND p.workspace_id = ${heldWorkspace}
  UNION ALL SELECT 1 FROM ${pendingUploads} p WHERE p.user_id = ${userId} AND p.workspace_id = ${heldWorkspace}
  UNION ALL SELECT 1 FROM ${aiMemories} m WHERE (m.user_id = ${userId} OR m.created_by = ${userId}) AND (m.workspace_id = ${heldWorkspace} OR m.source_data_workspace_ids @> ARRAY[${heldWorkspace}]::uuid[])
)`;

const fieldFilePredicate = (fileId: SQL) => sql`EXISTS (
  SELECT 1 FROM ${fields} f JOIN ${entityVersions} v ON v.id = f.entity_version_id
  WHERE (f.file_id::text = ${fileId} OR f.content->>'id' = ${fileId} OR f.content->>'pdfFileId' = ${fileId} OR f.content->>'thumbnailFileId' = ${fileId})
    AND (${legalHolds.workspaceId} = f.workspace_id OR ${legalHolds.entityId} = v.entity_id)
)`;

export const holdTargetPredicate = (target: HoldTarget): SQL => {
  switch (target.type) {
    case "organization":
      return sql`true`;
    case "matter":
      return sql`${heldWorkspace} = ${target.workspaceId}`;
    case "entity":
      return sql`EXISTS (SELECT 1 FROM ${entities} e WHERE e.id = ${target.entityId} AND (${legalHolds.entityId} = e.id OR ${legalHolds.workspaceId} = e.workspace_id))`;
    case "entities":
      return target.entityIds.length === 0
        ? sql`false`
        : sql`EXISTS (SELECT 1 FROM ${entities} e WHERE e.id IN (${sql.join(
            target.entityIds.map((id) => sql`${id}`),
            sql`, `,
          )}) AND (${legalHolds.entityId} = e.id OR ${legalHolds.workspaceId} = e.workspace_id))`;
    case "entityVersion":
      return sql`EXISTS (SELECT 1 FROM ${entityVersions} v WHERE v.id = ${target.entityVersionId} AND (${legalHolds.entityId} = v.entity_id OR ${legalHolds.workspaceId} = v.workspace_id))`;
    case "contacts":
      return target.ids.length === 0
        ? sql`false`
        : sql`EXISTS (
      SELECT 1 FROM ${workspaces} w WHERE w.id = ${heldWorkspace} AND w.client_id IN (${sql.join(
        target.ids.map((id) => sql`${id}`),
        sql`, `,
      )})
      UNION ALL SELECT 1 FROM ${workspaceContacts} wc WHERE wc.workspace_id = ${heldWorkspace} AND wc.contact_id IN (${sql.join(
        target.ids.map((id) => sql`${id}`),
        sql`, `,
      )})
    )`;
    case "thread":
      return sql`EXISTS (SELECT 1 FROM ${chatThreads} c WHERE c.id = ${target.threadId} AND ${threadMatterPredicate})`;
    case "account":
      return accountMatterPredicate(target.userId);
    case "files":
      return target.objectKeys.length === 0
        ? sql`false`
        : sql`EXISTS (
      SELECT 1 FROM unnest(ARRAY[${sql.join(
        target.objectKeys.map((key) => sql`${key}`),
        sql`, `,
      )}]::text[]) requested_key
      WHERE EXISTS (
        SELECT 1 WHERE ${legalHolds.workspaceId}::text = split_part(requested_key, '/', 2)
        UNION ALL SELECT 1 WHERE ${fieldFilePredicate(sql`split_part(split_part(requested_key, '/', 3), '.', 1)`)}
        UNION ALL SELECT 1 FROM ${documentProcessingRuns} dp WHERE dp.id::text = split_part(split_part(requested_key, '/', 4), '.', 1) AND dp.entity_id = ${legalHolds.entityId}
        UNION ALL SELECT 1 FROM ${folioCollabRooms} r WHERE r.entity_id = ${legalHolds.entityId} AND (r.yjs_snapshot_file_id::text = split_part(split_part(requested_key, '/', 3), '.', 1) OR r.docx_checkpoint_file_id::text = split_part(split_part(requested_key, '/', 3), '.', 1))
        UNION ALL SELECT 1 FROM ${desktopEditSessions} d WHERE d.entity_id = ${legalHolds.entityId} AND d.checkpoint_file_id::text = split_part(split_part(requested_key, '/', 3), '.', 1)
        UNION ALL SELECT 1 FROM ${userFiles} uf JOIN ${chatThreads} c ON c.id = uf.thread_id WHERE (uf.s3_key = requested_key OR uf.thumbnail_file_id = split_part(split_part(requested_key, '/', 2), '.', 1)) AND ${threadMatterPredicate}
      )
    )`;
    case "file":
      return sql`EXISTS (
      SELECT 1 WHERE ${target.objectKey ? holdTargetPredicate({ type: "files", objectKeys: [target.objectKey] }) : sql`false`}
      UNION ALL SELECT 1 WHERE ${target.workspaceId ? sql`${legalHolds.workspaceId} = ${target.workspaceId}` : sql`false`}
      UNION ALL SELECT 1 WHERE ${fieldFilePredicate(sql`${target.fileId}`)}
      UNION ALL SELECT 1 FROM ${userFiles} uf JOIN ${chatThreads} c ON c.id = uf.thread_id WHERE (uf.id::text = ${target.fileId} OR uf.thumbnail_file_id = ${target.fileId}) AND ${threadMatterPredicate}
    )`;
    default:
      target satisfies never;
      return panic("Unknown hold target");
  }
};

type HoldOptions = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  target: HoldTarget;
};
type HoldsAcrossOptions = {
  tx: Transaction;
  organizationIds: readonly SafeId<"organization">[];
  target: HoldTarget;
};

const clearTargetKey = (
  organizationIds: readonly SafeId<"organization">[],
  target: HoldTarget,
) => JSON.stringify([[...organizationIds].toSorted(), target]);

/**
 * The active holds that block `target` in any of the organizations: their
 * fences first (one statement for those the transaction does not hold), then
 * one read of the holds after the fences.
 */
const holdsBlockingAcross = async ({
  tx,
  organizationIds,
  target,
}: HoldsAcrossOptions): Promise<
  { type: "clear" } | { type: "held"; holds: HoldSummary[] }
> => {
  if (organizationIds.length === 0) {
    return { type: "clear" };
  }
  const state = holdStateOf(tx);
  const key = clearTargetKey(organizationIds, target);
  if (
    state.clear.has(key) ||
    organizationIds.every((id) => state.clearOrganizations.has(id))
  ) {
    return { type: "clear" };
  }
  await fenceOrganizations({
    tx,
    organizationIds,
    mode: target.type === "contacts" ? "update" : "share",
  });
  const rows = await readLockedLegalHolds({
    tx,
    predicate:
      and(
        inArray(legalHolds.organizationId, [...new Set(organizationIds)]),
        isNull(legalHolds.releasedAt),
        holdTargetPredicate(target),
      ) ?? panic("Missing hold predicate"),
    mode: "share",
  });
  if (rows.length === 0) {
    state.clear.add(key);
    return { type: "clear" };
  }
  const entityIds = rows.flatMap((row) => (row.entityId ? [row.entityId] : []));
  const entityRows =
    entityIds.length === 0
      ? []
      : await tx
          .select({ id: entities.id, workspaceId: entities.workspaceId })
          .from(entities)
          .where(
            sql`${entities.id} IN (${sql.join(
              entityIds.map((id) => sql`${id}`),
              sql`, `,
            )})`,
          );
  const holds = rows.map((row) => {
    const workspaceId =
      row.workspaceId ??
      entityRows.find((entity) => entity.id === row.entityId)?.workspaceId;
    if (!workspaceId) {
      return panic("Legal hold target has no matter");
    }
    return new LegalHoldRecord({
      id: row.id,
      scope: row.scopeType,
      workspaceId,
      entityId: row.entityId,
      placedAt: row.placedAt,
      placedBy: row.placedBy,
      reason: row.reason,
    });
  });
  return { type: "held", holds };
};

export const holdsBlocking = async ({
  tx,
  organizationId,
  target,
}: HoldOptions) =>
  await holdsBlockingAcross({ tx, organizationIds: [organizationId], target });

export const requireNoHold = async ({
  tx,
  organizationId,
  target,
}: HoldOptions): Promise<Result<void, LegalHoldActiveError>> =>
  await requireNoHoldAcross({
    tx,
    organizationIds: [organizationId],
    target,
  });

/** One fenced check of `target` across several organizations. */
export const requireNoHoldAcross = async (
  options: HoldsAcrossOptions,
): Promise<Result<void, LegalHoldActiveError>> => {
  const outcome = await holdsBlockingAcross(options);
  if (outcome.type === "clear") {
    return Result.ok();
  }
  return Result.err(
    new LegalHoldActiveError({
      code: LEGAL_HOLD_ACTIVE,
      message: "An active legal hold prevents deletion.",
      holds: outcome.holds,
    }),
  );
};

export const heldMatterIdsForAccount = async ({
  tx,
  organizationIds,
  userId,
}: {
  tx: Transaction;
  organizationIds: readonly SafeId<"organization">[];
  userId: SafeId<"user">;
}) => {
  // Account erasure is system-scoped: former memberships must not hide retained evidence.
  const accountOrganizations = sql`SELECT organization_id FROM ${chatThreads} WHERE user_id = ${userId}
    UNION SELECT organization_id FROM ${aiMemories} WHERE user_id = ${userId} OR created_by = ${userId}
    UNION SELECT organization_id FROM ${pendingUploads} WHERE user_id = ${userId}
    UNION SELECT w.organization_id FROM ${workspaces} w JOIN ${folioCollabRooms} r ON r.workspace_id = w.id WHERE r.seed_claimed_by = ${userId}
    UNION SELECT w.organization_id FROM ${workspaces} w JOIN ${desktopEditSessions} d ON d.workspace_id = w.id WHERE d.created_by = ${userId}
    UNION SELECT w.organization_id FROM ${workspaces} w JOIN ${pdfSigningSessions} p ON p.workspace_id = w.id WHERE p.created_by = ${userId}`;
  const membershipOrganizations =
    organizationIds.length === 0
      ? sql`false`
      : sql`${organization.id} IN (${sql.join(
          organizationIds.map((id) => sql`${id}`),
          sql`, `,
        )})`;
  const organizations = await lockLegalHoldOrganizations({
    tx,
    predicate: sql`${organization.id} IN (SELECT id FROM ${organization} WHERE ${membershipOrganizations} UNION SELECT id FROM ${organization} WHERE ${organization.id} IN (${accountOrganizations}))`,
  });
  if (organizations.length === 0) {
    return [];
  }
  const ids = sql.join(
    organizations.map(({ id }) => sql`${id}`),
    sql`, `,
  );
  const userContent = accountMatterPredicate(userId);
  const rows = await readLockedLegalHolds({
    tx,
    predicate:
      and(
        sql`${legalHolds.organizationId} IN (${ids})`,
        isNull(legalHolds.releasedAt),
        userContent,
      ) ?? panic("Missing account hold predicate"),
    mode: "share",
  });
  const entityIds = rows.flatMap((row) => (row.entityId ? [row.entityId] : []));
  const entityRows =
    entityIds.length === 0
      ? []
      : await tx
          .select({ workspaceId: entities.workspaceId })
          .from(entities)
          .where(
            sql`${entities.id} IN (${sql.join(
              entityIds.map((id) => sql`${id}`),
              sql`, `,
            )})`,
          );
  return [
    ...new Set([
      ...rows.flatMap((row) => (row.workspaceId ? [row.workspaceId] : [])),
      ...entityRows.map((row) => row.workspaceId),
    ]),
  ];
};
