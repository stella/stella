import { and, asc, eq, inArray, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { entities, fields } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

export type ExactDuplicate = {
  sha256Hex: string;
  entityName: string;
};

type FindExactDuplicatesOptions = {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  sha256Hexes: readonly string[];
};

const fileSha256Hex = sql<string>`(${fields.content}->>'sha256Hex')`;

/**
 * The documents in one matter whose current file has exactly these bytes, the
 * oldest per hash. The workspace predicate is in the query itself, so a hash
 * held anywhere else reads as "no duplicate".
 */
export const findExactDuplicates = async ({
  tx,
  workspaceId,
  sha256Hexes,
}: FindExactDuplicatesOptions): Promise<ExactDuplicate[]> => {
  if (sha256Hexes.length === 0) {
    return [];
  }

  return await tx
    .selectDistinctOn([fileSha256Hex], {
      sha256Hex: fileSha256Hex,
      entityName: entities.name,
    })
    .from(fields)
    .innerJoin(
      entities,
      and(
        eq(entities.currentVersionId, fields.entityVersionId),
        eq(entities.workspaceId, workspaceId),
        // A task carries files too, but its attachment is not a document the
        // upload could duplicate.
        eq(entities.kind, "document"),
      ),
    )
    .where(
      and(
        eq(fields.workspaceId, workspaceId),
        sql`${fields.content}->>'type' = 'file'`,
        inArray(fileSha256Hex, [...sha256Hexes]),
      ),
    )
    .orderBy(fileSha256Hex, asc(entities.createdAt), asc(entities.id))
    .limit(sha256Hexes.length);
};
