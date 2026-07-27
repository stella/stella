// Passive regression fixture for
// no-direct-ingestion-checkpoint-write/no-direct-ingestion-checkpoint-write.
//
// A required report carries a disable. If detection regresses, that directive
// becomes unused and fixture lint fails. Unannotated cases must remain allowed.

declare const db: {
  update: (table: unknown) => {
    set: (values: Record<string, unknown>) => {
      where: (condition: unknown) => Promise<void>;
    };
  };
  insert: (table: unknown) => {
    values: (values: Record<string, unknown>) => Promise<void>;
  };
};
declare const sourceId: string;
declare const sources: unknown;
declare const whereSource: unknown;

const syncCursor = "page-2";

// oxlint-disable-next-line no-direct-ingestion-checkpoint-write/no-direct-ingestion-checkpoint-write -- fixture: direct checkpoint writes must be rejected
await db.update(sources).set({ syncCursor }).where(whereSource);

// oxlint-disable-next-line no-direct-ingestion-checkpoint-write/no-direct-ingestion-checkpoint-write -- fixture: explicit identifier keys must be rejected
await db.update(sources).set({ syncCursor: "page-3" }).where(whereSource);

// oxlint-disable-next-line no-direct-ingestion-checkpoint-write/no-direct-ingestion-checkpoint-write -- fixture: static string keys must be rejected
await db.update(sources).set({ syncCursor: "page-4" }).where(whereSource);

const otherValues = { lastSyncAt: new Date() };
await db
  .update(sources)
  // oxlint-disable-next-line no-direct-ingestion-checkpoint-write/no-direct-ingestion-checkpoint-write -- fixture: an explicit checkpoint after a spread must be rejected
  .set({ ...otherValues, syncCursor })
  .where(whereSource);

declare const commitReplaySafeIngestionBatch: (options: {
  checkpoint: string;
  persistCheckpoint: (
    transaction: typeof db,
    checkpoint: string,
  ) => Promise<void>;
  runInTransaction: unknown;
}) => Promise<void>;

await commitReplaySafeIngestionBatch({
  checkpoint: syncCursor,
  persistCheckpoint: async (tx, checkpoint) => {
    await tx.update(sources).set({ syncCursor: checkpoint }).where(whereSource);
  },
  runInTransaction: db,
});

await db.update(sources).set({ lastSyncAt: new Date() }).where(whereSource);
await db.insert(sources).values({ syncCursor: null, sourceId });

const localProjection = { syncCursor };
const state = {
  update: () => ({
    set: (_value: unknown) => undefined,
  }),
};
state.update().set(localProjection);
