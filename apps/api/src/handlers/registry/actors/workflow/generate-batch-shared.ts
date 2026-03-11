import { Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";

import type { ScopedDb } from "@/api/db";
import { fields } from "@/api/db/schema";
import type { FieldContent } from "@/api/db/schema-validators";
import type {
  BatchProperty,
  PropertyBatch,
} from "@/api/handlers/registry/actors/workflow/get-execution-plan";
import { evaluateCondition } from "@/api/handlers/registry/actors/workflow/utils";
import type { SafeId } from "@/api/lib/branded-types";
import {
  Unreachable,
  WorkflowValidationError,
} from "@/api/lib/errors/tagged-errors";
import type { WorkflowIntegrationError } from "@/api/lib/errors/tagged-errors";

// Types shared between mock and real AI implementations
export type FieldContentForAI = Exclude<
  FieldContent,
  { type: "error" } | { type: "pending" } | { type: "unsupported" }
>;

export type AIResult = {
  fieldId: string;
  propertyId: string;
  content: Exclude<FieldContentForAI, { type: "file" }>;
};

export type AIJustification = {
  fieldId: string;
  justificationId: string;
  htmlVersion: number;
  htmlContent: string;
  fileFieldIds: string[];
};

export type GenerateBatchProps = {
  abortSignal: AbortSignal;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  scopedDb: ScopedDb;
  batch: PropertyBatch;
  entityVersionId: string;
};

export type GenerateBatchResult = Result<
  {
    aiResults: AIResult[];
    aiJustifications: AIJustification[];
    skippedPropertyIds: string[];
    unsupportedPropertyIds: string[];
  },
  WorkflowValidationError | WorkflowIntegrationError
>;

export const isFieldContentEmpty = (content: FieldContentForAI): boolean => {
  switch (content.type) {
    case "text":
      return content.value.trim().length === 0;
    case "single-select":
      return content.value === null || content.value.trim().length === 0;
    case "multi-select":
      return content.value.length === 0;
    case "file":
      return false;
    case "date":
      return content.value === null || content.value.trim().length === 0;
    case "int":
      return false;
    default:
      throw new Unreachable({
        message: "Field type not matched",
      });
  }
};

export type TextInput = {
  propertyId: string;
  value: string;
};

export type PreparedBatchInput = {
  inputProperties: BatchProperty[];
  inputFieldsForAI: FieldContentForAI[];
  resolvedFiles: ResolvedFile[];
  textInputs: TextInput[];
  skippedPropertyIds: string[];
};

export type PrepareBatchInputResult = Result<
  PreparedBatchInput,
  WorkflowValidationError
>;

type InputFieldRow = {
  id: string;
  propertyId: string;
  content: FieldContent;
};

type FetchInputFieldsForBatchProps = {
  entityVersionId: string;
  inputPropertyIds: string[];
  scopedDb: ScopedDb;
};

export const fetchInputFieldsForBatch = ({
  entityVersionId,
  inputPropertyIds,
  scopedDb,
}: FetchInputFieldsForBatchProps): Promise<InputFieldRow[]> => {
  if (inputPropertyIds.length === 0) {
    return Promise.resolve([]);
  }

  return scopedDb((tx) =>
    tx
      .select({
        id: fields.id,
        propertyId: fields.propertyId,
        content: fields.content,
      })
      .from(fields)
      .where(
        and(
          eq(fields.entityVersionId, entityVersionId),
          inArray(fields.propertyId, inputPropertyIds),
        ),
      ),
  );
};

export type ResolvedFile = {
  fileFieldId: string;
  fileId: string;
  mimeType: string;
  sha256Hex: string;
  encrypted: boolean;
  pdfFileId: string | null;
};

export const prepareBatchInput = (
  inputFields: InputFieldRow[],
  batch: PropertyBatch,
): PrepareBatchInputResult => {
  const skippedPropertyIds: string[] = [];

  // Filter properties based on dependency conditions
  const inputProperties = batch.properties.filter((property) => {
    const conditionsMet = property.dependencies.every((dep) => {
      if (!dep.condition) {
        return true;
      }
      const depFieldContent = inputFields.find(
        (field) => field.propertyId === dep.dependsOnPropertyId,
      )?.content;
      if (!depFieldContent) {
        return false;
      }
      return evaluateCondition(depFieldContent, dep.condition);
    });

    if (!conditionsMet) {
      skippedPropertyIds.push(property.id);
      return false;
    }

    return true;
  });

  // Filter out empty/error/pending input fields and collect
  // text inputs
  const inputFieldsForAI: FieldContentForAI[] = [];
  const resolvedFiles: ResolvedFile[] = [];
  const textInputs: TextInput[] = [];

  for (const field of inputFields) {
    const content = field.content;

    if (
      content.type === "error" ||
      content.type === "pending" ||
      content.type === "unsupported" ||
      isFieldContentEmpty(content)
    ) {
      skippedPropertyIds.push(field.propertyId);
      continue;
    }

    inputFieldsForAI.push(content);

    if (content.type === "file") {
      resolvedFiles.push({
        fileFieldId: field.id,
        fileId: content.id,
        mimeType: content.mimeType,
        sha256Hex: content.sha256Hex,
        encrypted: content.encrypted,
        pdfFileId: content.pdfFileId,
      });
    }

    if (content.type === "text") {
      textInputs.push({
        propertyId: field.propertyId,
        value: content.value,
      });
    } else if (content.type === "single-select" && content.value !== null) {
      textInputs.push({
        propertyId: field.propertyId,
        value: content.value,
      });
    } else if (content.type === "multi-select") {
      textInputs.push({
        propertyId: field.propertyId,
        value: content.value.join(", "),
      });
    } else if (content.type === "date" && content.value) {
      textInputs.push({
        propertyId: field.propertyId,
        value: content.value,
      });
    } else if (content.type === "int") {
      textInputs.push({
        propertyId: field.propertyId,
        value: content.currency
          ? `${content.value} ${content.currency}`
          : String(content.value),
      });
    }
  }

  if (inputFieldsForAI.length === 0) {
    return Result.err(
      new WorkflowValidationError({
        message: "No valid input fields",
      }),
    );
  }

  return Result.ok({
    inputProperties,
    inputFieldsForAI,
    resolvedFiles,
    textInputs,
    skippedPropertyIds,
  });
};
