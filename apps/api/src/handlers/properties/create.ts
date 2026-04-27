import { Result } from "better-result";
import { eq } from "drizzle-orm";
import { t } from "elysia";

import { properties } from "@/api/db/schema";
import { propertyContentTypeSchema } from "@/api/db/schema-validators";
import type { PropertyContent, PropertyTool } from "@/api/db/schema-validators";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createAuditContext,
  writeAuditLog,
} from "@/api/lib/audit-log";
import { tDefaultVarchar } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

const createPropertyBodySchema = t.Object({
  name: tDefaultVarchar,
  contentType: propertyContentTypeSchema,
});

const config = {
  permissions: { property: ["create"] },
  body: createPropertyBodySchema,
} satisfies HandlerConfig;

const createProperty = createSafeHandler(
  config,
  async function* ({ safeDb, session, workspaceId, user, request, body }) {
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
      return Result.err(
        new HandlerError({ status: 422, message: "Unsupported content type" }),
      );
    }

    const txResult = yield* Result.await(
      safeDb(async (tx) => {
        // Lock rows then count to serialize concurrent adds.
        // PG rejects FOR UPDATE with aggregate functions.
        const lockedRows = await tx
          .select({ id: properties.id })
          .from(properties)
          .where(eq(properties.workspaceId, workspaceId))
          .for("update");

        if (lockedRows.length >= LIMITS.propertiesCount) {
          return {
            ok: false as const,
            status: 400 as const,
            message: "Properties limit reached",
          };
        }

        const [inserted] = await tx
          .insert(properties)
          .values({
            workspaceId,
            name: body.name,
            content,
            tool,
          })
          .returning({ id: properties.id });

        if (!inserted) {
          return {
            ok: false as const,
            status: 500 as const,
            message: "Failed to create property",
          };
        }

        await writeAuditLog(
          {
            ...createAuditContext({
              organizationId: session.activeOrganizationId,
              workspaceId,
              userId: user.id,
              request,
            }),
            action: AUDIT_ACTION.CREATE,
            resourceType: AUDIT_RESOURCE_TYPE.PROPERTY,
            resourceId: inserted.id,
            changes: {
              created: {
                old: null,
                new: {
                  name: body.name,
                  contentType: content.type,
                  toolType: tool.type,
                },
              },
            },
          },
          tx,
        );

        return { ok: true as const, id: inserted.id };
      }),
    );

    if (!txResult.ok) {
      return Result.err(
        new HandlerError({
          status: txResult.status,
          message: txResult.message,
        }),
      );
    }

    return Result.ok({ id: txResult.id });
  },
);

export default createProperty;
