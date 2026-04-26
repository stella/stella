import type { FieldContent } from "@/api/db/schema-validators";
import type { SafeId } from "@/api/lib/branded-types";
import {
  generateVerificationCode,
  toDocumentReference,
} from "@/api/lib/document-reference";

type RevisionField = {
  content: FieldContent;
  propertyId: SafeId<"property">;
};

type RevisionFileContent = Extract<FieldContent, { type: "file" }>;

type CloneRevisionFieldsInput = {
  currentFields: RevisionField[];
  entityVersionId: SafeId<"entityVersion">;
  propertyId: SafeId<"property">;
  replacementContent: RevisionFileContent;
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
  propertyId,
  replacementContent,
  workspaceId,
}: CloneRevisionFieldsInput) =>
  currentFields.map((field) => ({
    content:
      field.propertyId === propertyId && field.content.type === "file"
        ? replacementContent
        : field.content,
    entityVersionId,
    propertyId: field.propertyId,
    workspaceId,
  }));
