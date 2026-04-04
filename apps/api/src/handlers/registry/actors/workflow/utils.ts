import { and, eq, inArray } from "drizzle-orm";
import type { ActionContextOf, ActorContextOf } from "rivetkit";

import type { ScopedDb } from "@/api/db";
import { fields } from "@/api/db/schema";
import type {
  FieldContent,
  PropertyCondition,
} from "@/api/db/schema-validators";
import type { workflowActor } from "@/api/handlers/registry/actors/workflow/actor";
import type { PropertyBatch } from "@/api/handlers/registry/actors/workflow/get-execution-plan";
import { defaultWorkflowState } from "@/api/handlers/registry/actors/workflow/schema";
import type { WorkflowActionSchemas } from "@/api/handlers/registry/actors/workflow/schema";
import {
  broadcastEvent,
  resetActorState,
} from "@/api/handlers/registry/runtime-utils";
import type { SafeId } from "@/api/lib/branded-types";
import { captureActorError } from "@/api/lib/errors/actions";
import type { CaptureActorErrorProps } from "@/api/lib/errors/actions";

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

export async function runWorkflowAction<T extends keyof WorkflowActionSchemas>(
  c: ActorContextOf<typeof workflowActor>,
  action: T,
  // eslint-disable-next-line typescript/no-invalid-void-type -- void is the correct valibot void_ output type here
  ...args: WorkflowActionSchemas[T] extends void
    ? []
    : [input: WorkflowActionSchemas[T]]
): ReturnType<typeof c.schedule.after> {
  if (args.length === 0) {
    await c.schedule.after(0, action);
    return;
  }

  const [input] = args;
  await c.schedule.after(0, action, input);
  return;
}

type SetFieldsContentProps = {
  workspaceId: SafeId<"workspace">;
  entityId: string;
  entityVersionId: string;
  batch: PropertyBatch;
  contentType: "pending" | "error" | "unsupported";
};

export const setFieldsContent = async (
  c: ActionContextOf<typeof workflowActor>,
  {
    workspaceId,
    entityId,
    entityVersionId,
    batch,
    contentType,
  }: SetFieldsContentProps,
  scopedDb: ScopedDb,
) => {
  const propertyIds = batch.properties.map((p) => p.id);

  const updatedFields = await scopedDb(async (tx) => {
    await tx
      .delete(fields)
      .where(
        and(
          eq(fields.entityVersionId, entityVersionId),
          inArray(fields.propertyId, propertyIds),
        ),
      );

    const fieldValues = propertyIds.map((propertyId) => ({
      id: crypto.randomUUID(),
      workspaceId,
      propertyId,
      entityVersionId,
      content: { type: contentType, version: 1 as const },
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
    fieldContent.type === "file" ||
    fieldContent.type === "clip"
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
