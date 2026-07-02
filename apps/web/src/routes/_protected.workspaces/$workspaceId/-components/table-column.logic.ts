import type {
  EntityId,
  FieldId,
  PropertyId,
  WorkspaceEntity,
  WorkspaceField,
  WorkspaceProperty,
} from "@/lib/types";

export type AIExtractionProperty = WorkspaceProperty & {
  content: Exclude<WorkspaceProperty["content"], { type: "file" }>;
  tool: Extract<WorkspaceProperty["tool"], { type: "ai-model" }>;
};

type FileFieldContent = Extract<WorkspaceField["content"], { type: "file" }>;

export type AIExtractionTarget = {
  type: "ai-extraction";
  entityId: EntityId;
  fieldId: FieldId;
  property: AIExtractionProperty;
};

export type SourceFileTarget = {
  type: "source-file";
  fieldId: FieldId;
  propertyId: PropertyId;
  label: string;
  fileName: string;
  mimeType: string;
  pdfFileId: string | null;
};

export type AICellTargets = {
  extraction: AIExtractionTarget;
  sourceFile: SourceFileTarget;
};

export const isAIExtractionProperty = (
  property: WorkspaceProperty,
): property is AIExtractionProperty =>
  property.tool.type === "ai-model" && property.content.type !== "file";

type ResolveAiCellTargetsOptions = {
  entity: WorkspaceEntity;
  extractionField: WorkspaceField;
  extractionProperty: AIExtractionProperty;
  justificationFileFieldId: FieldId | undefined;
};

export const resolveAiCellTargets = ({
  entity,
  extractionField,
  extractionProperty,
  justificationFileFieldId,
}: ResolveAiCellTargetsOptions): AICellTargets | undefined => {
  const referencedFileTarget = justificationFileFieldId
    ? findFileTargetByFieldId(entity, justificationFileFieldId)
    : undefined;
  const sourceFileTarget = referencedFileTarget ?? findFirstFileTarget(entity);

  if (!sourceFileTarget) {
    return undefined;
  }

  const fileName = sourceFileTarget.content.fileName || entity.name || "";

  return {
    extraction: {
      type: "ai-extraction",
      entityId: entity.entityId,
      fieldId: extractionField.id,
      property: extractionProperty,
    },
    sourceFile: {
      type: "source-file",
      fieldId: sourceFileTarget.fieldId,
      propertyId: sourceFileTarget.propertyId,
      label: fileName,
      fileName,
      mimeType: sourceFileTarget.content.mimeType,
      pdfFileId: sourceFileTarget.content.pdfFileId,
    },
  };
};

type FileTarget = {
  propertyId: PropertyId;
  fieldId: FieldId;
  content: FileFieldContent;
};

const findFileTargetByFieldId = (
  entity: WorkspaceEntity,
  fieldId: FieldId,
): FileTarget | undefined => {
  for (const field of Object.values(entity.fields)) {
    if (!field) {
      continue;
    }

    if (field.id !== fieldId || field.content.type !== "file") {
      continue;
    }

    return {
      propertyId: field.propertyId,
      fieldId: field.id,
      content: field.content,
    };
  }

  return undefined;
};

const findFirstFileTarget = (
  entity: WorkspaceEntity,
): FileTarget | undefined => {
  for (const field of Object.values(entity.fields)) {
    if (!field) {
      continue;
    }

    if (field.content.type !== "file") {
      continue;
    }

    return {
      propertyId: field.propertyId,
      fieldId: field.id,
      content: field.content,
    };
  }

  return undefined;
};
