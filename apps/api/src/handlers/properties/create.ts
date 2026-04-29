import { Value } from "@sinclair/typebox/value";
import { Result } from "better-result";
import { eq } from "drizzle-orm";
import { t } from "elysia";

import { properties, propertyDependencies } from "@/api/db/schema";
import {
  propertyContentSchema,
  propertyContentTypeSchema,
  propertyConditionSchema,
} from "@/api/db/schema-validators";
import type { PropertyContent, PropertyTool } from "@/api/db/schema-validators";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createAuditContext,
  writeAuditLog,
} from "@/api/lib/audit-log";
import { tDefaultVarchar, tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { serializeAITool } from "@/api/lib/markdown/ai-tool";

type SelectOption = {
  color: string;
  value: string;
};

const selectOptionSchema = t.Object({
  color: t.String({ minLength: 1, maxLength: 64 }),
  value: t.String({ minLength: 1, maxLength: 1000 }),
});

const createPropertyBodySchema = t.Object({
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
});

// Re-validate options through the strict content schema before insert.
const areSelectOptionsValid = (
  rawOptions: SelectOption[],
  contentType: "single-select" | "multi-select",
): boolean =>
  Value.Check(propertyContentSchema, {
    version: 1,
    type: contentType,
    options: rawOptions,
    fallback: null,
  });

const config = {
  permissions: { property: ["create"] },
  body: createPropertyBodySchema,
} satisfies HandlerConfig;

const createDefaultTool = ({
  dependencies,
  prompt,
  toolType,
}: {
  dependencies: (typeof createPropertyBodySchema.static)["dependencies"];
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

const createProperty = createSafeHandler(
  config,
  async function* ({ safeDb, session, workspaceId, user, request, body }) {
    let content: PropertyContent | null = null;
    let tool: PropertyTool | null = null;
    const defaultTool = () =>
      createDefaultTool({
        dependencies: body.dependencies,
        prompt: body.prompt,
        toolType: body.toolType,
      });

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
          return Result.err(
            new HandlerError({
              status: 400,
              message: "Invalid select options",
            }),
          );
        }
        content = {
          version: 1,
          type: body.contentType,
          options: rawOptions,
          fallback: null,
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
        content = null;
    }

    if (!content || !tool) {
      return Result.err(
        new HandlerError({ status: 422, message: "Unsupported content type" }),
      );
    }

    const dependencies =
      tool.type === "ai-model" ? (body.dependencies ?? []) : [];

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

        if (dependencies.length > 0) {
          const dependencyIds = [
            ...new Set(
              dependencies.map(
                ({ dependsOnPropertyId }) => dependsOnPropertyId,
              ),
            ),
          ];
          const dependencyRows = await tx.query.properties.findMany({
            where: {
              id: { in: dependencyIds },
              workspaceId: { eq: workspaceId },
            },
            columns: { id: true },
          });

          if (dependencyRows.length !== dependencyIds.length) {
            return {
              ok: false as const,
              status: 422 as const,
              message: "Dependency property not found",
            };
          }
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

        if (dependencies.length > 0) {
          await tx.insert(propertyDependencies).values(
            dependencies.map(({ dependsOnPropertyId, condition }) => ({
              workspaceId,
              propertyId: inserted.id,
              dependsOnPropertyId,
              condition,
            })),
          );
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
