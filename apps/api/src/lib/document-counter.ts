import { panic } from "better-result";
import { sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { documentCounters } from "@/api/db/schema";
import type { EntityKind } from "@/api/db/schema-validators";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  generateVerificationCode,
  toDocumentReference,
} from "@/api/lib/document-reference";

const DOCUMENT_REFERENCE_POLICY = {
  document: "stamp",
  folder: "unstamped",
  task: "unstamped",
  message: "stamp",
  link: "unstamped",
} as const satisfies Record<EntityKind, "stamp" | "unstamped">;

export const entityKindHasDocumentReference = (kind: EntityKind): boolean =>
  DOCUMENT_REFERENCE_POLICY[kind] === "stamp";

/**
 * Atomically allocate the next block of document sequence numbers for
 * a workspace. Uses one upsert + increment to avoid race conditions and
 * input-sized query growth.
 *
 * Returns the allocated sequence numbers in ascending order.
 */
const allocateDocSequences = async (
  tx: Transaction,
  workspaceId: SafeId<"workspace">,
  count: number,
): Promise<number[]> => {
  if (!Number.isSafeInteger(count) || count <= 0) {
    panic("Document sequence allocation count must be a positive integer");
  }

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

  const firstValue = counter.lastValue - count + 1;
  return Array.from({ length: count }, (_, index) => firstValue + index);
};

type EntityStamp = {
  docSequence: number;
  stamp: string | null;
  verificationCode: string | null;
};

/**
 * Allocate a sequence block and generate frozen stamps + verification
 * codes for new entities. Returns null stamp/code values if the workspace
 * has no reference pattern.
 */
export const allocateEntityStamps = async (
  tx: Transaction,
  workspaceId: SafeId<"workspace">,
  count: number,
): Promise<EntityStamp[]> => {
  const docSequences = await allocateDocSequences(tx, workspaceId, count);

  const ws = await tx.query.workspaces.findFirst({
    where: { id: { eq: workspaceId } },
    columns: { reference: true },
  });

  if (!ws?.reference) {
    return docSequences.map((docSequence) => ({
      docSequence,
      stamp: null,
      verificationCode: null,
    }));
  }

  return docSequences.map((docSequence) => ({
    docSequence,
    stamp: toDocumentReference({
      matterReference: ws.reference,
      docSequence,
      versionNumber: 1,
    }),
    verificationCode: generateVerificationCode(),
  }));
};

export const allocateEntityStamp = async (
  tx: Transaction,
  workspaceId: SafeId<"workspace">,
): Promise<EntityStamp> => {
  const stamp = (await allocateEntityStamps(tx, workspaceId, 1)).at(0);
  if (!stamp) {
    panic("Single entity stamp allocation returned no stamp");
  }
  return stamp;
};
