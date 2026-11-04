import { REVIEW_FLAG } from "@stll/api-contract";
import type { AiCellSettlement } from "@stll/api-contract";

import type { JustificationContent } from "@/api/db/schema";
import type { BoundingBoxes, CellMetadata } from "@/api/db/schema-validators";
import type { SafeId } from "@/api/lib/branded-types";

/**
 * What a new document version carries from the version it replaces, beyond
 * the cell values `cloneFieldsForRevision` copies: each cell's settlement and
 * citations, and, for the cells whose inputs the new file changes, a stale
 * mark on the settlement (or, for a cell a person owns, a needs-review flag).
 *
 * Pure: the caller reads the source rows and writes the result, inside the
 * version-write transaction.
 */

type FieldId = SafeId<"field">;
type PropertyId = SafeId<"property">;

type CarryContext = {
  /** Computed columns that read the replaced file, directly or not. */
  affectedPropertyIds: ReadonlySet<PropertyId>;
  sourceVersionId: SafeId<"entityVersion">;
  now: string;
};

/**
 * The settlement a cloned cell keeps. An affected cell's outcome came from
 * the old file, so it is marked stale, keeping the version it was first
 * settled on when it was already stale.
 */
export const carriedSettlement = ({
  settlement,
  propertyId,
  context,
}: {
  settlement: AiCellSettlement | null;
  propertyId: PropertyId;
  context: CarryContext;
}): AiCellSettlement | null => {
  if (settlement === null || !context.affectedPropertyIds.has(propertyId)) {
    return settlement;
  }
  return {
    ...settlement,
    stale: settlement.stale ?? {
      reason: "input-changed",
      since: context.now,
      settledOnEntityVersionId: context.sourceVersionId,
    },
  };
};

type SourceJustification = {
  fieldId: FieldId;
  content: JustificationContent;
  boundingBoxes: BoundingBoxes | null;
  fileFieldIds: FieldId[];
};

type CarriedJustification = {
  fieldId: FieldId;
  content: JustificationContent;
  boundingBoxes: BoundingBoxes | null;
  fileFieldIds: FieldId[];
};

/**
 * Citations move with their cell. A citation of the replaced file keeps
 * pointing at the old file field, which stays on the old version: the cited
 * page is that file's page, not the new one's. Citations of other files of
 * the row follow those files' cloned fields.
 */
export const carriedJustifications = ({
  justifications,
  revisionFieldIdBySourceId,
  replacedFileFieldIds,
}: {
  justifications: readonly SourceJustification[];
  revisionFieldIdBySourceId: ReadonlyMap<FieldId, FieldId>;
  replacedFileFieldIds: ReadonlySet<FieldId>;
}): CarriedJustification[] =>
  justifications.flatMap((justification) => {
    const fieldId = revisionFieldIdBySourceId.get(justification.fieldId);
    if (fieldId === undefined) {
      return [];
    }
    return [
      {
        fieldId,
        content: justification.content,
        boundingBoxes: justification.boundingBoxes,
        fileFieldIds: justification.fileFieldIds.map((fileFieldId) =>
          replacedFileFieldIds.has(fileFieldId)
            ? fileFieldId
            : (revisionFieldIdBySourceId.get(fileFieldId) ?? fileFieldId),
        ),
      },
    ];
  });

/**
 * A cell a person owns (locked by a manual edit or a review) is never re-run,
 * so a change to its inputs asks for review instead of touching the value.
 */
export const carriedCellMetadata = ({
  metadata,
  propertyId,
  context,
  userId,
}: {
  metadata: CellMetadata;
  propertyId: PropertyId;
  context: CarryContext;
  userId: SafeId<"user">;
}): CellMetadata => {
  if (
    metadata.locked !== true ||
    !context.affectedPropertyIds.has(propertyId) ||
    metadata.manualFlags.includes(REVIEW_FLAG.NEEDS_REVIEW)
  ) {
    return metadata;
  }
  return {
    ...metadata,
    manualFlags: [...metadata.manualFlags, REVIEW_FLAG.NEEDS_REVIEW],
    flagProvenance: {
      ...metadata.flagProvenance,
      [REVIEW_FLAG.NEEDS_REVIEW]: { addedBy: userId, addedAt: context.now },
    },
  };
};
