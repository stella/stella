import { TaggedError } from "better-result";

import type { Transaction } from "@/api/db/types";
import type { SafeId } from "@/api/lib/branded-types";
import { findExactDuplicates } from "@/api/lib/uploads/exact-duplicates";

/** Another document of the matter already holds the bytes being filed. */
export class SameBytesFiledError extends TaggedError("SameBytesFiledError")<{
  message: string;
  entityId: SafeId<"entity">;
  name: string;
}> {}

/**
 * Keeps a matter to one document per file: run inside a document's
 * creating transaction (`createEntityFromBuffer`'s `afterCreate`), which
 * holds the matter's creation lock, it rolls that creation back when another
 * document of the matter already holds the same bytes as its current file.
 * A creation that committed first is seen here, so two filings of the same
 * bytes at once keep one document. The caller catches `SameBytesFiledError`
 * and names the document it carries.
 */
export const refuseSecondCopy = async (
  tx: Transaction,
  {
    workspaceId,
    sha256Hex,
    createdEntityId,
  }: {
    workspaceId: SafeId<"workspace">;
    sha256Hex: string;
    createdEntityId: SafeId<"entity">;
  },
): Promise<void> => {
  const [first] = await findExactDuplicates({
    tx,
    workspaceId,
    sha256Hexes: [sha256Hex],
    exceptEntityId: createdEntityId,
  });
  if (first !== undefined) {
    throw new SameBytesFiledError({
      message: "The matter already holds this file",
      entityId: first.entityId,
      name: first.entityName,
    });
  }
};
