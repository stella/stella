import { and, eq, max } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { entityVersions } from "@/api/db/schema";
import type { FieldContent } from "@/api/db/schema-validators";
import {
  reuseFileObjectWithinEntity,
  type WritableFileFieldContent,
} from "@/api/handlers/files/file-object-ids";
import type { SafeId } from "@/api/lib/branded-types";
import {
  generateVerificationCode,
  toDocumentReference,
} from "@/api/lib/document-reference";

type RevisionField = {
  content: FieldContent;
  propertyId: SafeId<"property">;
};

type CloneRevisionFieldsInput = {
  currentFields: RevisionField[];
  entityVersionId: SafeId<"entityVersion">;
  replacementFieldId?: SafeId<"field">;
  propertyId: SafeId<"property">;
  replacementContent: WritableFileFieldContent;
  workspaceId: SafeId<"workspace">;
};

type BuildVersionStampInput = {
  docSequence: number | null;
  versionNumber: number;
  workspaceReference: string | null;
};

/**
 * Allocate the next version number for an entity.
 *
 * Class guard for "allocator derived from a pointer that can move backwards":
 * deriving the next number from the current or base version's number plus one
 * is unsafe because tombstoning the latest version vN promotes
 * `currentVersionId` back to v(N-1), so the next writer would allocate vN again
 * and collide with the tombstoned row (there is no unique index on
 * (entityId, versionNumber), so the collision is a silent duplicate number
 * rather than an error).
 *
 * Derive instead from MAX(versionNumber) over ALL of the entity's versions,
 * INCLUDING tombstoned ones, computed in the writer's own transaction. Callers
 * MUST already hold the entity row FOR UPDATE (or an equivalent per-entity
 * lock) so concurrent writers serialize and cannot race to the same number.
 */
export const nextEntityVersionNumber = async (
  tx: Transaction,
  {
    entityId,
    workspaceId,
  }: {
    entityId: SafeId<"entity">;
    workspaceId: SafeId<"workspace">;
  },
): Promise<number> => {
  const rows = await tx
    .select({ max: max(entityVersions.versionNumber) })
    .from(entityVersions)
    .where(
      and(
        eq(entityVersions.entityId, entityId),
        eq(entityVersions.workspaceId, workspaceId),
      ),
    );
  return (rows.at(0)?.max ?? 0) + 1;
};

export const buildVersionStamp = ({
  docSequence,
  versionNumber,
  workspaceReference,
}: BuildVersionStampInput) => {
  if (docSequence === null || workspaceReference === null) {
    return {
      stamp: null,
      verificationCode: null,
    };
  }

  return {
    stamp: toDocumentReference({
      matterReference: workspaceReference,
      docSequence,
      versionNumber,
    }),
    verificationCode: generateVerificationCode(),
  };
};

export const cloneFieldsForRevision = ({
  currentFields,
  entityVersionId,
  replacementFieldId,
  propertyId,
  replacementContent,
  workspaceId,
}: CloneRevisionFieldsInput) =>
  currentFields.map((field) => ({
    ...(replacementFieldId &&
      field.propertyId === propertyId &&
      field.content.type === "file" && { id: replacementFieldId }),
    content: contentForRevisionField({
      field,
      propertyId,
      replacementContent,
    }),
    entityVersionId,
    propertyId: field.propertyId,
    workspaceId,
  }));

type ContentForRevisionFieldOptions = {
  field: RevisionField;
  propertyId: SafeId<"property">;
  replacementContent: WritableFileFieldContent;
};

const contentForRevisionField = ({
  field,
  propertyId,
  replacementContent,
}: ContentForRevisionFieldOptions): FieldContent => {
  if (field.propertyId === propertyId && field.content.type === "file") {
    return replacementContent;
  }

  if (field.content.type === "file") {
    return reuseFileObjectWithinEntity(field.content);
  }

  return field.content;
};
