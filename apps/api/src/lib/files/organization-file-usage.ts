import { Panic, panic, Result } from "better-result";
import { and, count, eq } from "drizzle-orm";

import {
  organizationFileObjects,
  organizationFileUsage,
  usageEntitlements,
  usagePolicies,
  usageSeatAssignments,
} from "@/api/db/schema";
import { env } from "@/api/env";
import type { SafeId } from "@/api/lib/branded-types";
import type { MaintenanceDb } from "@/api/lib/db/maintenance-db";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { lockAssignmentCapacity } from "@/api/lib/usage/assignment-capacity";
import { isEntitlementConsumableAt } from "@/api/lib/usage/usage-ledger";

type OrganizationFileUsageErrorProps = {
  message: string;
  reason:
    | "capacity_exceeded"
    | "capability_unavailable"
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
};

export type FileUsageReservation =
  | { status: "disabled" }
  | { status: "already_committed" }
  | {
      status: "reserved";
      organizationId: SafeId<"organization">;
      objectKey: string;
    };

const storageUnavailable = (cause: unknown) => {
  if (Panic.is(cause)) {
    throw cause;
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

/** The organization row is the lock for every object and byte transition. */
export const reserveOrganizationFileBytes = async (
  { organizationId, objectKey, sizeBytes }: FileUsageInput,
  db?: FileUsageDb,
): Promise<Result<FileUsageReservation, OrganizationFileUsageError>> => {
  if (!env.FEATURE_FILE_USAGE_LIMITS) {
    return Result.ok({ status: "disabled" } as const);
  }
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || !objectKey) {
    return panic("Invalid organization file reservation");
  }
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
          if (existing.sizeBytes === BigInt(sizeBytes)) {
            return { status: "already_committed" as const };
          }
        }

        const additionalBytes = existing
          ? positiveDifference(BigInt(sizeBytes), existing.sizeBytes)
          : BigInt(sizeBytes);

        const entitlement = await tx
          .select({
            status: usageEntitlements.status,
            currentPeriodStart: usageEntitlements.currentPeriodStart,
            currentPeriodEnd: usageEntitlements.currentPeriodEnd,
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
        if (
          !entitlement ||
          !isEntitlementConsumableAt(entitlement) ||
          entitlement.storageBytesPerAssignment === null
        ) {
          return { status: "capability_unavailable" as const };
        }
        const assignments = await tx
          .select({ value: count() })
          .from(usageSeatAssignments)
          .where(eq(usageSeatAssignments.organizationId, organizationId))
          .then((rows) => rows.at(0)?.value ?? 0);
        const cap = entitlement.storageBytesPerAssignment * BigInt(assignments);
        if (
          additionalBytes > 0n &&
          counter.committedBytes + counter.reservedBytes + additionalBytes > cap
        ) {
          return { status: "capacity_exceeded" as const };
        }

        if (existing) {
          await tx
            .update(organizationFileObjects)
            .set({
              pendingSizeBytes: BigInt(sizeBytes),
              updatedAt: new Date(),
            })
            .where(eq(organizationFileObjects.objectKey, objectKey));
        } else {
          await tx.insert(organizationFileObjects).values({
            organizationId,
            objectKey,
            sizeBytes: BigInt(sizeBytes),
            status: "reserved",
          });
        }
        await tx
          .update(organizationFileUsage)
          .set({
            reservedBytes: counter.reservedBytes + additionalBytes,
            updatedAt: new Date(),
          })
          .where(eq(organizationFileUsage.organizationId, organizationId));
        return { status: "reserved" as const, organizationId, objectKey };
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
    case "reservation_busy":
      return Result.err(
        new OrganizationFileUsageError({
          message: "File write is already in progress",
          reason: "reservation_busy",
        }),
      );
    case "capacity_exceeded":
      return Result.err(
        new OrganizationFileUsageError({
          message: "Organization file capacity exceeded",
          reason: "capacity_exceeded",
        }),
      );
    case "capability_unavailable":
      return Result.err(
        new OrganizationFileUsageError({
          message: "Organization file capability is unavailable",
          reason: "capability_unavailable",
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
  return await Result.tryPromise({
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
        if (object.status === "committed" && object.pendingSizeBytes === null) {
          return;
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
      }),
    catch: storageUnavailable,
  });
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
        if (!counter) {
          return panic("File counter disappeared before release");
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
            .set({ pendingSizeBytes: null, updatedAt: new Date() })
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
  if (!env.FEATURE_FILE_USAGE_LIMITS) {
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
          })
          .from(organizationFileObjects)
          .where(eq(organizationFileObjects.objectKey, objectKey))
          .limit(1)
          .then((rows) => rows.at(0));
        if (!counter || !current) {
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
    const released = await releaseOrganizationFileBytes(
      reservation.value,
      input.db,
    );
    return Result.isError(released)
      ? Result.err(released.error)
      : Result.err(written.error);
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
    const released = await releaseOrganizationFileBytes(
      reservation.value,
      input.db,
    );
    if (Result.isError(released)) {
      return Result.err(released.error);
    }
    return Result.err(copied.error);
  }
  if (Result.isError(copied.value)) {
    const released = await releaseOrganizationFileBytes(
      reservation.value,
      input.db,
    );
    if (Result.isError(released)) {
      return Result.err(released.error);
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
  return await Result.tryPromise({
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
          })
          .from(organizationFileObjects)
          .where(eq(organizationFileObjects.objectKey, objectKey))
          .limit(1)
          .then((rows) => rows.at(0));
        if (existing && existing.organizationId !== organizationId) {
          return panic("File object belongs to another organization");
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
              updatedAt: new Date(),
            })
            .where(eq(organizationFileObjects.objectKey, objectKey));
        } else {
          return;
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
      }),
    catch: storageUnavailable,
  });
};
