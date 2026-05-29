import { Value } from "@sinclair/typebox/value";
import { t } from "elysia";

import {
  propertyConditionSchema,
  propertyContentSchema,
  propertyContentTypeSchema,
} from "@/api/db/schema-validators";
import type { PropertyContent, PropertyTool } from "@/api/db/schema-validators";
import { tDefaultVarchar, tSafeId } from "@/api/lib/custom-schema";
import { serializeAITool } from "@/api/lib/markdown/ai-tool";

type SelectOption = {
  color: string;
  value: string;
};

const selectOptionSchema = t.Object({
  color: t.String({ minLength: 1, maxLength: 64 }),
  value: t.String({ minLength: 1, maxLength: 1000 }),
});

export const createPropertyBodySchema = t.Object({
  name: tDefaultVarchar,
  contentType: propertyContentTypeSchema,
  toolType: t.Optional(
    t.Union([t.Literal("ai-model"), t.Literal("manual-input")]),
  ),
  prompt: t.Optional(t.String({ maxLength: 1000 })),
  dependencies: t.Optional(
    t.Array(
      t.Object({
        dependsOnPropertyId: tSafeId("property"),
        condition: t.Nullable(propertyConditionSchema),
      }),
    ),
  ),
  options: t.Optional(t.Array(selectOptionSchema)),
  fallback: t.Optional(t.Nullable(t.String({ minLength: 1, maxLength: 1000 }))),
});

export type CreatePropertyBody = typeof createPropertyBodySchema.static;

export const areSelectOptionsValid = (
  rawOptions: SelectOption[],
  contentType: "single-select" | "multi-select",
): boolean =>
  Value.Check(propertyContentSchema, {
    version: 1,
    type: contentType,
    options: rawOptions,
    fallback: null,
  });

export const createDefaultTool = ({
  dependencies,
  prompt,
  toolType,
}: {
  dependencies: CreatePropertyBody["dependencies"];
  prompt: string | undefined;
  toolType: "ai-model" | "manual-input" | undefined;
}): PropertyTool => {
  if (toolType === "manual-input") {
    return { version: 1, type: "manual-input" };
  }

  const serialized = serializeAITool({
    version: 1,
    type: "ai-model",
    prompt: prompt?.trim() ?? "",
    dependencies: dependencies ?? [],
  });

  return {
    version: 1,
    type: "ai-model",
    prompt: serialized.prompt,
  };
};

export type BuiltPropertyParts = {
  content: PropertyContent;
  tool: PropertyTool;
  dependencies: NonNullable<CreatePropertyBody["dependencies"]>;
};

export type BuildValidationError = {
  status: 400 | 422;
  message: string;
};

export const buildPropertyParts = (
  body: CreatePropertyBody,
): BuiltPropertyParts | BuildValidationError => {
  const defaultTool = () =>
    createDefaultTool({
      dependencies: body.dependencies,
      prompt: body.prompt,
      toolType: body.toolType,
    });

  let content: PropertyContent;
  let tool: PropertyTool;

  switch (body.contentType) {
    case "file":
      content = { version: 1, type: "file" };
      tool = { version: 1, type: "manual-input" };
      break;
    case "text":
      content = { version: 1, type: "text" };
      tool = defaultTool();
      break;
    case "single-select":
    case "multi-select": {
      const rawOptions = body.options ?? [];
      if (!areSelectOptionsValid(rawOptions, body.contentType)) {
        return { status: 400, message: "Invalid select options" };
      }
      const fallback = body.fallback ?? null;
      if (fallback !== null && !rawOptions.some((o) => o.value === fallback)) {
        return {
          status: 400,
          message: "Fallback must match one of the supplied options",
        };
      }
      content = {
        version: 1,
        type: body.contentType,
        options: rawOptions,
        fallback,
      };
      tool = defaultTool();
      break;
    }
    case "date":
    case "int":
      content = { version: 1, type: body.contentType };
      tool = defaultTool();
      break;
    default:
      return { status: 422, message: "Unsupported content type" };
  }

  return {
    content,
    tool,
    dependencies: tool.type === "ai-model" ? (body.dependencies ?? []) : [],
  };
};
