import { panic } from "better-result";
import { and, eq, inArray, sql } from "drizzle-orm";

import { documentReferenceBase } from "@stll/api-contract";
import { compareCodeUnit } from "@stll/collation";

import type { Transaction } from "@/api/db/root";
import {
  documentCounters,
  documentReferenceCounters,
  workspaces,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { toDocumentReference } from "@/api/lib/document-reference";
import { logger } from "@/api/lib/observability/logger";

export type EntityStamp = {
  docSequence: number;
  stamp: string | null;
};

type AllocateEntityStampsOptions = {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  /** How many stamps the caller needs, in the order it will consume them. */
  count: number;
};

/**
 * Allocate a run of document sequence numbers and their frozen stamps.
 *
 * The ledger retains the reference's owner and high-water mark. An unissued
 * reference or one whose owner was deleted can be claimed by the allocating
 * matter; an existing live owner is preserved.
 *
 * A sequence number never repeats inside a workspace because
 * `document_counters` only moves
 * forward; flooring it at the reference's own high-water mark means a stamp
 * string cannot repeat under one reference either.
 *
 * Lock order is always the reference ledger row first, then the workspace
 * counter row. Callers reach this function with the `workspaces` rows already
 * locked (see `lockWorkspacesForEntityCap`), so the full order is workspaces,
 * parent entity, reference ledger, workspace counter.
 *
 * A workspace with an empty reference takes the counter alone and gets null
 * stamps; the matching verification code is minted by `insertEntityVersions`,
 * which owns the uniqueness of that column.
 */
export const allocateEntityStamps = async ({
  tx,
  workspaceId,
  count,
}: AllocateEntityStampsOptions): Promise<EntityStamp[]> => {
  // Allocating nothing must not touch either counter row.
  if (count === 0) {
    return [];
  }

  const workspace = await tx.query.workspaces.findFirst({
    where: { id: { eq: workspaceId } },
    columns: { reference: true, organizationId: true },
  });
  if (!workspace) {
    panic("Document stamps allocated for a missing workspace");
  }

  const { organizationId, reference: matterReference } = workspace;

  // The ledger row is created on first use and then locked, so concurrent
  // allocations under the same reference serialize here rather than racing
  // for the same block of sequence numbers. A zero-value seed is unissued,
  // so its owner may be replaced by the matter that performs the issuance.
  let referenceFloor = 0;
  if (matterReference) {
    await tx
      .insert(documentReferenceCounters)
      .values({
        id: createSafeId<"documentReferenceCounter">(),
        organizationId,
        reference: matterReference,
        workspaceId,
      })
      .onConflictDoUpdate({
        target: [
          documentReferenceCounters.organizationId,
          documentReferenceCounters.reference,
        ],
        set: { workspaceId: sql`excluded.workspace_id` },
        setWhere: sql`${documentReferenceCounters.workspaceId} IS NULL OR ${documentReferenceCounters.lastValue} = 0`,
      });

    const ledgerRows = await tx
      .select({
        lastValue: documentReferenceCounters.lastValue,
        workspaceId: documentReferenceCounters.workspaceId,
      })
      .from(documentReferenceCounters)
      .where(
        and(
          eq(documentReferenceCounters.organizationId, organizationId),
          eq(documentReferenceCounters.reference, matterReference),
        ),
      )
      .for("update");
    const ledger = ledgerRows.at(0);
    if (!ledger) {
      // The insert above either created the row or found it, inside this
      // transaction; a missing row here would mean it was deleted under us.
      panic("Document reference ledger row disappeared during allocation");
    }
    if (
      ledger.lastValue > 0 &&
      ledger.workspaceId !== null &&
      ledger.workspaceId !== workspaceId
    ) {
      logger.warn("document_reference.shared_numbering", {
        "organization.id": organizationId,
        "workspace.id": workspaceId,
        "workspace.owner_id": ledger.workspaceId,
      });
    }
    referenceFloor = ledger.lastValue;
  }

  // Upsert + increment allocates the block atomically, so concurrent
  // allocations cannot hand out the same sequence numbers.
  const rows = await tx
    .insert(documentCounters)
    .values({
      id: createSafeId<"documentCounter">(),
      workspaceId,
      lastValue: referenceFloor + count,
    })
    .onConflictDoUpdate({
      target: [documentCounters.workspaceId],
      set: {
        lastValue: sql`GREATEST(${documentCounters.lastValue}, ${referenceFloor}) + ${count}`,
      },
    })
    .returning({ lastValue: documentCounters.lastValue });

  const counter = rows.at(0);
  if (!counter) {
    panic("Document counter upsert returned no rows");
  }

  const firstDocSequence = counter.lastValue - count + 1;

  if (!matterReference) {
    return Array.from({ length: count }, (_, index) => ({
      docSequence: firstDocSequence + index,
      stamp: null,
    }));
  }

  await tx
    .update(documentReferenceCounters)
    .set({ lastValue: counter.lastValue })
    .where(
      and(
        eq(documentReferenceCounters.organizationId, organizationId),
        eq(documentReferenceCounters.reference, matterReference),
      ),
    );

  return Array.from({ length: count }, (_, index) => {
    const docSequence = firstDocSequence + index;
    return {
      docSequence,
      stamp: toDocumentReference({
        matterReference,
        docSequence,
        versionNumber: 1,
      }),
    };
  });
};

/**
 * Allocate a document sequence number and generate a frozen stamp for a new
 * entity. Returns a null stamp if the workspace has no reference pattern.
 */
export const allocateEntityStamp = async (
  tx: Transaction,
  workspaceId: SafeId<"workspace">,
): Promise<EntityStamp> => {
  const stamps = await allocateEntityStamps({ tx, workspaceId, count: 1 });
  return stamps.at(0) ?? panic("Entity stamp allocation returned no stamp");
};

/** Keep the reference high-water mark current when a later version is stamped. */
type RecordEntityStampsOptions = {
  tx: Transaction;
  stamps: readonly {
    workspaceId: SafeId<"workspace">;
    stamp: string;
  }[];
};

export const recordEntityStamps = async ({
  tx,
  stamps,
}: RecordEntityStampsOptions): Promise<void> => {
  if (stamps.length === 0) {
    return;
  }
  const workspaceIds = [...new Set(stamps.map((stamp) => stamp.workspaceId))];
  const workspaceRows = await tx
    .select({ id: workspaces.id, organizationId: workspaces.organizationId })
    .from(workspaces)
    .where(inArray(workspaces.id, workspaceIds));
  const organizations = new Map(
    workspaceRows.map((row) => [row.id, row.organizationId]),
  );
  const ledgerValues = new Map<
    string,
    {
      id: SafeId<"documentReferenceCounter">;
      organizationId: SafeId<"organization">;
      reference: string;
      workspaceId: SafeId<"workspace">;
      lastValue: number;
    }
  >();
  for (const { workspaceId, stamp } of stamps) {
    const organizationId = organizations.get(workspaceId);
    if (!organizationId) {
      panic("Document stamp recorded for a missing workspace");
    }
    const base = documentReferenceBase(stamp);
    const sequence = /\/(\d+)$/u.exec(base)?.[1];
    const reference = sequence ? base.slice(0, -(sequence.length + 1)) : null;
    const lastValue = sequence ? Number(sequence) : Number.NaN;
    if (!reference || !Number.isSafeInteger(lastValue)) {
      panic("Document stamp has an invalid reference format");
    }
    const key = JSON.stringify([organizationId, reference]);
    const existing = ledgerValues.get(key);
    if (!existing || lastValue > existing.lastValue) {
      ledgerValues.set(key, {
        id: existing?.id ?? createSafeId<"documentReferenceCounter">(),
        organizationId,
        reference,
        workspaceId: existing?.workspaceId ?? workspaceId,
        lastValue,
      });
    }
  }
  await tx
    .insert(documentReferenceCounters)
    .values(
      [...ledgerValues.values()].toSorted(
        (a, b) =>
          compareCodeUnit(a.organizationId, b.organizationId) ||
          compareCodeUnit(a.reference, b.reference),
      ),
    )
    .onConflictDoUpdate({
      target: [
        documentReferenceCounters.organizationId,
        documentReferenceCounters.reference,
      ],
      set: {
        lastValue: sql`GREATEST(${documentReferenceCounters.lastValue}, excluded.last_value)`,
        workspaceId: sql`COALESCE(${documentReferenceCounters.workspaceId}, excluded.workspace_id)`,
      },
    });
};
