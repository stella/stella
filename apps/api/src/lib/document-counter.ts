import { panic } from "better-result";
import { and, eq, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { documentCounters, documentReferenceCounters } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { toDocumentReference } from "@/api/lib/document-reference";

type EntityStamp = {
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
 * Two invariants hold together. A sequence number never repeats inside a
 * workspace, because `document_counters` only ever moves forward. A printed
 * stamp string never repeats inside an organization, because the per-reference
 * ledger (`document_reference_counters`) floors the workspace counter at the
 * high-water mark that reference has already reached — a matter that gives up
 * a reference and a matter that later takes it over do not restart numbering,
 * and neither does a matter that returns to a reference it used before.
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
  // for the same block of sequence numbers.
  let referenceFloor = 0;
  if (matterReference) {
    await tx
      .insert(documentReferenceCounters)
      .values({
        id: createSafeId<"documentReferenceCounter">(),
        organizationId,
        reference: matterReference,
      })
      .onConflictDoNothing({
        target: [
          documentReferenceCounters.organizationId,
          documentReferenceCounters.reference,
        ],
      });

    const ledgerRows = await tx
      .select({ lastValue: documentReferenceCounters.lastValue })
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
