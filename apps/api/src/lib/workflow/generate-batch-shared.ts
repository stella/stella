import { Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";

import type { ScopedDb } from "@/api/db";
import { fields } from "@/api/db/schema";
import type { JustificationContent } from "@/api/db/schema";
import type { FieldContent } from "@/api/db/schema-validators";
import type { OrgAIConfig } from "@/api/lib/ai-models";
import type { SafeId } from "@/api/lib/branded-types";
import {
  Unreachable,
  WorkflowValidationError,
} from "@/api/lib/errors/tagged-errors";
import type { WorkflowIntegrationError } from "@/api/lib/errors/tagged-errors";
import type {
  BatchProperty,
  PropertyBatch,
} from "@/api/lib/workflow/get-execution-plan";
import type { PartialAnswerUpdate } from "@/api/lib/workflow/streaming-answer";
import { evaluateCondition } from "@/api/lib/workflow/utils";

// Types shared between mock and real AI implementations
export type FieldContentForAI = Exclude<
  FieldContent,
  | { type: "error" }
  | { type: "pending" }
  | { type: "unsupported" }
  | { type: "clip" }
>;

export type AIResult = {
  fieldId: SafeId<"field">;
  propertyId: SafeId<"property">;
  content: Exclude<FieldContentForAI, { type: "file" }>;
};

export type AIJustification = {
  fieldId: SafeId<"field">;
  justificationId: SafeId<"justification">;
  content: JustificationContent;
  fileFieldIds: SafeId<"field">[];
};

export type GenerateBatchProps = {
  abortSignal: AbortSignal;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  scopedDb: ScopedDb;
  batch: PropertyBatch;
  entityVersionId: SafeId<"entityVersion">;
  orgAIConfig?: OrgAIConfig | null;
  onPartialAnswer?:
    | ((update: PartialAnswerUpdate) => Promise<void> | void)
    | undefined;
};

export type GenerateBatchResult = Result<
  {
    aiResults: AIResult[];
    aiJustifications: AIJustification[];
    skippedPropertyIds: SafeId<"property">[];
    unsupportedPropertyIds: SafeId<"property">[];
  },
  WorkflowValidationError | WorkflowIntegrationError
>;

const isFieldContentEmpty = (content: FieldContentForAI): boolean => {
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
  propertyId: SafeId<"property">;
  value: string;
};

type PreparedBatchInput = {
  inputProperties: BatchProperty[];
  inputFieldsForAI: FieldContentForAI[];
  resolvedFiles: ResolvedFile[];
  textInputs: TextInput[];
  skippedPropertyIds: SafeId<"property">[];
};

type PrepareBatchInputResult = Result<
  PreparedBatchInput,
  WorkflowValidationError
>;

type InputFieldRow = {
  id: SafeId<"field">;
  propertyId: SafeId<"property">;
  content: FieldContent;
};

type FetchInputFieldsForBatchProps = {
  entityVersionId: SafeId<"entityVersion">;
  inputPropertyIds: SafeId<"property">[];
  scopedDb: ScopedDb;
};

export const fetchInputFieldsForBatch = async ({
  entityVersionId,
  inputPropertyIds,
  scopedDb,
}: FetchInputFieldsForBatchProps): Promise<InputFieldRow[]> => {
  if (inputPropertyIds.length === 0) {
    return [];
  }

  return await scopedDb((tx) =>
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
  fileFieldId: SafeId<"field">;
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
  const skippedPropertyIds: SafeId<"property">[] = [];

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
  const pushTextInput = (propertyId: SafeId<"property">, value: string) => {
    textInputs.push({
      propertyId,
      value,
    });
  };

  for (const field of inputFields) {
    const content = field.content;

    if (
      content.type === "error" ||
      content.type === "pending" ||
      content.type === "unsupported" ||
      content.type === "clip" ||
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
      pushTextInput(field.propertyId, content.value);
    } else if (content.type === "single-select" && content.value !== null) {
      pushTextInput(field.propertyId, content.value);
    } else if (content.type === "multi-select") {
      pushTextInput(field.propertyId, content.value.join(", "));
    } else if (content.type === "date" && content.value) {
      pushTextInput(field.propertyId, content.value);
    } else if (content.type === "int") {
      pushTextInput(
        field.propertyId,
        content.currency
          ? `${content.value} ${content.currency}`
          : String(content.value),
      );
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
