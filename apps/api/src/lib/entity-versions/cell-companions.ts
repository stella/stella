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

type PlanCellCompanionsOptions<Kind extends CellCloneKind> = {
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

/** Rows a caller inserts in batches of this size. */
export const CELL_COMPANION_BATCH = 500;

type CellMetadataRow = typeof cellMetadata.$inferInsert;
type JustificationRow = typeof justifications.$inferInsert;

/** The companion rows a clone writes beside its cloned cells. */
export type CellCompanionRows = {
  metadata: CellMetadataRow[];
  justifications: JustificationRow[];
};

const planMetadata = async ({
  tx,
  sourceWorkspaceId,
  targetWorkspaceId,
  versions,
  replacedPropertyIds = [],
}: Omit<
  PlanCellCompanionsOptions<CellCloneKind>,
  "kind" | "fieldClones"
>): Promise<CellMetadataRow[]> => {
  const targetVersionIds = new Map(
    versions.map((version) => [
      version.sourceVersionId,
      version.targetVersionId,
    ]),
  );
  const planned: CellMetadataRow[] = [];
  for (const batch of chunkItems(
    [...targetVersionIds.keys()],
    CELL_COMPANION_BATCH,
  )) {
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
    for (const { entityVersionId, ...row } of rows) {
      const targetVersionId = targetVersionIds.get(entityVersionId);
      if (
        targetVersionId !== undefined &&
        !replacedPropertyIds.includes(row.propertyId)
      ) {
        planned.push({
          ...row,
          workspaceId: targetWorkspaceId,
          entityVersionId: targetVersionId,
        });
      }
    }
  }
  return planned;
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

const planJustifications = async ({
  tx,
  sourceWorkspaceId,
  targetWorkspaceId,
  fieldClones,
}: {
  tx: Transaction;
  sourceWorkspaceId: SafeId<"workspace">;
  targetWorkspaceId: SafeId<"workspace">;
  fieldClones: ReadonlyMap<SafeId<"field">, SafeId<"field">>;
}): Promise<JustificationRow[]> => {
  const planned: JustificationRow[] = [];
  for (const batch of chunkItems(
    [...fieldClones.keys()],
    CELL_COMPANION_BATCH,
  )) {
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
    for (const row of rows) {
      const fieldId = fieldClones.get(row.fieldId);
      if (fieldId === undefined) {
        continue;
      }
      planned.push({
        id: createSafeId<"justification">(),
        workspaceId: targetWorkspaceId,
        fieldId,
        content: remapCitedCells(row.content, fieldClones),
        boundingBoxes: row.boundingBoxes,
        fileFieldIds: row.fileFieldIds.flatMap((cited) => {
          const clone = fieldClones.get(cited);
          return clone === undefined ? [] : [clone];
        }),
      });
    }
  }
  return planned;
};

/**
 * The rows a cell clone writes beside its cells, per
 * {@link CELL_COMPANION_POLICY}. Read after the cloned cells are written, in
 * the same transaction and before any source rows are deleted; the caller
 * inserts them in {@link CELL_COMPANION_BATCH}-row batches next to the audit
 * event it records for the clone.
 */
export const planCellCompanions = async <Kind extends CellCloneKind>(
  options: PlanCellCompanionsOptions<Kind>,
): Promise<CellCompanionRows> => {
  const policy: CellCompanionPolicy[CellCloneKind] =
    CELL_COMPANION_POLICY[options.kind];
  return {
    metadata: policy.metadata === "carried" ? await planMetadata(options) : [],
    justifications:
      policy.justifications === "carried" && options.fieldClones
        ? await planJustifications({
            tx: options.tx,
            sourceWorkspaceId: options.sourceWorkspaceId,
            targetWorkspaceId: options.targetWorkspaceId,
            fieldClones: options.fieldClones,
          })
        : [],
  };
};
