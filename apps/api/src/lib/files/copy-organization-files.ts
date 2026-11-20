import { Panic, panic, Result } from "better-result";
import { and, asc, eq, inArray } from "drizzle-orm";

import { chunk as chunkItems } from "@stll/concurrency/chunk";
import { Temporal } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import {
  BUFFER_OBJECT_CLEANUP_INTENT_STATUS,
  bufferObjectCleanupIntents,
  workspaces,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import {
  lockObjectCleanupIntentsForWriter,
  retirePublishedObjectCleanupIntentsInTransaction,
  settleObjectCleanupIntentsAfterWriterInTransaction,
} from "@/api/lib/buffer-intent-reconciliation";
import {
  withAggregateParentBatch,
  withAggregateTransaction,
} from "@/api/lib/db/aggregate-lock";
import { openOrganizationFileUsageDb } from "@/api/lib/db/maintenance-db";
import { abortTransaction } from "@/api/lib/db/transaction-abort";
import {
  lockOrganizationObjectIntentsForWriter,
  PREPUBLICATION_COPY_INTENT_LEASE_MS,
} from "@/api/lib/files/object-cleanup-intent-fence";
import {
  authorizeOrganizationFileBatch,
  authorizePrepublicationOrganizationFileBatch,
  commitOrganizationFilesBytes,
  ORGANIZATION_FILE_ACCOUNTING_BATCH_LIMIT,
  OrganizationFileUsageError,
  releaseOrganizationFilesBytes,
  runCheckedStorageOperation,
} from "@/api/lib/files/organization-file-usage";
import type {
  CheckedFileCopy,
  FileUsageInput,
  FileUsageReservation,
  PrepublicationCopyCleanupScope,
} from "@/api/lib/files/organization-file-usage";
import { snapshotOperationInput } from "@/api/lib/proofs/checked-transaction";

type CopyOrganizationFilesOptions<T, E, Source> = {
  inputs: (FileUsageInput & {
    source: Source;
    copy: (checked: CheckedFileCopy<Source>) => Promise<Result<T, E>>;
    confirmedDestinationAbsentOnCopyError?: (error: E) => boolean;
  })[];
  concurrency: number;
  db?: Parameters<typeof authorizeOrganizationFileBatch>[1];
};

type CopyOrganizationFilesForPublicationOptions<T, E, Source> = {
  inputs: (FileUsageInput & {
    cleanupScope: PrepublicationCopyCleanupScope;
    source: Source;
    copy: (checked: CheckedFileCopy<Source>) => Promise<Result<T, E>>;
    confirmedDestinationAbsentOnCopyError?: (error: E) => boolean;
  })[];
  concurrency: number;
  db?: Parameters<typeof authorizeOrganizationFileBatch>[1];
};

type CopyPublicationIntent = {
  cleanupIntentIds: SafeId<"pendingUpload">[];
  objectKey: string;
};

type CopyOrganizationFilesForPublicationResult<T, E> = {
  copies: Result<T, E | OrganizationFileUsageError>[];
  publicationIntents: CopyPublicationIntent[];
};

type SettleFileCopyReservationsOptions = {
  committed: FileUsageReservation[];
  db: Parameters<typeof authorizeOrganizationFileBatch>[1];
  released: FileUsageReservation[];
};

/** Abort the owning transaction when copy publication can no longer proceed. */
export const abortCopyPublicationTransaction = (
  outcome: Result<void, OrganizationFileUsageError>,
): void => {
  if (Result.isError(outcome)) {
    abortTransaction(outcome.error);
  }
};

/** Release confirmed absences even when committing another copy fails. */
const settleFileCopyReservations = async ({
  committed,
  db,
  released,
}: SettleFileCopyReservationsOptions): Promise<
  Result<Set<string>, OrganizationFileUsageError>
> => {
  const settled = await commitOrganizationFilesBytes(committed, db);
  const unwound = await releaseOrganizationFilesBytes(released, db);
  if (Result.isError(settled)) {
    return Result.err(settled.error);
  }
  if (Result.isError(unwound)) {
    return Result.err(unwound.error);
  }
  return Result.ok(new Set(settled.value.busyObjectKeys));
};

type CopyPublicationScope = {
  intentIds: SafeId<"pendingUpload">[];
  /** The organization the caller copied into. */
  organizationId: SafeId<"organization">;
  /** Every matter the caller's copies are scoped to; none for organization scope. */
  workspaceIds: readonly SafeId<"workspace">[];
  tx: Transaction;
};

const lostOwnership = () =>
  Result.err(
    new OrganizationFileUsageError({
      message: "File copy cleanup ownership was lost before publication",
      reason: "destination_unavailable",
    }),
  );

const inactiveDestination = () =>
  Result.err(
    new OrganizationFileUsageError({
      message: "File copy destination is no longer active",
      reason: "destination_unavailable",
    }),
  );

/**
 * The caller's intents as the request role sees them. Their ownership columns
 * are root-only; row policies show the role only intents in its own scope, so
 * every named intent being visible and still writing proves it is the caller's.
 */
const readWritingCopyIntents = async (
  tx: Transaction,
  intentIds: readonly SafeId<"pendingUpload">[],
) =>
  await tx
    .select({
      id: bufferObjectCleanupIntents.id,
      status: bufferObjectCleanupIntents.status,
    })
    .from(bufferObjectCleanupIntents)
    .where(inArray(bufferObjectCleanupIntents.id, [...intentIds]));

const allWriting = (
  rows: readonly { status: string }[],
  expected: number,
): boolean =>
  rows.length === expected &&
  rows.every(
    ({ status }) => status === BUFFER_OBJECT_CLEANUP_INTENT_STATUS.WRITING,
  );

/** Destinations still active in the caller's organization; pending ones may not exist yet. */
const destinationsActive = async ({
  organizationId,
  pendingWorkspaceIds,
  tx,
  workspaceIds,
}: {
  organizationId: SafeId<"organization">;
  pendingWorkspaceIds: ReadonlySet<SafeId<"workspace">>;
  tx: Transaction;
  workspaceIds: readonly SafeId<"workspace">[];
}): Promise<boolean> => {
  const rows = await tx
    .select({
      id: workspaces.id,
      organizationId: workspaces.organizationId,
      status: workspaces.status,
    })
    .from(workspaces)
    .where(inArray(workspaces.id, [...workspaceIds]))
    .orderBy(asc(workspaces.id))
    .limit(workspaceIds.length);
  const byId = new Map(rows.map((row) => [row.id, row]));
  return workspaceIds.every((id) => {
    const row = byId.get(id);
    if (row === undefined) {
      return pendingWorkspaceIds.has(id);
    }
    return row.status === "active" && row.organizationId === organizationId;
  });
};

/** Hold publication ownership for the duration of the short database write. */
export const lockCopyPublicationIntentsInTransaction = async ({
  intentIds,
  organizationId,
  pendingWorkspaceIds = [],
  tx,
  workspaceIds,
  workspaceMode,
}: CopyPublicationScope & {
  pendingWorkspaceIds?: readonly SafeId<"workspace">[] | undefined;
  /**
   * The strongest lock the publishing transaction takes on its destination
   * matters, taken here first: a publication that later admits entities
   * against the matter's cap passes "update", so two publications never both
   * hold the share lock and then wait to upgrade it.
   */
  workspaceMode: "share" | "update";
}): Promise<Result<void, OrganizationFileUsageError>> => {
  const uniqueIntentIds = [...new Set(intentIds)];
  if (uniqueIntentIds.length === 0) {
    return Result.ok(undefined);
  }
  if (
    !allWriting(
      await readWritingCopyIntents(tx, uniqueIntentIds),
      uniqueIntentIds.length,
    )
  ) {
    return lostOwnership();
  }
  await lockOrganizationObjectIntentsForWriter(tx, organizationId);
  const destinations = [...new Set(workspaceIds)].toSorted();
  if (destinations.length > 0) {
    await withAggregateParentBatch({
      mode: workspaceMode,
      organizationIds: [],
      tx,
      workspaceIds: destinations,
    });
    if (
      !(await destinationsActive({
        organizationId,
        pendingWorkspaceIds: new Set(pendingWorkspaceIds),
        tx,
        workspaceIds: destinations,
      }))
    ) {
      return inactiveDestination();
    }
  }
  await lockObjectCleanupIntentsForWriter(tx, uniqueIntentIds);
  return Result.ok(undefined);
};

const heartbeatPrepublicationIntents = async ({
  db,
  intentIds,
}: {
  db: Parameters<typeof authorizeOrganizationFileBatch>[1];
  intentIds: SafeId<"pendingUpload">[];
}): Promise<Result<void, OrganizationFileUsageError>> => {
  const uniqueIntentIds = [...new Set(intentIds)];
  if (uniqueIntentIds.length === 0) {
    return Result.ok(undefined);
  }
  return await Result.tryPromise({
    try: async () =>
      await withAggregateTransaction(
        db ?? openOrganizationFileUsageDb(),
        async (tx) => {
          // audit: skip - live crash-recovery lease heartbeat only.
          const renewed = await tx
            .update(bufferObjectCleanupIntents)
            .set({
              nextAttemptAt: new Date(
                Temporal.Now.instant().epochMilliseconds +
                  PREPUBLICATION_COPY_INTENT_LEASE_MS,
              ),
            })
            .where(
              and(
                inArray(bufferObjectCleanupIntents.id, uniqueIntentIds),
                eq(
                  bufferObjectCleanupIntents.status,
                  BUFFER_OBJECT_CLEANUP_INTENT_STATUS.WRITING,
                ),
              ),
            )
            .returning({ id: bufferObjectCleanupIntents.id });
          if (renewed.length !== uniqueIntentIds.length) {
            abortTransaction(
              new OrganizationFileUsageError({
                message: "File copy cleanup ownership was lost",
                reason: "destination_unavailable",
              }),
            );
          }
        },
      ),
    catch: (cause) =>
      cause instanceof OrganizationFileUsageError
        ? cause
        : new OrganizationFileUsageError({
            message: "File copy cleanup ownership could not be renewed",
            reason: "storage_unavailable",
            cause,
          }),
  });
};

/**
 * Publish copied owners only while every exact-key intent and destination
 * matter is still current. Intent retirement is part of the owner transaction.
 */
export const retirePublishedCopyIntentsInTransaction = async ({
  intentIds,
  organizationId,
  tx,
  workspaceIds,
}: CopyPublicationScope): Promise<Result<void, OrganizationFileUsageError>> => {
  const uniqueIntentIds = [...new Set(intentIds)];
  if (uniqueIntentIds.length === 0) {
    return Result.ok(undefined);
  }
  await lockObjectCleanupIntentsForWriter(tx, uniqueIntentIds);
  if (
    !allWriting(
      await readWritingCopyIntents(tx, uniqueIntentIds),
      uniqueIntentIds.length,
    )
  ) {
    return lostOwnership();
  }
  const destinations = [...new Set(workspaceIds)].toSorted();
  if (destinations.length > 0) {
    await withAggregateParentBatch({
      mode: "share",
      organizationIds: [],
      tx,
      workspaceIds: destinations,
    });
    if (
      !(await destinationsActive({
        organizationId,
        pendingWorkspaceIds: new Set(),
        tx,
        workspaceIds: destinations,
      }))
    ) {
      return inactiveDestination();
    }
  }
  await retirePublishedObjectCleanupIntentsInTransaction({
    intentIds: uniqueIntentIds,
    tx,
  });
  return Result.ok(undefined);
};

const settlePrepublicationIntents = async ({
  confirmedAbsentIntentIds,
  db,
  uncertainIntentIds,
}: {
  confirmedAbsentIntentIds: SafeId<"pendingUpload">[];
  db: Parameters<typeof authorizeOrganizationFileBatch>[1];
  uncertainIntentIds: SafeId<"pendingUpload">[];
}): Promise<Result<void, OrganizationFileUsageError>> => {
  if (
    confirmedAbsentIntentIds.length === 0 &&
    uncertainIntentIds.length === 0
  ) {
    return Result.ok(undefined);
  }
  return await Result.tryPromise({
    try: async () =>
      await withAggregateTransaction(
        db ?? openOrganizationFileUsageDb(),
        async (tx) => {
          await settleObjectCleanupIntentsAfterWriterInTransaction({
            intentIds: confirmedAbsentIntentIds,
            objectState: "object-deleted",
            tx,
          });
          await settleObjectCleanupIntentsAfterWriterInTransaction({
            intentIds: uncertainIntentIds,
            objectState: "write-uncertain",
            tx,
          });
        },
      ),
    catch: (cause) =>
      new OrganizationFileUsageError({
        message: "File copy cleanup ownership could not be settled",
        reason: "storage_unavailable",
        cause,
      }),
  });
};

/** Settle each bounded round before opening reservations for the next. */
export const copyOrganizationFiles = async <T, E, Source>(
  options: CopyOrganizationFilesOptions<T, E, Source>,
): Promise<
  Result<
    Result<T, E | OrganizationFileUsageError>[],
    OrganizationFileUsageError
  >
> => {
  const { inputs, concurrency, db } = snapshotOperationInput(options);
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    panic("Copy concurrency must be a positive safe integer");
  }
  const copies: Result<T, E | OrganizationFileUsageError>[] = [];
  for (const round of chunkItems(
    inputs,
    ORGANIZATION_FILE_ACCOUNTING_BATCH_LIMIT,
  )) {
    const authorized = await authorizeOrganizationFileBatch(round, db);
    if (Result.isError(authorized)) {
      return Result.err(authorized.error);
    }
    const outcome = await authorized.value.execute(async ({ proof }) => {
      const roundCopies: Result<T, E | OrganizationFileUsageError>[] = [];
      for (const batch of chunkItems(
        proof.input.value.operation,
        concurrency,
      )) {
        const results = await Promise.all(
          batch.map(async ({ objectKey, sizeBytes, source, copy }) =>
            Result.flatten(
              await Result.tryPromise({
                try: async () =>
                  await runCheckedStorageOperation({
                    checked: { objectKey, sizeBytes, source },
                    execute: copy,
                  }),
                catch: (cause) => {
                  if (Panic.is(cause)) {
                    return panic(
                      "Organization file copy invariant failed",
                      cause,
                    );
                  }
                  return new OrganizationFileUsageError({
                    message: "Organization file copy is unavailable",
                    reason: "storage_unavailable",
                    cause,
                  });
                },
              }),
            ),
          ),
        );
        roundCopies.push(...results);
      }
      const committed: FileUsageReservation[] = [];
      const released: FileUsageReservation[] = [];
      let uncertainFailure:
        { error: E | OrganizationFileUsageError } | undefined;
      for (const [index, copied] of roundCopies.entries()) {
        const reservation = proof.input.value.reservations.at(index);
        const input = proof.input.value.operation.at(index);
        if (!reservation || !input) {
          panic("File copy reservations must match their inputs");
        }
        if (Result.isOk(copied)) {
          committed.push(reservation);
          continue;
        }
        // Only a confirmed absence permits releasing capacity; timeouts can land later.
        if (
          !(copied.error instanceof OrganizationFileUsageError) &&
          input.confirmedDestinationAbsentOnCopyError?.(copied.error)
        ) {
          released.push(reservation);
        } else {
          uncertainFailure ??= { error: copied.error };
        }
      }
      const settled = await settleFileCopyReservations({
        committed,
        db: proof.input.value.db,
        released,
      });
      if (Result.isError(settled)) {
        return Result.err(settled.error);
      }
      const busyKeys = settled.value;
      for (const [index, copied] of roundCopies.entries()) {
        const input = proof.input.value.operation.at(index);
        if (!input) {
          panic("File copy outcome must have an input");
        }
        if (Result.isOk(copied) && busyKeys.has(input.objectKey)) {
          const error = new OrganizationFileUsageError({
            message: "File reservation changed before commit",
            reason: "reservation_busy",
          });
          copies.push(Result.err(error));
          uncertainFailure ??= { error };
        } else {
          copies.push(copied);
        }
      }
      if (uncertainFailure !== undefined) {
        // Preserve input-order outcomes without starting more writes after an uncertain round.
        const failure = uncertainFailure.error;
        copies.push(
          ...inputs.slice(copies.length).map(() => Result.err(failure)),
        );
        return Result.ok(copies);
      }
      return Result.ok(null);
    });
    if (Result.isError(outcome)) {
      return Result.err(outcome.error);
    }
    if (outcome.value !== null) {
      return Result.ok(outcome.value);
    }
  }
  return Result.ok(copies);
};

/**
 * Copy final keys before their durable owner rows exist. Every destination is
 * paired with a deletion-surviving cleanup intent; callers must retire the
 * returned intents in the same transaction that publishes those owner rows.
 */
export const copyOrganizationFilesForPublication = async <T, E, Source>(
  options: CopyOrganizationFilesForPublicationOptions<T, E, Source>,
): Promise<
  Result<
    CopyOrganizationFilesForPublicationResult<T, E>,
    OrganizationFileUsageError
  >
> => {
  const { inputs, concurrency, db } = snapshotOperationInput(options);
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    panic("Copy concurrency must be a positive safe integer");
  }
  const copies: Result<T, E | OrganizationFileUsageError>[] = [];
  const publicationIntents: CopyPublicationIntent[] = [];
  for (const round of chunkItems(
    inputs,
    ORGANIZATION_FILE_ACCOUNTING_BATCH_LIMIT,
  )) {
    const authorized = await authorizePrepublicationOrganizationFileBatch(
      round,
      db,
    );
    if (Result.isError(authorized)) {
      return Result.err(authorized.error);
    }
    const outcome = await authorized.value.execute(async ({ proof }) => {
      const roundCopies: Result<T, E | OrganizationFileUsageError>[] = [];
      const liveIntentIds = [
        ...publicationIntents.flatMap(
          ({ cleanupIntentIds }) => cleanupIntentIds,
        ),
        ...proof.input.value.reservations.flatMap(
          ({ cleanupIntentIds }) => cleanupIntentIds,
        ),
      ];
      for (const batch of chunkItems(
        proof.input.value.operation,
        concurrency,
      )) {
        // db-await-in-loop: renew the copy's intent lease before each bounded storage round.
        const admitted = await heartbeatPrepublicationIntents({
          db: proof.input.value.db,
          intentIds: liveIntentIds,
        });
        if (Result.isError(admitted)) {
          return Result.err(admitted.error);
        }
        const results = await Promise.all(
          batch.map(async ({ objectKey, sizeBytes, source, copy }) =>
            Result.flatten(
              await Result.tryPromise({
                try: async () =>
                  await runCheckedStorageOperation({
                    checked: { objectKey, sizeBytes, source },
                    execute: copy,
                  }),
                catch: (cause) => {
                  if (Panic.is(cause)) {
                    return panic(
                      "Organization file copy invariant failed",
                      cause,
                    );
                  }
                  return new OrganizationFileUsageError({
                    message: "Organization file copy is unavailable",
                    reason: "storage_unavailable",
                    cause,
                  });
                },
              }),
            ),
          ),
        );
        roundCopies.push(...results);
        // db-await-in-loop: renew the lease after each storage round it covered.
        const renewed = await heartbeatPrepublicationIntents({
          db: proof.input.value.db,
          intentIds: liveIntentIds,
        });
        if (Result.isError(renewed)) {
          return Result.err(renewed.error);
        }
      }

      const committed: FileUsageReservation[] = [];
      const released: FileUsageReservation[] = [];
      const confirmedAbsentIntentIds: SafeId<"pendingUpload">[] = [];
      const uncertainIntentIds: SafeId<"pendingUpload">[] = [];
      let uncertainFailure:
        { error: E | OrganizationFileUsageError } | undefined;
      for (const [index, copied] of roundCopies.entries()) {
        const planned = proof.input.value.reservations.at(index);
        const input = proof.input.value.operation.at(index);
        if (!planned || !input) {
          panic("File copy reservations must match their inputs");
        }
        if (Result.isOk(copied)) {
          committed.push(planned.reservation);
          continue;
        }
        if (
          !(copied.error instanceof OrganizationFileUsageError) &&
          input.confirmedDestinationAbsentOnCopyError?.(copied.error)
        ) {
          released.push(planned.reservation);
          confirmedAbsentIntentIds.push(...planned.cleanupIntentIds);
        } else {
          uncertainIntentIds.push(...planned.cleanupIntentIds);
          uncertainFailure ??= { error: copied.error };
        }
      }

      const settled = await settleFileCopyReservations({
        committed,
        db: proof.input.value.db,
        released,
      });
      if (Result.isError(settled)) {
        return Result.err(settled.error);
      }
      const busyKeys = settled.value;
      for (const [index, copied] of roundCopies.entries()) {
        const input = proof.input.value.operation.at(index);
        const planned = proof.input.value.reservations.at(index);
        if (!input || !planned) {
          panic("File copy outcome must have its reserved intent");
        }
        if (Result.isOk(copied) && busyKeys.has(input.objectKey)) {
          const error = new OrganizationFileUsageError({
            message: "File reservation changed before commit",
            reason: "reservation_busy",
          });
          copies.push(Result.err(error));
          uncertainIntentIds.push(...planned.cleanupIntentIds);
          uncertainFailure ??= { error };
        } else {
          copies.push(copied);
          if (Result.isOk(copied)) {
            publicationIntents.push({
              cleanupIntentIds: planned.cleanupIntentIds,
              objectKey: input.objectKey,
            });
          }
        }
      }
      const cleanupSettled = await settlePrepublicationIntents({
        confirmedAbsentIntentIds,
        db: proof.input.value.db,
        uncertainIntentIds,
      });
      if (Result.isError(cleanupSettled)) {
        return Result.err(cleanupSettled.error);
      }
      if (uncertainFailure !== undefined) {
        const failure = uncertainFailure.error;
        copies.push(
          ...inputs.slice(copies.length).map(() => Result.err(failure)),
        );
        return Result.ok({ copies, publicationIntents });
      }
      return Result.ok(null);
    });
    if (Result.isError(outcome)) {
      return Result.err(outcome.error);
    }
    if (outcome.value !== null) {
      return Result.ok(outcome.value);
    }
  }
  return Result.ok({ copies, publicationIntents });
};
