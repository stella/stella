import { Panic, panic, Result } from "better-result";
import { asc, eq, sql } from "drizzle-orm";

import { sha256Hex as hashSha256Hex } from "@stll/sha256/bun";
import { Temporal } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import {
  organizationFileObjects,
  organizationFileUsage,
} from "@/api/db/schema";
import { envDocumentProcessingWorker } from "@/api/env-document-processing-worker";
import type { SafeId } from "@/api/lib/branded-types";
import { executedRows } from "@/api/lib/db/executed-rows";
import type { MaintenanceDb } from "@/api/lib/db/maintenance-db";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { isRecord } from "@/api/lib/type-guards";
import {
  lockAssignmentCapacities,
  lockAssignmentCapacity,
} from "@/api/lib/usage/assignment-capacity";

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

const storageCapacityRow = (row: unknown): [string, bigint | null] => {
  if (
    !isRecord(row) ||
    typeof row["organizationId"] !== "string" ||
    (row["capacity"] !== null && typeof row["capacity"] !== "string")
  ) {
    return panic("Organization storage capacity row is malformed");
  }
  return [
    row["organizationId"],
    row["capacity"] === null ? null : BigInt(row["capacity"]),
  ];
};

/**
 * The organization's storage capacity in bytes, or null when nothing bounds
 * it: the `organization_storage_capacity` database function, which reads the
 * effective policy (a live entitlement's, or the free floor).
 */
const readOrganizationStorageCapacity = async (
  tx: Pick<Transaction, "execute">,
  organizationId: SafeId<"organization">,
): Promise<bigint | null> => {
  const rows = executedRows(
    await tx.execute(
      sql`select ${organizationId} as "organizationId", organization_storage_capacity(${organizationId})::text as capacity`,
    ),
  );
  const [, capacity] = storageCapacityRow(
    rows.at(0) ?? panic("Organization storage capacity row is missing"),
  );
  return capacity;
};

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

        const cap = await readOrganizationStorageCapacity(tx, organizationId);
        if (cap !== null) {
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
      const recovered = await recoverOrganizationFileReservations(
        [{ organizationId, objectKey }],
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
  const committed = await commitOrganizationFilesBytes([reservation], db);
  if (Result.isError(committed)) {
    return Result.err(committed.error);
  }
  return committed.value.busyObjectKeys.length === 0
    ? Result.ok(undefined)
    : Result.err(batchUsageError("reservation_busy"));
};

export const releaseOrganizationFileBytes = async (
  reservation: FileUsageReservation,
  db?: FileUsageDb,
) => await releaseOrganizationFilesBytes([reservation], db);

/** Call only after storage confirms deletion. Replays are free. */
export const removeOrganizationFileBytes = async (
  objectKey: string,
  db?: FileUsageDb,
) => await removeOrganizationFilesBytes([objectKey], db);

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

/** Reconcile one confirmed-object page; active writes are left to their owner. */
export const reconcileOrganizationFileObjects = async (
  inputs: readonly FileUsageInput[],
  db?: FileUsageDb,
): Promise<Result<number, OrganizationFileUsageError>> => {
  if (inputs.length === 0) {
    return Result.ok(0);
  }
  const keys = new Set<string>();
  for (const input of inputs) {
    if (
      !Number.isSafeInteger(input.sizeBytes) ||
      input.sizeBytes < 0 ||
      !input.objectKey ||
      keys.has(input.objectKey)
    ) {
      return panic("Invalid organization file reconciliation batch");
    }
    keys.add(input.objectKey);
  }
  const organizationIds = [
    ...new Set(inputs.map((input) => input.organizationId)),
  ].toSorted();
  let transactionFailure: OrganizationFileUsageError | undefined;
  return await Result.tryPromise({
    try: async () =>
      await (db ?? (await fileUsageDb())).transaction(async (tx) => {
        const abortConflict = () => {
          transactionFailure = batchUsageError("key_conflict");
          return tx.rollback();
        };
        await tx.execute(sql`
        insert into organization_file_usage (organization_id)
        select value from jsonb_array_elements_text(${JSON.stringify(organizationIds)}::text::jsonb) as x(value)
        order by value on conflict do nothing
      `);
        const counters = await tx
          .select({ organizationId: organizationFileUsage.organizationId })
          .from(organizationFileUsage)
          .where(
            sql`${organizationFileUsage.organizationId} in (select jsonb_array_elements_text(${JSON.stringify(organizationIds)}::text::jsonb))`,
          )
          .orderBy(asc(organizationFileUsage.organizationId))
          .limit(organizationIds.length)
          .for("update");
        if (counters.length !== organizationIds.length) {
          return panic(
            "Organization file counter disappeared during batch reconciliation",
          );
        }
        const objects = await tx
          .select()
          .from(organizationFileObjects)
          .where(
            sql`${organizationFileObjects.objectKey} in (select jsonb_array_elements_text(${JSON.stringify([...keys])}::text::jsonb))`,
          )
          .limit(inputs.length);
        const objectByKey = new Map(
          objects.map((object) => [object.objectKey, object]),
        );
        const mutations: {
          organizationId: string;
          objectKey: string;
          sizeBytes: string;
          committedDelta: string;
          reservedDelta: string;
        }[] = [];
        let imported = 0;
        for (const input of inputs) {
          const existing = objectByKey.get(input.objectKey);
          if (existing && existing.organizationId !== input.organizationId) {
            return abortConflict();
          }
          if (existing?.writeId) {
            continue;
          }
          imported++;
          const size = BigInt(input.sizeBytes);
          if (
            existing?.status === "committed" &&
            existing.sizeBytes === size &&
            existing.pendingSizeBytes === null
          ) {
            continue;
          }
          mutations.push({
            organizationId: input.organizationId,
            objectKey: input.objectKey,
            sizeBytes: size.toString(),
            committedDelta: (
              size -
              (existing?.status === "committed" ? existing.sizeBytes : 0n)
            ).toString(),
            reservedDelta: (existing
              ? -reservedContribution(existing)
              : 0n
            ).toString(),
          });
        }
        if (mutations.length === 0) {
          return imported;
        }
        const changed = await tx.execute(sql`
        with input as (
          select * from jsonb_to_recordset(${JSON.stringify(mutations)}::text::jsonb)
          as x("organizationId" text, "objectKey" text, "sizeBytes" bigint, "committedDelta" bigint, "reservedDelta" bigint)
        ), changed as (
          insert into organization_file_objects (organization_id, object_key, size_bytes, status)
          select "organizationId", "objectKey", "sizeBytes", 'committed' from input order by "objectKey"
          on conflict (object_key) do update set
            size_bytes = excluded.size_bytes, pending_size_bytes = null,
            status = 'committed', write_id = null, expected_sha256_hex = null,
            reservation_started_at = null, updated_at = now()
          where organization_file_objects.organization_id = excluded.organization_id
            and organization_file_objects.write_id is null
          returning object_key
        ), deltas as (
          select "organizationId", sum("committedDelta") as committed, sum("reservedDelta") as reserved
          from input join changed on changed.object_key = input."objectKey"
          group by "organizationId"
        )
        update organization_file_usage u set
          committed_bytes = u.committed_bytes + d.committed,
          reserved_bytes = u.reserved_bytes + d.reserved, updated_at = now()
        from deltas d where u.organization_id = d."organizationId"
        returning (select count(*)::int from changed) as changed_count
      `);
        const outcome = executedRows(changed).at(0);
        if (
          !isRecord(outcome) ||
          outcome["changed_count"] !== mutations.length
        ) {
          return abortConflict();
        }
        return imported;
      }),
    catch: (cause) => transactionFailure ?? storageUnavailable(cause),
  });
};

const batchUsageError = (reason: OrganizationFileUsageError["reason"]) =>
  new OrganizationFileUsageError({
    message: `Organization file batch ${reason}`,
    reason,
  });

/** All capacity decisions share ordered roster and counter locks. */
const reserveOrganizationFilesBytesOnce = async (
  inputs: readonly FileUsageInput[],
  db?: FileUsageDb,
): Promise<Result<FileUsageReservation[], OrganizationFileUsageError>> => {
  if (inputs.length === 0) {
    return Result.ok([]);
  }
  if (!envDocumentProcessingWorker.FEATURE_FILE_USAGE_LIMITS) {
    return Result.ok(inputs.map(() => ({ status: "disabled" as const })));
  }
  const keys = new Set<string>();
  for (const input of inputs) {
    if (
      !Number.isSafeInteger(input.sizeBytes) ||
      input.sizeBytes < 0 ||
      !input.objectKey ||
      (input.contentSha256Hex !== undefined &&
        !/^[\da-f]{64}$/u.test(input.contentSha256Hex)) ||
      keys.has(input.objectKey)
    ) {
      return panic("Invalid organization file batch reservation");
    }
    keys.add(input.objectKey);
  }
  const organizationIds = [
    ...new Set(inputs.map((input) => input.organizationId)),
  ].toSorted();
  let transactionFailure: OrganizationFileUsageError | undefined;
  const reserved = await Result.tryPromise({
    try: async () =>
      await (db ?? (await fileUsageDb())).transaction(async (tx) => {
        const abortReservation = (
          reason: OrganizationFileUsageError["reason"],
        ) => {
          transactionFailure = batchUsageError(reason);
          return tx.rollback();
        };
        await lockAssignmentCapacities(tx, organizationIds);
        await tx
          .insert(organizationFileUsage)
          .values(organizationIds.map((id) => ({ organizationId: id })))
          .onConflictDoNothing();
        const counters = await tx
          .select()
          .from(organizationFileUsage)
          .where(
            sql`${organizationFileUsage.organizationId} in (select jsonb_array_elements_text(${JSON.stringify(organizationIds)}::text::jsonb))`,
          )
          .orderBy(asc(organizationFileUsage.organizationId))
          .limit(organizationIds.length)
          .for("update");
        const objects = await tx
          .select()
          .from(organizationFileObjects)
          .where(
            sql`${organizationFileObjects.objectKey} in (select jsonb_array_elements_text(${JSON.stringify([...keys])}::text::jsonb))`,
          );
        const capacities = await tx.execute(sql`
          select id as "organizationId", organization_storage_capacity(id)::text as capacity
          from jsonb_array_elements_text(${JSON.stringify(organizationIds)}::text::jsonb) as ids(id)
        `);
        const objectByKey = new Map(
          objects.map((object) => [object.objectKey, object]),
        );
        const counterByOrg = new Map(
          counters.map((counter) => [counter.organizationId, counter]),
        );
        const capacityByOrg = new Map(
          executedRows(capacities).map((row) => storageCapacityRow(row)),
        );
        const growthByOrg = new Map<SafeId<"organization">, bigint>();
        const growingOrgs = new Set<SafeId<"organization">>();
        const reservations: FileUsageReservation[] = [];
        const mutations: {
          organizationId: string;
          objectKey: string;
          sizeBytes: string;
          writeId: string;
          sha256: string | null;
          reservedDelta: string;
        }[] = [];
        for (const input of inputs) {
          const existing = objectByKey.get(input.objectKey);
          if (existing && existing.organizationId !== input.organizationId) {
            return abortReservation("key_conflict");
          }
          if (
            existing &&
            (existing.status === "reserved" ||
              existing.pendingSizeBytes !== null)
          ) {
            return abortReservation("reservation_busy");
          }
          const size = BigInt(input.sizeBytes);
          const growth = existing
            ? positiveDifference(size, existing.sizeBytes)
            : size;
          growthByOrg.set(
            input.organizationId,
            (growthByOrg.get(input.organizationId) ?? 0n) + growth,
          );
          if (!existing || size > existing.sizeBytes) {
            growingOrgs.add(input.organizationId);
          }
          if (
            existing?.sizeBytes === size &&
            input.contentSha256Hex === undefined
          ) {
            reservations.push({ status: "already_committed" });
            continue;
          }
          const writeId = Bun.randomUUIDv7();
          reservations.push({
            status: "reserved",
            organizationId: input.organizationId,
            objectKey: input.objectKey,
            writeId,
          });
          mutations.push({
            organizationId: input.organizationId,
            objectKey: input.objectKey,
            sizeBytes: size.toString(),
            writeId,
            sha256: input.contentSha256Hex ?? null,
            reservedDelta: growth.toString(),
          });
        }
        for (const organizationId of organizationIds) {
          const counter = counterByOrg.get(organizationId);
          if (!counter) {
            return panic("Organization file counter disappeared");
          }
          // Null is a valid capacity (unbounded); only a missing row is a fault.
          const capacity = capacityByOrg.get(organizationId);
          if (capacity === undefined) {
            return panic("Organization storage capacity row is missing");
          }
          if (
            capacity !== null &&
            growingOrgs.has(organizationId) &&
            counter.committedBytes +
              counter.reservedBytes +
              (growthByOrg.get(organizationId) ?? 0n) >
              capacity
          ) {
            return abortReservation("capacity_exceeded");
          }
        }
        if (mutations.length !== 0) {
          const changed = await tx.execute(sql`
          with input as (select * from jsonb_to_recordset(${JSON.stringify(mutations)}::text::jsonb) as x("organizationId" text, "objectKey" text, "sizeBytes" bigint, "writeId" text, sha256 text, "reservedDelta" bigint)),
          changed as (
            insert into organization_file_objects (organization_id, object_key, size_bytes, status, write_id, expected_sha256_hex, reservation_started_at)
            select "organizationId", "objectKey", "sizeBytes", 'reserved', "writeId", sha256, now() from input
            on conflict (object_key) do update set pending_size_bytes = excluded.size_bytes, write_id = excluded.write_id, expected_sha256_hex = excluded.expected_sha256_hex, reservation_started_at = excluded.reservation_started_at, updated_at = now()
            where organization_file_objects.organization_id = excluded.organization_id and organization_file_objects.write_id is null
            returning object_key
          ), deltas as (select "organizationId", sum("reservedDelta") as reserved from input join changed on changed.object_key = input."objectKey" group by "organizationId")
          update organization_file_usage u set reserved_bytes = u.reserved_bytes + d.reserved, updated_at = now() from deltas d where u.organization_id = d."organizationId"
          returning (select count(*)::int from changed) as changed_count
        `);
          const outcome = executedRows(changed).at(0);
          if (
            !isRecord(outcome) ||
            outcome["changed_count"] !== mutations.length
          ) {
            return abortReservation("key_conflict");
          }
        }
        return reservations;
      }),
    catch: (cause) => transactionFailure ?? storageUnavailable(cause),
  });
  return reserved;
};

/** Recover stale batch identities together before a single retry. */
const recoverOrganizationFileReservations = async (
  inputs: readonly Pick<FileUsageInput, "organizationId" | "objectKey">[],
  db?: FileUsageDb,
): Promise<Result<boolean, OrganizationFileUsageError>> => {
  const rows = await Result.tryPromise({
    try: async () =>
      await (db ?? (await fileUsageDb())).transaction(
        async (tx) =>
          await tx
            .select()
            .from(organizationFileObjects)
            .where(
              sql`${organizationFileObjects.objectKey} in (select jsonb_array_elements_text(${JSON.stringify(inputs.map((input) => input.objectKey))}::text::jsonb))`,
            ),
      ),
    catch: storageUnavailable,
  });
  if (Result.isError(rows)) {
    return Result.err(rows.error);
  }
  const inputByKey = new Map(inputs.map((input) => [input.objectKey, input]));
  const toCommit: FileUsageReservation[] = [];
  const toRelease: FileUsageReservation[] = [];
  const { headObject } = await import("@/api/lib/s3-presign");
  const { getS3ObjectWithSignal, isMissingS3ObjectError } =
    await import("@/api/lib/s3");
  for (const object of rows.value) {
    if (
      inputByKey.get(object.objectKey)?.organizationId !==
        object.organizationId ||
      (object.status === "committed" && object.pendingSizeBytes === null)
    ) {
      continue;
    }
    if (!object.writeId || !object.reservationStartedAt) {
      return panic("File reservation has no write identity");
    }
    const ageMs =
      Temporal.Now.instant().epochMilliseconds -
      object.reservationStartedAt.getTime();
    if (ageMs < FILE_RESERVATION_RECOVERY_DELAY_MS) {
      continue;
    }
    const reservation = {
      status: "reserved" as const,
      organizationId: object.organizationId,
      objectKey: object.objectKey,
      writeId: object.writeId,
    };
    const head = await headObject(object.objectKey);
    if (Result.isError(head)) {
      if (!isMissingS3ObjectError(head.error.cause)) {
        return Result.err(storageUnavailable(head.error));
      }
      if (ageMs >= FILE_RESERVATION_ABANDON_DELAY_MS) {
        toRelease.push(reservation);
      }
      continue;
    }
    if (
      head.value.contentLength !==
      Number(object.pendingSizeBytes ?? object.sizeBytes)
    ) {
      if (
        object.expectedSha256Hex !== null &&
        ageMs >= FILE_RESERVATION_ABANDON_DELAY_MS
      ) {
        toRelease.push(reservation);
      }
      continue;
    }
    if (
      object.expectedSha256Hex === null &&
      (head.value.lastModified === null ||
        head.value.lastModified.getTime() + S3_LAST_MODIFIED_PRECISION_MS <
          object.reservationStartedAt.getTime())
    ) {
      continue;
    }
    if (object.expectedSha256Hex !== null) {
      const read = await Result.tryPromise({
        try: async () =>
          await getS3ObjectWithSignal(
            object.objectKey,
            AbortSignal.timeout(30_000),
          ),
        catch: storageUnavailable,
      });
      if (Result.isError(read)) {
        return Result.err(read.error);
      }
      if (
        hashSha256Hex(new Uint8Array(read.value)) !== object.expectedSha256Hex
      ) {
        if (ageMs >= FILE_RESERVATION_ABANDON_DELAY_MS) {
          toRelease.push(reservation);
        }
        continue;
      }
    }
    toCommit.push(reservation);
  }
  const committed = await commitOrganizationFilesBytes(toCommit, db);
  if (Result.isError(committed)) {
    return Result.err(committed.error);
  }
  const released = await releaseOrganizationFilesBytes(toRelease, db);
  if (Result.isError(released)) {
    return Result.err(released.error);
  }
  const busyKeys = new Set(committed.value.busyObjectKeys);
  return Result.ok(
    toRelease.length > 0 ||
      toCommit.some(
        (reservation) =>
          reservation.status === "reserved" &&
          !busyKeys.has(reservation.objectKey),
      ),
  );
};

export const reserveOrganizationFilesBytes = async (
  inputs: readonly FileUsageInput[],
  db?: FileUsageDb,
): Promise<Result<FileUsageReservation[], OrganizationFileUsageError>> => {
  const reserved = await reserveOrganizationFilesBytesOnce(inputs, db);
  if (Result.isOk(reserved) || reserved.error.reason !== "reservation_busy") {
    return reserved;
  }
  const recovered = await recoverOrganizationFileReservations(inputs, db);
  if (Result.isError(recovered)) {
    return Result.err(recovered.error);
  }
  return await reserveOrganizationFilesBytesOnce(inputs, db);
};

export const ORGANIZATION_FILE_ACCOUNTING_BATCH_LIMIT = 128;

type FileBatchTransition = "commit" | "release" | "remove";

type FileBatchTransitionOptions = {
  transition: FileBatchTransition;
  reservations: readonly FileUsageReservation[];
  objectKeys: readonly string[];
  db?: FileUsageDb | undefined;
};

const transitionOrganizationFilesBytes = async ({
  transition,
  reservations,
  objectKeys,
  db,
}: FileBatchTransitionOptions): Promise<
  Result<{ busyObjectKeys: string[] }, OrganizationFileUsageError>
> => {
  const active = reservations.filter(
    (reservation) => reservation.status === "reserved",
  );
  const keys = [
    ...new Set(
      transition === "remove"
        ? objectKeys
        : active.map((reservation) => reservation.objectKey),
    ),
  ];
  if (keys.length === 0) {
    return Result.ok({ busyObjectKeys: [] });
  }
  return await Result.tryPromise({
    try: async () =>
      await (db ?? (await fileUsageDb())).transaction(async (tx) => {
        const initial = await tx
          .select({ organizationId: organizationFileObjects.organizationId })
          .from(organizationFileObjects)
          .where(
            sql`${organizationFileObjects.objectKey} in (select jsonb_array_elements_text(${JSON.stringify(keys)}::text::jsonb))`,
          );
        const organizationIds = [
          ...new Set(
            initial
              .map((object) => object.organizationId)
              .concat(active.map((reservation) => reservation.organizationId)),
          ),
        ].toSorted();
        if (organizationIds.length === 0) {
          return { busyObjectKeys: transition === "commit" ? keys : [] };
        }
        const counters = await tx
          .select()
          .from(organizationFileUsage)
          .where(
            sql`${organizationFileUsage.organizationId} in (select jsonb_array_elements_text(${JSON.stringify(organizationIds)}::text::jsonb))`,
          )
          .orderBy(asc(organizationFileUsage.organizationId))
          .limit(organizationIds.length)
          .for("update");
        const objects = await tx
          .select()
          .from(organizationFileObjects)
          .where(
            sql`${organizationFileObjects.objectKey} in (select jsonb_array_elements_text(${JSON.stringify(keys)}::text::jsonb))`,
          );
        const objectByKey = new Map(
          objects.map((object) => [object.objectKey, object]),
        );
        const counterOrgs = new Set(
          counters.map((counter) => counter.organizationId),
        );
        const reservationsByKey = new Map(
          active.map((reservation) => [reservation.objectKey, reservation]),
        );
        const mutations: {
          organizationId: string;
          objectKey: string;
          sizeBytes: string;
          remove: boolean;
          committedDelta: string;
          reservedDelta: string;
        }[] = [];
        const busyObjectKeys: string[] = [];
        for (const key of keys) {
          const object = objectByKey.get(key);
          const reservation = reservationsByKey.get(key);
          if (
            transition === "commit" &&
            (!object ||
              !reservation ||
              !counterOrgs.has(reservation.organizationId))
          ) {
            busyObjectKeys.push(key);
            continue;
          }
          if (!object) {
            continue;
          }
          if (
            transition !== "remove" &&
            (!reservation ||
              object.organizationId !== reservation.organizationId ||
              object.writeId !== reservation.writeId)
          ) {
            if (transition === "commit") {
              busyObjectKeys.push(key);
            }
            continue;
          }
          if (transition === "remove" && object.writeId !== null) {
            continue;
          }
          if (
            transition !== "remove" &&
            object.status === "committed" &&
            object.pendingSizeBytes === null
          ) {
            continue;
          }
          if (!counterOrgs.has(object.organizationId)) {
            return panic("File counter disappeared during batch transition");
          }
          const nextSize = object.pendingSizeBytes ?? object.sizeBytes;
          const remove =
            transition === "remove" ||
            (transition === "release" && object.status === "reserved");
          let committedDelta = 0n;
          if (transition === "commit") {
            committedDelta =
              nextSize -
              (object.status === "committed" ? object.sizeBytes : 0n);
          } else if (transition === "remove" && object.status === "committed") {
            committedDelta = -object.sizeBytes;
          }
          mutations.push({
            organizationId: object.organizationId,
            objectKey: key,
            sizeBytes: (transition === "commit"
              ? nextSize
              : object.sizeBytes
            ).toString(),
            remove,
            committedDelta: committedDelta.toString(),
            reservedDelta: (-reservedContribution(object)).toString(),
          });
        }
        if (mutations.length === 0) {
          return { busyObjectKeys };
        }
        await tx.execute(sql`
        with input as (select * from jsonb_to_recordset(${JSON.stringify(mutations)}::text::jsonb) as x("organizationId" text, "objectKey" text, "sizeBytes" bigint, remove boolean, "committedDelta" bigint, "reservedDelta" bigint)),
        removed as (delete from organization_file_objects o using input i where o.object_key = i."objectKey" and o.organization_id = i."organizationId" and i.remove returning o.object_key),
        updated as (update organization_file_objects o set status = 'committed', size_bytes = i."sizeBytes", pending_size_bytes = null, write_id = null, expected_sha256_hex = null, reservation_started_at = null, updated_at = now() from input i where o.object_key = i."objectKey" and o.organization_id = i."organizationId" and not i.remove returning o.object_key),
        changed as (select object_key from removed union all select object_key from updated),
        deltas as (select "organizationId", sum("committedDelta") as committed, sum("reservedDelta") as reserved from input join changed on changed.object_key = input."objectKey" group by "organizationId")
        update organization_file_usage u set committed_bytes = u.committed_bytes + d.committed, reserved_bytes = u.reserved_bytes + d.reserved, updated_at = now() from deltas d where u.organization_id = d."organizationId"
      `);
        return { busyObjectKeys };
      }),
    catch: (cause) =>
      cause instanceof OrganizationFileUsageError
        ? cause
        : storageUnavailable(cause),
  });
};

export const commitOrganizationFilesBytes = async (
  reservations: readonly FileUsageReservation[],
  db?: FileUsageDb,
) =>
  await transitionOrganizationFilesBytes({
    transition: "commit",
    reservations,
    objectKeys: [],
    db,
  });

export const releaseOrganizationFilesBytes = async (
  reservations: readonly FileUsageReservation[],
  db?: FileUsageDb,
) =>
  (
    await transitionOrganizationFilesBytes({
      transition: "release",
      reservations,
      objectKeys: [],
      db,
    })
  ).map(() => undefined);

/** Call after confirmed storage deletions; in-flight identities remain reserved. */
export const removeOrganizationFilesBytes = async (
  objectKeys: readonly string[],
  db?: FileUsageDb,
) =>
  envDocumentProcessingWorker.FEATURE_FILE_USAGE_LIMITS
    ? (
        await transitionOrganizationFilesBytes({
          transition: "remove",
          reservations: [],
          objectKeys,
          db,
        })
      ).map(() => undefined)
    : Promise.resolve(Result.ok(undefined));

export const writeOrganizationFiles = async <T>(
  inputs: readonly (FileUsageInput & { write: () => Promise<T> })[],
  db?: FileUsageDb,
): Promise<
  Result<Result<T, OrganizationFileUsageError>[], OrganizationFileUsageError>
> => {
  const { copyOrganizationFiles } =
    await import("@/api/lib/files/copy-organization-files");
  return await copyOrganizationFiles({
    inputs: inputs.map(({ write, ...input }) => ({
      ...input,
      copy: async () =>
        await Result.tryPromise({ try: write, catch: storageUnavailable }),
    })),
    concurrency: 1,
    db,
  });
};
