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
    stamp: toDocumentReference(workspaceReference, docSequence, versionNumber),
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
