import type { CellMetadata } from "@/api/db/schema-validators";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditEvent } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";

const CELL_METADATA_VERSION = 1;
const MANUAL_FLAGS_MAX_ITEMS = 16;
const VERIFIED_FLAG_ID = "verified";

type CellMetadataInsert = {
  workspaceId: SafeId<"workspace">;
  entityVersionId: SafeId<"entityVersion">;
  propertyId: SafeId<"property">;
  metadata: CellMetadata;
  createdBy: string;
  updatedBy: string;
};

export type ColumnFlagTarget = {
  entityId: SafeId<"entity">;
  entityVersionId: SafeId<"entityVersion">;
};

type ExistingCellMetadataRow = {
  entityVersionId: SafeId<"entityVersion">;
  metadata: CellMetadata;
};

type BuildColumnFlagMutationArgs = {
  workspaceId: SafeId<"workspace">;
  propertyId: SafeId<"property">;
  flag: string;
  targets: readonly ColumnFlagTarget[];
  existingRows: readonly ExistingCellMetadataRow[];
  userId: string;
  addedAt: string;
};

type ColumnFlagMutation = {
  auditEvents: AuditEvent[];
  insertValues: CellMetadataInsert[];
  updatedCount: number;
};

const normalizeManualFlags = (flags: string[]) =>
  [...new Set(flags)].toSorted();

export const sortColumnFlagTargetsForLocking = (
  targets: readonly ColumnFlagTarget[],
) =>
  targets.toSorted((a, b) =>
    a.entityVersionId.localeCompare(b.entityVersionId),
  );

export const buildColumnFlagMutation = ({
  workspaceId,
  propertyId,
  flag,
  targets,
  existingRows,
  userId,
  addedAt,
}: BuildColumnFlagMutationArgs): ColumnFlagMutation => {
  const existingByVersionId = new Map(
    existingRows.map((row) => [row.entityVersionId, row.metadata]),
  );
  const auditEvents: AuditEvent[] = [];
  const insertValues: CellMetadataInsert[] = [];

  for (const target of targets) {
    const existing = existingByVersionId.get(target.entityVersionId);
    const existingFlags = normalizeManualFlags(existing?.manualFlags ?? []);

    if (existingFlags.includes(flag)) {
      continue;
    }

    if (existingFlags.length >= MANUAL_FLAGS_MAX_ITEMS) {
      continue;
    }

    const manualFlags = normalizeManualFlags([...existingFlags, flag]);
    const existingProvenance = existing?.flagProvenance ?? {};
    const flagProvenance = Object.fromEntries(
      manualFlags.map((manualFlag) => [
        manualFlag,
        existingProvenance[manualFlag] ?? { addedBy: userId, addedAt },
      ]),
    );
    // Adding Verified locks the cell so a subsequent AI sweep can't
    // overwrite the human-confirmed answer. Matches the single-cell
    // behaviour in the frontend toggleFlag handler.
    const willAutoLock = flag === VERIFIED_FLAG_ID && existing?.locked !== true;
    const autoLockProvenance = willAutoLock
      ? {
          lockedBy: userId,
          lockedAt: addedAt,
          reason: "explicit" as const,
        }
      : undefined;
    const nextLockProvenance = existing?.lockProvenance ?? autoLockProvenance;
    const metadata: CellMetadata = {
      version: CELL_METADATA_VERSION,
      manualFlags,
      flagProvenance,
      ...((existing?.locked === true || willAutoLock) && { locked: true }),
      ...(nextLockProvenance && { lockProvenance: nextLockProvenance }),
    };

    insertValues.push({
      workspaceId,
      entityVersionId: target.entityVersionId,
      propertyId,
      metadata,
      createdBy: userId,
      updatedBy: userId,
    });

    auditEvents.push({
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.FIELD,
      resourceId: `${target.entityVersionId}:${propertyId}`,
      changes: {
        manualFlags: { old: existingFlags, new: manualFlags },
      },
      metadata: {
        entityId: target.entityId,
        entityVersionId: target.entityVersionId,
        propertyId,
        bulk: true,
      },
    });
  }

  return {
    auditEvents,
    insertValues,
    updatedCount: insertValues.length,
  };
};
