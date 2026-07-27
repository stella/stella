/**
 * Transaction boundaries for replay-safe ingestion.
 *
 * These helpers guarantee ordering and, when backed by a real database
 * transaction, rollback. They do not make external side effects idempotent:
 * callers must durably identify every item and hold the checkpoint while any
 * item still needs retry.
 */

export type IngestionTransactionRunner<Transaction> = <Result>(
  work: (transaction: Transaction) => Promise<Result>,
) => Promise<Result>;

type CommitReplaySafeIngestionBatchOptions<
  Transaction,
  Item,
  Checkpoint,
  Persisted,
> = {
  checkpoint: Checkpoint;
  items: readonly Item[];
  persistCheckpoint: (
    transaction: Transaction,
    checkpoint: Checkpoint,
  ) => Promise<void>;
  persistItems: (
    transaction: Transaction,
    items: readonly Item[],
  ) => Promise<Persisted>;
  runInTransaction: IngestionTransactionRunner<Transaction>;
};

/**
 * Commit database-backed items and their checkpoint in one transaction.
 * A failure in either callback rolls back both when runInTransaction provides
 * normal transaction semantics.
 */
export const commitReplaySafeIngestionBatch = async <
  Transaction,
  Item,
  Checkpoint,
  Persisted,
>({
  checkpoint,
  items,
  persistCheckpoint,
  persistItems,
  runInTransaction,
}: CommitReplaySafeIngestionBatchOptions<
  Transaction,
  Item,
  Checkpoint,
  Persisted
>) =>
  await runInTransaction(async (transaction) => {
    const persisted = await persistItems(transaction, items);
    await persistCheckpoint(transaction, checkpoint);
    return persisted;
  });
