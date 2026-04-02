import { panic } from "better-result";
import { sql } from "drizzle-orm";

import type { Transaction } from "@/api/db";
import { documentCounters } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import {
  generateVerificationCode,
  toDocumentReference,
} from "@/api/lib/document-reference";

/**
 * Atomically allocate the next document sequence number for
 * a workspace. Uses upsert + increment to avoid race conditions.
 *
 * Returns the newly allocated sequence number.
 */
export const allocateDocSequence = async (
  tx: Transaction,
  workspaceId: SafeId<"workspace">,
): Promise<number> => {
  const rows = await tx
    .insert(documentCounters)
    .values({
      id: crypto.randomUUID(),
      workspaceId,
      lastValue: 1,
    })
    .onConflictDoUpdate({
      target: [documentCounters.workspaceId],
      set: {
        lastValue: sql`${documentCounters.lastValue} + 1`,
      },
    })
    .returning({ lastValue: documentCounters.lastValue });

  const counter = rows.at(0);
  if (!counter) {
    panic("Document counter upsert returned no rows");
  }

  return counter.lastValue;
};

type EntityStamp = {
  docSequence: number;
  stamp: string | null;
  verificationCode: string | null;
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
  const docSequence = await allocateDocSequence(tx, workspaceId);

  const ws = await tx.query.workspaces.findFirst({
    where: { id: { eq: workspaceId } },
    columns: { reference: true },
  });

  if (!ws?.reference) {
    return { docSequence, stamp: null, verificationCode: null };
  }

  return {
    docSequence,
    stamp: toDocumentReference(ws.reference, docSequence, 1),
    verificationCode: generateVerificationCode(),
  };
};
