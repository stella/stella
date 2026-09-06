import { panic } from "better-result";
import { sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { documentCounters } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  generateVerificationCode,
  toDocumentReference,
} from "@/api/lib/document-reference";

type EntityStamp = {
  docSequence: number;
  stamp: string | null;
  verificationCode: string | null;
};

type AllocateEntityStampsOptions = {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  /** How many stamps the caller needs, in the order it will consume them. */
  count: number;
};

/**
 * Allocate a whole run of document sequence numbers and their frozen
 * stamps + verification codes in two statements: one counter upsert that
 * advances `lastValue` by `count`, and one workspace reference read.
 * Sequence numbers are the block ending at the returned high-water mark,
 * handed back in ascending order. Stamps and codes are null when the
 * workspace has no reference pattern.
 */
export const allocateEntityStamps = async ({
  tx,
  workspaceId,
  count,
}: AllocateEntityStampsOptions): Promise<EntityStamp[]> => {
  // Allocating nothing must not touch the counter row.
  if (count === 0) {
    return [];
  }

  // Upsert + increment allocates the block atomically, so concurrent
  // allocations cannot hand out the same sequence numbers.
  const rows = await tx
    .insert(documentCounters)
    .values({
      id: createSafeId<"documentCounter">(),
      workspaceId,
      lastValue: count,
    })
    .onConflictDoUpdate({
      target: [documentCounters.workspaceId],
      set: {
        lastValue: sql`${documentCounters.lastValue} + ${count}`,
      },
    })
    .returning({ lastValue: documentCounters.lastValue });

  const counter = rows.at(0);
  if (!counter) {
    panic("Document counter upsert returned no rows");
  }

  const firstDocSequence = counter.lastValue - count + 1;
  const workspace = await tx.query.workspaces.findFirst({
    where: { id: { eq: workspaceId } },
    columns: { reference: true },
  });
  if (!workspace) {
    // The counter row references the workspace, so the upsert above proves it.
    panic("Document counter allocated for a missing workspace");
  }

  const matterReference = workspace.reference;
  if (!matterReference) {
    return Array.from({ length: count }, (_, index) => ({
      docSequence: firstDocSequence + index,
      stamp: null,
      verificationCode: null,
    }));
  }

  return Array.from({ length: count }, (_, index) => {
    const docSequence = firstDocSequence + index;
    return {
      docSequence,
      stamp: toDocumentReference({
        matterReference,
        docSequence,
        versionNumber: 1,
      }),
      verificationCode: generateVerificationCode(),
    };
  });
};

/**
 * Allocate a document sequence number and generate a frozen
 * stamp + verification code for a new entity. Returns null
 * stamp/code if the workspace has no reference pattern.
 */
export const allocateEntityStamp = async (
  tx: Transaction,
  workspaceId: SafeId<"workspace">,
): Promise<EntityStamp> => {
  const stamps = await allocateEntityStamps({ tx, workspaceId, count: 1 });
  return stamps.at(0) ?? panic("Entity stamp allocation returned no stamp");
};
