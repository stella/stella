import { Panic, panic, Result } from "better-result";

import {
  commitOrganizationFilesBytes,
  OrganizationFileUsageError,
  releaseOrganizationFilesBytes,
  reserveOrganizationFilesBytes,
} from "@/api/lib/files/organization-file-usage";
import type {
  FileUsageInput,
  FileUsageReservation,
} from "@/api/lib/files/organization-file-usage";

type CopyOrganizationFilesOptions<T, E> = {
  inputs: (FileUsageInput & {
    copy: () => Promise<Result<T, E>>;
    confirmedDestinationAbsentOnCopyError?: (error: E) => boolean;
  })[];
  concurrency: number;
  db?: Parameters<typeof reserveOrganizationFilesBytes>[1];
};

/** Reserve the whole copy before storage I/O, then settle each outcome together. */
export const copyOrganizationFiles = async <T, E>({
  inputs,
  concurrency,
  db,
}: CopyOrganizationFilesOptions<T, E>): Promise<
  Result<
    Result<T, E | OrganizationFileUsageError>[],
    OrganizationFileUsageError
  >
> => {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    panic("Copy concurrency must be a positive safe integer");
  }
  const reserved = await reserveOrganizationFilesBytes(inputs, db);
  if (Result.isError(reserved)) {
    return Result.err(reserved.error);
  }
  const copies: Result<T, E | OrganizationFileUsageError>[] = [];
  for (let start = 0; start < inputs.length; start += concurrency) {
    const results = await Promise.all(
      inputs.slice(start, start + concurrency).map(async ({ copy }) =>
        Result.flatten(
          await Result.tryPromise({
            try: copy,
            catch: (cause) => {
              if (Panic.is(cause)) {
                return panic("Organization file copy invariant failed", cause);
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
    copies.push(...results);
  }
  const committed: FileUsageReservation[] = [];
  const released: FileUsageReservation[] = [];
  for (const [index, copied] of copies.entries()) {
    const reservation = reserved.value.at(index);
    const input = inputs.at(index);
    if (!reservation || !input) {
      panic("File copy reservations must match their inputs");
    }
    if (Result.isOk(copied)) {
      committed.push(reservation);
      continue;
    }
    // A timeout may have written the destination; only a confirmed absence
    // permits releasing its capacity before object-state recovery.
    if (
      !(copied.error instanceof OrganizationFileUsageError) &&
      input.confirmedDestinationAbsentOnCopyError?.(copied.error)
    ) {
      released.push(reservation);
    }
  }
  const settled = await commitOrganizationFilesBytes(committed, db);
  const unwound = await releaseOrganizationFilesBytes(released, db);
  if (Result.isError(settled)) {
    return Result.err(settled.error);
  }
  if (Result.isError(unwound)) {
    return Result.err(unwound.error);
  }
  return Result.ok(copies);
};
