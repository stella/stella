import { and, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { ActionContextOf, ActorContextOf } from "rivetkit";

import { db } from "@/api/db";
import { fields } from "@/api/db/schema";
import type {
  FieldContent,
  PropertyCondition,
} from "@/api/db/schema-validators";
import type { workflowActor } from "@/api/handlers/registry/actors/workflow/actor";
import type { PropertyBatch } from "@/api/handlers/registry/actors/workflow/get-execution-plan";
import {
  defaultWorkflowState,
  type WorkflowActionSchemas,
} from "@/api/handlers/registry/actors/workflow/schema";
import { broadcastEvent, resetActorState } from "@/api/handlers/registry/utils";
import {
  captureActorError,
  type CaptureActorErrorProps,
} from "@/api/lib/errors/actions";

export const prepareBatch = (
  rawBatch: PropertyBatch,
  fieldContentMap: Map<string, FieldContent["type"]>,
): PropertyBatch => {
  const propertiesToProcess = rawBatch.properties.filter((prop) => {
    const fieldContentType = fieldContentMap.get(prop.id);

    return (
      prop.status !== "fresh" ||
      !fieldContentType ||
      fieldContentType === "error" ||
      fieldContentType === "pending" ||
      fieldContentType === "unsupported"
    );
  });

  return {
    ...rawBatch,
    properties: propertiesToProcess,
  };
};

export const runWorkflowAction = <T extends keyof WorkflowActionSchemas>(
  c: ActorContextOf<typeof workflowActor>,
  action: T,
  input: WorkflowActionSchemas[T],
) => c.schedule.after(0, action, input);

type SetFieldsContentProps = {
  entityId: string;
  entityVersionId: string;
  batch: PropertyBatch;
  contentType: "pending" | "error" | "unsupported";
};

export const setFieldsContent = async (
  c: ActionContextOf<typeof workflowActor>,
  { entityId, entityVersionId, batch, contentType }: SetFieldsContentProps,
) => {
  const propertyIds = batch.properties.map((p) => p.id);

  const updatedFields = await db.transaction(async (tx) => {
    await tx
      .delete(fields)
      .where(
        and(
          eq(fields.entityVersionId, entityVersionId),
          inArray(fields.propertyId, propertyIds),
        ),
      );

    const fieldValues = propertyIds.map((propertyId) => ({
      id: nanoid(),
      propertyId,
      entityVersionId,
      content: {
        type: contentType,
        version: 1 as const,
      },
    }));

    if (fieldValues.length > 0) {
      await tx.insert(fields).values(fieldValues);
    }

    return fieldValues;
  });

  broadcastEvent(c, {
    name: "field-content",
    data: updatedFields.map((f) => ({
      id: f.id,
      propertyId: f.propertyId,
      entityId,
      content: f.content,
    })),
  });
};

export const handleUnrecoverableError = (props: CaptureActorErrorProps) => {
  captureActorError(props);
  resetActorState(props.c, defaultWorkflowState());
  broadcastEvent(props.c, {
    name: "panic",
  });
};

export const evaluateCondition = (
  fieldContent: FieldContent,
  condition: PropertyCondition,
): boolean => {
  if (
    fieldContent.type === "error" ||
    fieldContent.type === "pending" ||
    fieldContent.type === "unsupported" ||
    fieldContent.type === "file"
  ) {
    return false;
  }

  switch (condition.type) {
    case "string": {
      if (typeof fieldContent.value !== "string") {
        return false;
      }

      return evaluateStringCondition(condition, fieldContent.value);
    }
    case "string-array": {
      if (!Array.isArray(fieldContent.value)) {
        return false;
      }

      return evaluateStringArrayCondition(condition, fieldContent.value);
    }
    default:
      return false;
  }
};

type StringCondition = Extract<PropertyCondition, { type: "string" }>;

const evaluateStringCondition = (
  condition: StringCondition,
  fieldValue: string,
) => {
  switch (condition.operator) {
    case "eq":
      return fieldValue === condition.value;
    default:
      return false;
  }
};

type StringArrayCondition = Extract<
  PropertyCondition,
  { type: "string-array" }
>;

const evaluateStringArrayCondition = (
  condition: StringArrayCondition,
  fieldValue: string[],
) => {
  switch (condition.operator) {
    case "contains-every":
      return condition.value.every((v) => fieldValue.includes(v));
    default:
      return false;
  }
};
