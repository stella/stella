import { and, eq, inArray } from "drizzle-orm";

import { chunk as chunkItems } from "@stll/concurrency/chunk";

import type { Transaction } from "@/api/db/root";
import { cellMetadata, justifications } from "@/api/db/schema";
import type { JustificationContent } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";

/** The ways a version's cells are cloned into another version. */
type CellCloneKind = "desktop-edit" | "restore" | "copy" | "move";

/**
 * What each clone carries beside the cell rows themselves (those follow
 * `field-clone-policy.ts`): a cell's lock and override (`cell_metadata`) and
 * the citations a run gave for its value (`justifications`).
 *
 * A desktop edit holds new bytes, so citations into the old ones are dropped;
 * a restore, copy or move holds the same bytes, so they travel with the value.
 * Total over the clone kinds, so a new kind does not compile until it says
 * what it carries. A new file version carries the same as a desktop edit,
 * under the row lock its own writer (`write-file-version.ts`) takes.
 */
const CELL_COMPANION_POLICY = {
  "desktop-edit": { metadata: "carried", justifications: "dropped" },
  restore: { metadata: "carried", justifications: "carried" },
  copy: { metadata: "carried", justifications: "carried" },
  move: { metadata: "carried", justifications: "carried" },
} as const satisfies Record<
  CellCloneKind,
  {
    metadata: "carried" | "dropped";
    justifications: "carried" | "dropped";
  }
>;

type CellCompanionPolicy = typeof CELL_COMPANION_POLICY;

/** One source version and the version its cells were cloned into. */
export type VersionClone = {
  sourceVersionId: SafeId<"entityVersion">;
  targetVersionId: SafeId<"entityVersion">;
};

type CarryCellCompanionsOptions<Kind extends CellCloneKind> = {
  tx: Transaction;
  kind: Kind;
  sourceWorkspaceId: SafeId<"workspace">;
  targetWorkspaceId: SafeId<"workspace">;
  versions: readonly VersionClone[];
  /** Cells the clone replaced rather than copied (a new file), whose companions stay behind. */
  replacedPropertyIds?: readonly SafeId<"property">[];
} & (CellCompanionPolicy[Kind]["justifications"] extends "carried"
  ? {
      /** Every cloned cell: source field id to the id of its clone. */
      fieldClones: ReadonlyMap<SafeId<"field">, SafeId<"field">>;
    }
  : { fieldClones?: never });

const ID_BATCH = 500;

const carryMetadata = async ({
  tx,
  sourceWorkspaceId,
  targetWorkspaceId,
  versions,
  replacedPropertyIds = [],
}: Omit<CarryCellCompanionsOptions<CellCloneKind>, "kind" | "fieldClones">) => {
  const targetVersionIds = new Map(
    versions.map((version) => [
      version.sourceVersionId,
      version.targetVersionId,
    ]),
  );
  for (const batch of chunkItems([...targetVersionIds.keys()], ID_BATCH)) {
    // db-await-in-loop: one read and one insert per bounded batch of source versions
    const rows = await tx
      .select({
        entityVersionId: cellMetadata.entityVersionId,
        propertyId: cellMetadata.propertyId,
        metadata: cellMetadata.metadata,
        createdBy: cellMetadata.createdBy,
        updatedBy: cellMetadata.updatedBy,
        createdAt: cellMetadata.createdAt,
        updatedAt: cellMetadata.updatedAt,
      })
      .from(cellMetadata)
      .where(
        and(
          eq(cellMetadata.workspaceId, sourceWorkspaceId),
          inArray(cellMetadata.entityVersionId, batch),
        ),
      );
    const carried = rows.filter(
      (row) => !replacedPropertyIds.includes(row.propertyId),
    );
    if (carried.length > 0) {
      // audit: skip - the caller audits the clone these rows belong to.
      // db-await-in-loop: the insert for the batch read above
      await tx.insert(cellMetadata).values(
        carried.map(({ entityVersionId, ...row }) => ({
          ...row,
          workspaceId: targetWorkspaceId,
          entityVersionId:
            targetVersionIds.get(entityVersionId) ?? entityVersionId,
        })),
      );
    }
  }
};

/**
 * A citation's content with each cited file cell moved to its clone. A run
 * reads only the cells of its own version, so every cited cell was cloned
 * with it; a block citing one that was not has nothing to point at.
 */
const remapCitedCells = (
  content: JustificationContent,
  fieldClones: ReadonlyMap<SafeId<"field">, SafeId<"field">>,
): JustificationContent => ({
  ...content,
  blocks: content.blocks.flatMap((block): JustificationContent["blocks"] => {
    if (block.kind !== "pdf-bates" && block.kind !== "docx-folio") {
      return [block];
    }
    const fileFieldId = fieldClones.get(block.fileFieldId);
    return fileFieldId === undefined ? [] : [{ ...block, fileFieldId }];
  }),
});

const carryJustifications = async ({
  tx,
  sourceWorkspaceId,
  targetWorkspaceId,
  fieldClones,
}: {
  tx: Transaction;
  sourceWorkspaceId: SafeId<"workspace">;
  targetWorkspaceId: SafeId<"workspace">;
  fieldClones: ReadonlyMap<SafeId<"field">, SafeId<"field">>;
}) => {
  for (const batch of chunkItems([...fieldClones.keys()], ID_BATCH)) {
    // db-await-in-loop: one read and one insert per bounded batch of cloned cells
    const rows = await tx
      .select({
        fieldId: justifications.fieldId,
        content: justifications.content,
        boundingBoxes: justifications.boundingBoxes,
        fileFieldIds: justifications.fileFieldIds,
      })
      .from(justifications)
      .where(
        and(
          eq(justifications.workspaceId, sourceWorkspaceId),
          inArray(justifications.fieldId, batch),
        ),
      );
    const carried = rows.flatMap((row) => {
      const fieldId = fieldClones.get(row.fieldId);
      return fieldId === undefined
        ? []
        : [
            {
              id: createSafeId<"justification">(),
              workspaceId: targetWorkspaceId,
              fieldId,
              content: remapCitedCells(row.content, fieldClones),
              boundingBoxes: row.boundingBoxes,
              fileFieldIds: row.fileFieldIds.flatMap((cited) => {
                const clone = fieldClones.get(cited);
                return clone === undefined ? [] : [clone];
              }),
            },
          ];
    });
    if (carried.length > 0) {
      // audit: skip - the caller audits the clone these rows belong to.
      // db-await-in-loop: the insert for the batch read above
      await tx.insert(justifications).values(carried);
    }
  }
};

/**
 * Carry what a cell clone keeps beside its rows, per
 * {@link CELL_COMPANION_POLICY}. Call it after the cloned cells are written,
 * in the same transaction, and before any source rows are deleted.
 */
export const carryCellCompanions = async <Kind extends CellCloneKind>(
  options: CarryCellCompanionsOptions<Kind>,
): Promise<void> => {
  const policy: CellCompanionPolicy[CellCloneKind] =
    CELL_COMPANION_POLICY[options.kind];
  if (policy.metadata === "carried") {
    await carryMetadata(options);
  }
  if (policy.justifications === "carried" && options.fieldClones) {
    await carryJustifications({
      tx: options.tx,
      sourceWorkspaceId: options.sourceWorkspaceId,
      targetWorkspaceId: options.targetWorkspaceId,
      fieldClones: options.fieldClones,
    });
  }
};
