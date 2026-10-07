import { Panic, panic, Result } from "better-result";

import {
  commitOrganizationFilesBytes,
  OrganizationFileUsageError,
  ORGANIZATION_FILE_ACCOUNTING_BATCH_LIMIT,
  releaseOrganizationFilesBytes,
  authorizeOrganizationFileBatch,
} from "@/api/lib/files/organization-file-usage";
import type {
  FileUsageInput,
  FileUsageReservation,
} from "@/api/lib/files/organization-file-usage";
import { snapshotOperationInput } from "@/api/lib/proofs/checked-transaction";

type CopyOrganizationFilesOptions<T, E> = {
  inputs: (FileUsageInput & {
    copy: () => Promise<Result<T, E>>;
    confirmedDestinationAbsentOnCopyError?: (error: E) => boolean;
  })[];
  concurrency: number;
  db?: Parameters<typeof authorizeOrganizationFileBatch>[1];
};

/** Settle each bounded round before opening reservations for the next. */
export const copyOrganizationFiles = async <T, E>(
  options: CopyOrganizationFilesOptions<T, E>,
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
  for (
    let roundStart = 0;
    roundStart < inputs.length;
    roundStart += ORGANIZATION_FILE_ACCOUNTING_BATCH_LIMIT
  ) {
    const round = inputs.slice(
      roundStart,
      roundStart + ORGANIZATION_FILE_ACCOUNTING_BATCH_LIMIT,
    );
    const authorized = await authorizeOrganizationFileBatch(round, db);
    if (Result.isError(authorized)) {
      return Result.err(authorized.error);
    }
    const outcome = await authorized.value.execute(async ({ proof }) => {
      const roundCopies: Result<T, E | OrganizationFileUsageError>[] = [];
      for (
        let start = 0;
        start < proof.input.value.operation.length;
        start += concurrency
      ) {
        const results = await Promise.all(
          proof.input.value.operation
            .slice(start, start + concurrency)
            .map(async ({ copy }) =>
              Result.flatten(
                await Result.tryPromise({
                  try: copy,
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
        | { error: E | OrganizationFileUsageError }
        | undefined;
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
      const settled = await commitOrganizationFilesBytes(
        committed,
        proof.input.value.db,
      );
      const unwound = await releaseOrganizationFilesBytes(
        released,
        proof.input.value.db,
      );
      if (Result.isError(settled)) {
        return Result.err(settled.error);
      }
      if (Result.isError(unwound)) {
        return Result.err(unwound.error);
      }
      const busyKeys = new Set(settled.value.busyObjectKeys);
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
