import { Panic, panic, Result } from "better-result";
import { and, count, eq } from "drizzle-orm";

import { Temporal } from "@stll/time";

import {
  organizationFileObjects,
  organizationFileUsage,
  usageEntitlements,
  usagePolicies,
  usageSeatAssignments,
} from "@/api/db/schema";
import { envDocumentProcessingWorker } from "@/api/env-document-processing-worker";
import type { SafeId } from "@/api/lib/branded-types";
import type { MaintenanceDb } from "@/api/lib/db/maintenance-db";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { lockAssignmentCapacity } from "@/api/lib/usage/assignment-capacity";

type OrganizationFileUsageErrorProps = {
  message: string;
  reason:
    | "capacity_exceeded"
    | "key_conflict"
    | "reservation_busy"
    | "storage_unavailable";
  cause?: unknown;
};

export class OrganizationFileUsageError extends HandlerError<409 | 503> {
  readonly reason: OrganizationFileUsageErrorProps["reason"];

  constructor({ message, reason, cause }: OrganizationFileUsageErrorProps) {
    super({
      message,
      status: reason === "storage_unavailable" ? 503 : 409,
      code: `FILE_USAGE_${reason.toUpperCase()}`,
      cause,
    });
    this.name = "OrganizationFileUsageError";
    this.reason = reason;
  }
}

/** Client status for a ledger outcome: full capacity is 413, contention 409. */
export const organizationFileUsageResponseStatus = (
  reason: OrganizationFileUsageError["reason"],
): 409 | 413 | 503 => {
  switch (reason) {
    case "capacity_exceeded":
      return 413;
    case "key_conflict":
    case "reservation_busy":
      return 409;
    case "storage_unavailable":
      return 503;
    default:
      reason satisfies never;
      return panic("Unhandled organization file usage reason");
  }
};

export const organizationFileUsageHandlerError = (
  error: OrganizationFileUsageError,
): HandlerError<409 | 413 | 503> =>
  new HandlerError({
    status: organizationFileUsageResponseStatus(error.reason),
    message: error.message,
    cause: error,
  });

const positiveDifference = (next: bigint, current: bigint): bigint =>
  next > current ? next - current : 0n;

const reservedContribution = (
  object: Pick<
    typeof organizationFileObjects.$inferSelect,
    "status" | "sizeBytes" | "pendingSizeBytes"
  >,
): bigint => {
  if (object.status === "reserved") {
    return object.sizeBytes;
  }
  return object.pendingSizeBytes === null
    ? 0n
    : positiveDifference(object.pendingSizeBytes, object.sizeBytes);
};

export type FileUsageInput = {
  organizationId: SafeId<"organization">;
  objectKey: string;
  sizeBytes: number;
  contentSha256Hex?: string | undefined;
};

export type FileUsageReservation =
  | { status: "disabled" }
  | { status: "already_committed" }
  | {
      status: "reserved";
      organizationId: SafeId<"organization">;
      objectKey: string;
      writeId: string;
    };

const storageUnavailable = (cause: unknown) => {
  if (Panic.is(cause)) {
    return panic("Organization file invariant failed", cause);
  }
  return new OrganizationFileUsageError({
    message: "Organization file usage is unavailable",
    reason: "storage_unavailable",
    cause,
  });
};

type FileUsageDb = Pick<MaintenanceDb, "transaction">;

// File objects can outlive their matter and are also written by background
// workers. Load the dedicated owner transaction only while enforcement runs.
const fileUsageDb = async (): Promise<FileUsageDb> => {
  const { openOrganizationFileUsageDb } =
    await import("@/api/lib/db/maintenance-db");
  return openOrganizationFileUsageDb();
};

const FILE_RESERVATION_RECOVERY_DELAY_MS = 5 * 60_000;
export const FILE_RESERVATION_ABANDON_DELAY_MS = 60 * 60_000;
const S3_LAST_MODIFIED_PRECISION_MS = 1000;

const recoverOrganizationFileReservation = async (
  organizationId: SafeId<"organization">,
  objectKey: string,
  db?: FileUsageDb,
): Promise<Result<boolean, OrganizationFileUsageError>> => {
  const pending = await Result.tryPromise({
    try: async () =>
      await (db ?? (await fileUsageDb())).transaction(
        async (tx) =>
          await tx
            .select({
              organizationId: organizationFileObjects.organizationId,
              status: organizationFileObjects.status,
              sizeBytes: organizationFileObjects.sizeBytes,
              pendingSizeBytes: organizationFileObjects.pendingSizeBytes,
              writeId: organizationFileObjects.writeId,
              expectedSha256Hex: organizationFileObjects.expectedSha256Hex,
              reservationStartedAt:
                organizationFileObjects.reservationStartedAt,
            })
            .from(organizationFileObjects)
            .where(eq(organizationFileObjects.objectKey, objectKey))
            .limit(1)
            .then((rows) => rows.at(0)),
      ),
    catch: storageUnavailable,
  });
  if (Result.isError(pending)) {
    return Result.err(pending.error);
  }
  const object = pending.value;
  if (
    !object ||
    object.organizationId !== organizationId ||
    (object.status === "committed" && object.pendingSizeBytes === null)
  ) {
    return Result.ok(false);
  }
  if (!object.writeId || !object.reservationStartedAt) {
    return panic("File reservation has no write identity");
  }
  const ageMs =
    Temporal.Now.instant().epochMilliseconds -
    object.reservationStartedAt.getTime();
  if (ageMs < FILE_RESERVATION_RECOVERY_DELAY_MS) {
    return Result.ok(false);
  }
  const reservation = {
    status: "reserved" as const,
    organizationId,
    objectKey,
    writeId: object.writeId,
  };
  const abandonConfirmedNonwrite = async () => {
    if (ageMs < FILE_RESERVATION_ABANDON_DELAY_MS) {
      return Result.ok(false);
    }
    const released = await releaseOrganizationFileBytes(reservation, db);
    return Result.isError(released)
      ? Result.err(released.error)
      : Result.ok(true);
  };
  const { headObject } = await import("@/api/lib/s3-presign");
  const head = await headObject(objectKey);
  if (Result.isError(head)) {
    const { isMissingS3ObjectError } = await import("@/api/lib/s3");
    if (isMissingS3ObjectError(head.error.cause)) {
      return await abandonConfirmedNonwrite();
    }
    return Result.err(storageUnavailable(head.error));
  }
  if (
    head.value.contentLength !==
    Number(object.pendingSizeBytes ?? object.sizeBytes)
  ) {
    return object.expectedSha256Hex === null
      ? Result.ok(false)
      : await abandonConfirmedNonwrite();
  }
  if (
    object.expectedSha256Hex === null &&
    (head.value.lastModified === null ||
      head.value.lastModified.getTime() + S3_LAST_MODIFIED_PRECISION_MS <
        object.reservationStartedAt.getTime())
  ) {
    return Result.ok(false);
  }
  if (object.expectedSha256Hex !== null) {
    const { getS3ObjectWithSignal } = await import("@/api/lib/s3");
    const read = await Result.tryPromise({
      try: async () =>
        await getS3ObjectWithSignal(objectKey, AbortSignal.timeout(30_000)),
      catch: storageUnavailable,
    });
    if (Result.isError(read)) {
      return Result.err(read.error);
    }
    const actualSha256Hex = new Bun.CryptoHasher("sha256")
      .update(read.value)
      .digest("hex");
    if (actualSha256Hex !== object.expectedSha256Hex) {
      return await abandonConfirmedNonwrite();
    }
  }
  const committed = await commitOrganizationFileBytes(reservation, db);
  return Result.isError(committed)
    ? Result.err(committed.error)
    : Result.ok(true);
};

/** The organization row is the lock for every object and byte transition. */
export const reserveOrganizationFileBytes = async (
  { organizationId, objectKey, sizeBytes, contentSha256Hex }: FileUsageInput,
  db?: FileUsageDb,
): Promise<Result<FileUsageReservation, OrganizationFileUsageError>> => {
  if (!envDocumentProcessingWorker.FEATURE_FILE_USAGE_LIMITS) {
    return Result.ok({ status: "disabled" } as const);
  }
  if (
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes < 0 ||
    !objectKey ||
    (contentSha256Hex !== undefined && !/^[\da-f]{64}$/u.test(contentSha256Hex))
  ) {
    return panic("Invalid organization file reservation");
  }
  const writeId = Bun.randomUUIDv7();
  const reservationStartedAt = new Date();
  const reserved = await Result.tryPromise({
    try: async () =>
      await (db ?? (await fileUsageDb())).transaction(async (tx) => {
        await lockAssignmentCapacity(tx, organizationId);
        await tx
          .insert(organizationFileUsage)
          .values({ organizationId })
          .onConflictDoNothing();
        const counter = await tx
          .select({
            committedBytes: organizationFileUsage.committedBytes,
            reservedBytes: organizationFileUsage.reservedBytes,
          })
          .from(organizationFileUsage)
          .where(eq(organizationFileUsage.organizationId, organizationId))
          .for("update")
          .then((rows) => rows.at(0));
        if (!counter) {
          return panic("Organization file counter disappeared");
        }

        const existing = await tx
          .select({
            organizationId: organizationFileObjects.organizationId,
            sizeBytes: organizationFileObjects.sizeBytes,
            pendingSizeBytes: organizationFileObjects.pendingSizeBytes,
            writeId: organizationFileObjects.writeId,
            status: organizationFileObjects.status,
          })
          .from(organizationFileObjects)
          .where(eq(organizationFileObjects.objectKey, objectKey))
          .limit(1)
          .then((rows) => rows.at(0));
        if (existing) {
          if (existing.organizationId !== organizationId) {
            return { status: "key_conflict" as const };
          }
          if (
            existing.status === "reserved" ||
            existing.pendingSizeBytes !== null
          ) {
            return { status: "reservation_busy" as const };
          }
        }

        const additionalBytes = existing
          ? positiveDifference(BigInt(sizeBytes), existing.sizeBytes)
          : BigInt(sizeBytes);

        const entitlement = await tx
          .select({
            storageBytesPerAssignment: usagePolicies.storageBytesPerAssignment,
          })
          .from(usageEntitlements)
          .innerJoin(
            usagePolicies,
            eq(usageEntitlements.usagePolicyId, usagePolicies.id),
          )
          .where(eq(usageEntitlements.organizationId, organizationId))
          .limit(1)
          .then((rows) => rows.at(0));
        if (entitlement && entitlement.storageBytesPerAssignment !== null) {
          const assignments = await tx
            .select({ value: count() })
            .from(usageSeatAssignments)
            .where(eq(usageSeatAssignments.organizationId, organizationId))
            .then((rows) => rows.at(0)?.value ?? 0);
          const cap =
            entitlement.storageBytesPerAssignment * BigInt(assignments);
          const nextBytes =
            counter.committedBytes + counter.reservedBytes + additionalBytes;
          const doesNotGrowExisting =
            existing && BigInt(sizeBytes) <= existing.sizeBytes;
          if (nextBytes > cap && !doesNotGrowExisting) {
            return { status: "capacity_exceeded" as const };
          }
        }
        if (
          existing?.sizeBytes === BigInt(sizeBytes) &&
          contentSha256Hex === undefined
        ) {
          return { status: "already_committed" as const };
        }

        if (existing) {
          await tx
            .update(organizationFileObjects)
            .set({
              pendingSizeBytes: BigInt(sizeBytes),
              writeId,
              expectedSha256Hex: contentSha256Hex ?? null,
              reservationStartedAt,
              updatedAt: new Date(),
            })
            .where(eq(organizationFileObjects.objectKey, objectKey));
        } else {
          await tx.insert(organizationFileObjects).values({
            organizationId,
            objectKey,
            sizeBytes: BigInt(sizeBytes),
            status: "reserved",
            writeId,
            expectedSha256Hex: contentSha256Hex ?? null,
            reservationStartedAt,
          });
        }
        await tx
          .update(organizationFileUsage)
          .set({
            reservedBytes: counter.reservedBytes + additionalBytes,
            updatedAt: new Date(),
          })
          .where(eq(organizationFileUsage.organizationId, organizationId));
        return {
          status: "reserved" as const,
          organizationId,
          objectKey,
          writeId,
        };
      }),
    catch: storageUnavailable,
  });
  if (Result.isError(reserved)) {
    return Result.err(reserved.error);
  }
  switch (reserved.value.status) {
    case "reserved":
    case "already_committed":
      return Result.ok(reserved.value);
    case "key_conflict":
      return Result.err(
        new OrganizationFileUsageError({
          message: "File key already belongs to another write",
          reason: "key_conflict",
        }),
      );
    case "reservation_busy": {
      const recovered = await recoverOrganizationFileReservation(
        organizationId,
        objectKey,
        db,
      );
      if (Result.isError(recovered)) {
        return Result.err(recovered.error);
      }
      if (recovered.value) {
        return await reserveOrganizationFileBytes(
          { organizationId, objectKey, sizeBytes, contentSha256Hex },
          db,
        );
      }
      return Result.err(
        new OrganizationFileUsageError({
          message: "File write is already in progress",
          reason: "reservation_busy",
        }),
      );
    }
    case "capacity_exceeded":
      return Result.err(
        new OrganizationFileUsageError({
          message: "Organization file capacity exceeded",
          reason: "capacity_exceeded",
        }),
      );
    default:
      reserved.value satisfies never;
      return panic("Unhandled file reservation result");
  }
};

export const commitOrganizationFileBytes = async (
  reservation: FileUsageReservation,
  db?: FileUsageDb,
) => {
  if (reservation.status !== "reserved") {
    return Result.ok(undefined);
  }
  const committed = await Result.tryPromise({
    try: async () =>
      await (db ?? (await fileUsageDb())).transaction(async (tx) => {
        const counter = await tx
          .select({
            committedBytes: organizationFileUsage.committedBytes,
            reservedBytes: organizationFileUsage.reservedBytes,
          })
          .from(organizationFileUsage)
          .where(
            eq(
              organizationFileUsage.organizationId,
              reservation.organizationId,
            ),
          )
          .for("update")
          .then((rows) => rows.at(0));
        const object = await tx
          .select({
            status: organizationFileObjects.status,
            sizeBytes: organizationFileObjects.sizeBytes,
            pendingSizeBytes: organizationFileObjects.pendingSizeBytes,
            writeId: organizationFileObjects.writeId,
          })
          .from(organizationFileObjects)
          .where(
            and(
              eq(
                organizationFileObjects.organizationId,
                reservation.organizationId,
              ),
              eq(organizationFileObjects.objectKey, reservation.objectKey),
            ),
          )
          .limit(1)
          .then((rows) => rows.at(0));
        if (!counter || !object) {
          return panic("File reservation disappeared before commit");
        }
        if (object.writeId !== reservation.writeId) {
          return "stale" as const;
        }
        if (object.status === "committed" && object.pendingSizeBytes === null) {
          return undefined;
        }
        const nextSize = object.pendingSizeBytes ?? object.sizeBytes;
        const additionalBytes =
          object.status === "reserved"
            ? object.sizeBytes
            : positiveDifference(nextSize, object.sizeBytes);
        await tx
          .update(organizationFileObjects)
          .set({
            status: "committed",
            sizeBytes: nextSize,
            pendingSizeBytes: null,
            writeId: null,
            expectedSha256Hex: null,
            reservationStartedAt: null,
            updatedAt: new Date(),
          })
          .where(eq(organizationFileObjects.objectKey, reservation.objectKey));
        await tx
          .update(organizationFileUsage)
          .set({
            committedBytes:
              counter.committedBytes +
              (object.status === "reserved"
                ? object.sizeBytes
                : nextSize - object.sizeBytes),
            reservedBytes: counter.reservedBytes - additionalBytes,
            updatedAt: new Date(),
          })
          .where(
            eq(
              organizationFileUsage.organizationId,
              reservation.organizationId,
            ),
          );
        return undefined;
      }),
    catch: storageUnavailable,
  });
  if (Result.isError(committed)) {
    return Result.err(committed.error);
  }
  if (committed.value === "stale") {
    return Result.err(
      new OrganizationFileUsageError({
        message: "File reservation changed before commit",
        reason: "reservation_busy",
      }),
    );
  }
  return Result.ok(undefined);
};

export const releaseOrganizationFileBytes = async (
  reservation: FileUsageReservation,
  db?: FileUsageDb,
) => {
  if (reservation.status !== "reserved") {
    return Result.ok(undefined);
  }
  return await Result.tryPromise({
    try: async () =>
      await (db ?? (await fileUsageDb())).transaction(async (tx) => {
        const counter = await tx
          .select({ reservedBytes: organizationFileUsage.reservedBytes })
          .from(organizationFileUsage)
          .where(
            eq(
              organizationFileUsage.organizationId,
              reservation.organizationId,
            ),
          )
          .for("update")
          .then((rows) => rows.at(0));
        const object = await tx
          .select({
            status: organizationFileObjects.status,
            sizeBytes: organizationFileObjects.sizeBytes,
            pendingSizeBytes: organizationFileObjects.pendingSizeBytes,
            writeId: organizationFileObjects.writeId,
          })
          .from(organizationFileObjects)
          .where(
            and(
              eq(
                organizationFileObjects.organizationId,
                reservation.organizationId,
              ),
              eq(organizationFileObjects.objectKey, reservation.objectKey),
            ),
          )
          .limit(1)
          .then((rows) => rows.at(0));
        if (
          !object ||
          (object.status === "committed" && object.pendingSizeBytes === null)
        ) {
          return;
        }
        if (object.writeId !== reservation.writeId) {
          return;
        }
        if (!counter) {
          panic("File counter disappeared before release");
        }
        if (object.status === "reserved") {
          await tx
            .delete(organizationFileObjects)
            .where(
              eq(organizationFileObjects.objectKey, reservation.objectKey),
            );
        } else {
          await tx
            .update(organizationFileObjects)
            .set({
              pendingSizeBytes: null,
              writeId: null,
              expectedSha256Hex: null,
              reservationStartedAt: null,
              updatedAt: new Date(),
            })
            .where(
              eq(organizationFileObjects.objectKey, reservation.objectKey),
            );
        }
        const additionalBytes = reservedContribution(object);
        await tx
          .update(organizationFileUsage)
          .set({
            reservedBytes: counter.reservedBytes - additionalBytes,
            updatedAt: new Date(),
          })
          .where(
            eq(
              organizationFileUsage.organizationId,
              reservation.organizationId,
            ),
          );
      }),
    catch: storageUnavailable,
  });
};

/** Call only after the storage provider confirms deletion. Replays are free. */
export const removeOrganizationFileBytes = async (
  objectKey: string,
  db?: FileUsageDb,
) => {
  if (!envDocumentProcessingWorker.FEATURE_FILE_USAGE_LIMITS) {
    return Result.ok(undefined);
  }
  return await Result.tryPromise({
    try: async () =>
      await (db ?? (await fileUsageDb())).transaction(async (tx) => {
        const object = await tx
          .select({ organizationId: organizationFileObjects.organizationId })
          .from(organizationFileObjects)
          .where(eq(organizationFileObjects.objectKey, objectKey))
          .limit(1)
          .then((rows) => rows.at(0));
        if (!object) {
          return;
        }
        const counter = await tx
          .select({
            committedBytes: organizationFileUsage.committedBytes,
            reservedBytes: organizationFileUsage.reservedBytes,
          })
          .from(organizationFileUsage)
          .where(
            eq(organizationFileUsage.organizationId, object.organizationId),
          )
          .for("update")
          .then((rows) => rows.at(0));
        const current = await tx
          .select({
            status: organizationFileObjects.status,
            sizeBytes: organizationFileObjects.sizeBytes,
            pendingSizeBytes: organizationFileObjects.pendingSizeBytes,
            writeId: organizationFileObjects.writeId,
          })
          .from(organizationFileObjects)
          .where(eq(organizationFileObjects.objectKey, objectKey))
          .limit(1)
          .then((rows) => rows.at(0));
        if (!counter || !current) {
          return;
        }
        // A timed-out write can arrive after the delete. Keep its identity
        // until a later object-state check can safely settle the reservation.
        if (current.writeId !== null) {
          return;
        }
        await tx
          .delete(organizationFileObjects)
          .where(eq(organizationFileObjects.objectKey, objectKey));
        await tx
          .update(organizationFileUsage)
          .set({
            committedBytes:
              counter.committedBytes -
              (current.status === "committed" ? current.sizeBytes : 0n),
            reservedBytes:
              counter.reservedBytes - reservedContribution(current),
            updatedAt: new Date(),
          })
          .where(
            eq(organizationFileUsage.organizationId, object.organizationId),
          );
      }),
    catch: storageUnavailable,
  });
};

/** Reserve before external I/O and settle only after the provider confirms it. */
export const writeOrganizationFile = async <T>(
  input: FileUsageInput & { write: () => Promise<T>; db?: FileUsageDb },
): Promise<Result<T, OrganizationFileUsageError>> => {
  const reservation = await reserveOrganizationFileBytes(input, input.db);
  if (Result.isError(reservation)) {
    return Result.err(reservation.error);
  }
  const written = await Result.tryPromise({
    try: input.write,
    catch: storageUnavailable,
  });
  if (Result.isError(written)) {
    // A timed-out object write can still complete. The reservation remains
    // until a confirmed delete or object-state reconciliation settles it.
    return Result.err(written.error);
  }
  const committed = await commitOrganizationFileBytes(
    reservation.value,
    input.db,
  );
  return Result.isError(committed)
    ? Result.err(committed.error)
    : Result.ok(written.value);
};

export const copyOrganizationFile = async <T, E>(
  input: FileUsageInput & {
    copy: () => Promise<Result<T, E>>;
    confirmedDestinationAbsentOnCopyError?: (error: E) => boolean;
    db?: FileUsageDb;
  },
): Promise<Result<T, E | OrganizationFileUsageError>> => {
  const reservation = await reserveOrganizationFileBytes(input, input.db);
  if (Result.isError(reservation)) {
    return Result.err(reservation.error);
  }
  const copied = await Result.tryPromise({
    try: input.copy,
    catch: storageUnavailable,
  });
  if (Result.isError(copied)) {
    return Result.err(copied.error);
  }
  if (Result.isError(copied.value)) {
    // Only a copy error that proves the destination was never written may
    // release the reservation; timeouts still need object-state recovery.
    if (input.confirmedDestinationAbsentOnCopyError?.(copied.value.error)) {
      const released = await releaseOrganizationFileBytes(
        reservation.value,
        input.db,
      );
      if (Result.isError(released)) {
        return Result.err(released.error);
      }
    }
    return Result.err(copied.value.error);
  }
  const committed = await commitOrganizationFileBytes(
    reservation.value,
    input.db,
  );
  return Result.isError(committed)
    ? Result.err(committed.error)
    : Result.ok(copied.value.value);
};

/** Import a confirmed object or repair a byte count. Repeating the same scan is a fixed point. */
export const reconcileOrganizationFileObject = async (
  { organizationId, objectKey, sizeBytes }: FileUsageInput,
  db?: FileUsageDb,
) => {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || !objectKey) {
    return panic("Invalid organization file reconciliation input");
  }
  const reconciled = await Result.tryPromise({
    try: async () =>
      await (db ?? (await fileUsageDb())).transaction(async (tx) => {
        await tx
          .insert(organizationFileUsage)
          .values({ organizationId })
          .onConflictDoNothing();
        const counter = await tx
          .select({
            committedBytes: organizationFileUsage.committedBytes,
            reservedBytes: organizationFileUsage.reservedBytes,
          })
          .from(organizationFileUsage)
          .where(eq(organizationFileUsage.organizationId, organizationId))
          .for("update")
          .then((rows) => rows.at(0));
        if (!counter) {
          return panic(
            "Organization file counter disappeared during reconciliation",
          );
        }
        const existing = await tx
          .select({
            organizationId: organizationFileObjects.organizationId,
            sizeBytes: organizationFileObjects.sizeBytes,
            pendingSizeBytes: organizationFileObjects.pendingSizeBytes,
            status: organizationFileObjects.status,
            writeId: organizationFileObjects.writeId,
          })
          .from(organizationFileObjects)
          .where(eq(organizationFileObjects.objectKey, objectKey))
          .limit(1)
          .then((rows) => rows.at(0));
        if (existing && existing.organizationId !== organizationId) {
          return panic("File object belongs to another organization");
        }
        if (existing?.writeId) {
          return "reservation_busy" as const;
        }
        const nextSize = BigInt(sizeBytes);
        if (!existing) {
          await tx.insert(organizationFileObjects).values({
            organizationId,
            objectKey,
            sizeBytes: nextSize,
            status: "committed",
          });
        } else if (
          existing.sizeBytes !== nextSize ||
          existing.status !== "committed" ||
          existing.pendingSizeBytes !== null
        ) {
          await tx
            .update(organizationFileObjects)
            .set({
              sizeBytes: nextSize,
              pendingSizeBytes: null,
              status: "committed",
              writeId: null,
              expectedSha256Hex: null,
              reservationStartedAt: null,
              updatedAt: new Date(),
            })
            .where(eq(organizationFileObjects.objectKey, objectKey));
        } else {
          return undefined;
        }
        await tx
          .update(organizationFileUsage)
          .set({
            committedBytes:
              counter.committedBytes +
              nextSize -
              (existing?.status === "committed" ? existing.sizeBytes : 0n),
            reservedBytes:
              counter.reservedBytes -
              (existing ? reservedContribution(existing) : 0n),
            updatedAt: new Date(),
          })
          .where(eq(organizationFileUsage.organizationId, organizationId));
        return undefined;
      }),
    catch: storageUnavailable,
  });
  if (Result.isError(reconciled)) {
    return Result.err(reconciled.error);
  }
  return reconciled.value === "reservation_busy"
    ? Result.err(
        new OrganizationFileUsageError({
          message: "File write is still reserved",
          reason: "reservation_busy",
        }),
      )
    : Result.ok(undefined);
};
