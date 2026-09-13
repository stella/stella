import { and, count, eq, inArray, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { caseLawDecisions, caseLawMatterLinks } from "@/api/db/schema";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";

type MatterLinkRow = typeof caseLawMatterLinks.$inferSelect;

/** One link as a client reads it. */
const toMatterLinkResponse = (row: MatterLinkRow) => ({
  id: row.id,
  decisionId: row.decisionId,
  workspaceId: row.workspaceId,
  note: row.note,
  linkedBy: row.linkedBy,
  createdAt: row.createdAt,
});

type MatterLinkResponse = ReturnType<typeof toMatterLinkResponse>;

// Totality guard, bidirectional: every column of the link is the caller's own,
// so a column added to the table must be projected, and the projection cannot
// carry a field no column backs.
type MissingProjectedMatterLinkColumn = UnprojectedColumns<
  MatterLinkRow,
  MatterLinkResponse
>;
type UnexpectedProjectedMatterLinkColumn = UnbackedProjectionKeys<
  MatterLinkRow,
  MatterLinkResponse
>;

true satisfies MissingProjectedMatterLinkColumn extends never ? true : never;
true satisfies UnexpectedProjectedMatterLinkColumn extends never ? true : never;

/** One decision a caller wants pinned into the matter. */
type MatterLinkRequest = {
  decisionId: SafeId<"caseLawDecision">;
  note?: string | null;
};

/**
 * Why a decision was not pinned. `not_found` is a decision the caller cannot
 * read — absent from the corpus or withheld by its source — and `limit` is the
 * matter holding its maximum number of links; a decision already pinned is
 * neither, it comes back under `existing`.
 */
const MATTER_LINK_REJECTION_REASONS = ["limit", "not_found"] as const;

type MatterLinkRejectionReason = (typeof MATTER_LINK_REJECTION_REASONS)[number];

type MatterLinkRejection = {
  decisionId: SafeId<"caseLawDecision">;
  reason: MatterLinkRejectionReason;
};

/** One outcome per decision asked for, partitioned by what happened to it. */
export type MatterLinkOutcome = {
  linked: MatterLinkResponse[];
  existing: MatterLinkResponse[];
  rejected: MatterLinkRejection[];
};

type LinkDecisionsToMatterOptions = {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  items: readonly MatterLinkRequest[];
  recordAuditEvent: AuditRecorder;
};

/** First request per decision wins, so a repeated id cannot be counted twice. */
const dedupeByDecision = (
  items: readonly MatterLinkRequest[],
): MatterLinkRequest[] => {
  const byDecision = new Map<SafeId<"caseLawDecision">, MatterLinkRequest>();
  for (const item of items) {
    if (!byDecision.has(item.decisionId)) {
      byDecision.set(item.decisionId, item);
    }
  }
  return [...byDecision.values()];
};

/**
 * Pin decisions into one matter, atomically.
 *
 * Count, decide and insert happen under a per-matter advisory lock held for
 * the whole transaction, so concurrent calls cannot each observe room below
 * the cap and together commit past it. Idempotence comes before the cap: a
 * decision already pinned is the caller's own earlier link and is returned
 * unchanged, note included, even when the matter is full — re-pinning inserts
 * nothing, so there is nothing for the cap to refuse.
 */
export const linkDecisionsToMatter = async ({
  items,
  recordAuditEvent,
  tx,
  userId,
  workspaceId,
}: LinkDecisionsToMatterOptions): Promise<MatterLinkOutcome> => {
  const requests = dedupeByDecision(items);
  if (requests.length === 0) {
    return { linked: [], existing: [], rejected: [] };
  }
  const decisionIds = requests.map((request) => request.decisionId);

  // Serializes the count-and-insert below per matter. An advisory lock rather
  // than a lock on the matter row itself: the cap is this table's invariant,
  // and blocking every other write to the matter would be a wider lock than
  // the invariant needs.
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${workspaceId}), hashtext('case-law-matter-links'))`,
  );

  const readable = await tx
    .select({ id: caseLawDecisions.id })
    .from(caseLawDecisions)
    .where(inArray(caseLawDecisions.id, decisionIds))
    .limit(decisionIds.length);
  const readableIds = new Set(readable.map((decision) => decision.id));

  const alreadyLinked = await tx
    .select()
    .from(caseLawMatterLinks)
    .where(
      and(
        eq(caseLawMatterLinks.workspaceId, workspaceId),
        inArray(caseLawMatterLinks.decisionId, decisionIds),
      ),
    )
    .limit(decisionIds.length);
  const linkByDecision = new Map(
    alreadyLinked.map((link) => [link.decisionId, link]),
  );

  const [linkCountRow] = await tx
    .select({ value: count() })
    .from(caseLawMatterLinks)
    .where(eq(caseLawMatterLinks.workspaceId, workspaceId));
  let remaining =
    LIMITS.caseLawMatterLinksPerWorkspace - (linkCountRow?.value ?? 0);

  const existing: MatterLinkResponse[] = [];
  const rejected: MatterLinkRejection[] = [];
  const toInsert: (typeof caseLawMatterLinks.$inferInsert)[] = [];
  for (const { decisionId, note } of requests) {
    const link = linkByDecision.get(decisionId);
    if (link !== undefined) {
      existing.push(toMatterLinkResponse(link));
      continue;
    }
    if (!readableIds.has(decisionId)) {
      rejected.push({ decisionId, reason: "not_found" });
      continue;
    }
    if (remaining <= 0) {
      rejected.push({ decisionId, reason: "limit" });
      continue;
    }
    remaining--;
    toInsert.push({
      id: createSafeId<"caseLawMatterLink">(),
      decisionId,
      workspaceId,
      note: note ?? null,
      linkedBy: userId,
    });
  }

  if (toInsert.length === 0) {
    return { linked: [], existing, rejected };
  }

  // No conflict clause: the unique row was read above under the lock every
  // writer takes, so a conflict here would mean an unlocked insert path exists
  // and the cap is unenforceable. Failing loudly is the right answer to that.
  const linked = await tx
    .insert(caseLawMatterLinks)
    .values(toInsert)
    .returning();

  await recordAuditEvent(
    tx,
    linked.map((link) => ({
      action: AUDIT_ACTION.CREATE,
      resourceType: AUDIT_RESOURCE_TYPE.CASE_LAW_MATTER_LINK,
      resourceId: link.id,
      workspaceId,
      metadata: { decisionId: link.decisionId, hasNote: link.note !== null },
    })),
  );

  return { linked: linked.map(toMatterLinkResponse), existing, rejected };
};
