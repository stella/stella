import { eq } from "drizzle-orm";
import { status, t, type Static } from "elysia";

import { db } from "@/api/db";
import { properties } from "@/api/db/schema";
import {
  propertyContentTypeSchema,
  type PropertyContent,
  type PropertyTool,
} from "@/api/db/schema-validators";
import type { SafeId } from "@/api/lib/branded-types";
import { tDefaultVarchar } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";

export const createPropertyBodySchema = t.Object({
  name: tDefaultVarchar,
  contentType: propertyContentTypeSchema,
});

type CreatePropertyBodySchema = Static<typeof createPropertyBodySchema>;

type CreatePropertyHandlerProps = {
  workspaceId: SafeId<"workspace">;
  body: CreatePropertyBodySchema;
};

export const createPropertyHandler = async ({
  workspaceId,
  body,
}: CreatePropertyHandlerProps) => {
  const totalProperties = await db.$count(
    properties,
    eq(properties.workspaceId, workspaceId),
  );

  if (totalProperties >= LIMITS.propertiesCount) {
    return status(400, {
      message: "Properties limit reached",
    });
  }

  let content: PropertyContent | null = null;
  let tool: PropertyTool | null = null;

  switch (body.contentType) {
    case "file":
      content = { version: 1, type: "file" };
      tool = { version: 1, type: "manual-input" };
      break;
    case "text":
      content = { version: 1, type: "text" };
      tool = { version: 1, type: "ai-model", prompt: "" };
      break;
    case "single-select":
    case "multi-select":
      content = {
        version: 1,
        type: body.contentType,
        options: [],
        fallback: null,
      };
      tool = { version: 1, type: "ai-model", prompt: "" };
      break;
    case "date":
    case "int":
      content = { version: 1, type: body.contentType };
      tool = { version: 1, type: "ai-model", prompt: "" };
      break;
    default:
      content = null;
  }

  if (!content || !tool) {
    return status(422);
  }

  await db.insert(properties).values({
    workspaceId,
    name: body.name,
    content,
    tool,
  });

  return;
};
