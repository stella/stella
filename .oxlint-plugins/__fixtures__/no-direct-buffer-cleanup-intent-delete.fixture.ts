import {
  bufferObjectCleanupIntents as cleanupIntents,
} from "../../apps/api/src/db/schema.ts";

declare const tx: {
  delete: (table: unknown) => unknown;
};
declare const anotherTable: unknown;
declare const intentId: string;
declare const retirePublishedObjectCleanupIntentsInTransaction: (options: {
  intentIds: string[];
  tx: typeof tx;
}) => Promise<void>;

// Writers must not retire publication recovery ownership directly.
// oxlint-disable-next-line no-direct-buffer-cleanup-intent-delete/no-direct-buffer-cleanup-intent-delete -- intentional bad fixture
const _directDelete = tx.delete(cleanupIntents);

// The owning helper makes publication and retirement one transaction.
const _ownedRetirement = retirePublishedObjectCleanupIntentsInTransaction({
  intentIds: [intentId],
  tx,
});

// Deletes from unrelated tables remain ordinary Drizzle operations.
const _otherDelete = tx.delete(anotherTable);

export const __noDirectBufferCleanupIntentDeleteFixture = {
  _directDelete,
  _otherDelete,
  _ownedRetirement,
};
