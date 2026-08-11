import { toolDefinition } from "@tanstack/ai";
import { panic, Result } from "better-result";
import { and, eq } from "drizzle-orm";
import * as v from "valibot";

import type { ScopedDb } from "@/api/db/safe-db";
import { entities, fields } from "@/api/db/schema";
import type { FieldContent } from "@/api/db/schema-validators";
import { UPDATE_ENTITY_FIELDS_TOOL_NAME } from "@/api/handlers/chat/tools/native-chat-tool-names";
import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import type { ChatRefRegistry } from "@/api/lib/chat/ref-registry";
import { CHAT_ENTITY_REF_PREFIX } from "@/api/lib/chat/ref-registry";
import { ChatToolError } from "@/api/lib/errors/tagged-errors";
import {
  enqueueEntitySearchRepairs,
  flushEntitySearchRepairs,
} from "@/api/lib/search/projection-repair-queue";
import { isRecord } from "@/api/lib/type-guards";

const refSchema = (description: string) =>
  v.pipe(v.string(), v.description(description));

// -----------------------------------------------------------------
// Matter tools (workspace-scoped, explicit workspaceId)
// -----------------------------------------------------------------

/** Summarize a field value into a human-readable string. */
const formatFieldValue = (content: FieldContent): string => {
  switch (content.type) {
    case "text":
      return content.value;
    case "single-select":
      return content.value ?? "";
    case "multi-select":
      return content.value.join(", ");
    case "date": {
      if (!content.value) {
        return "";
      }

      const [y, m, d] = content.value.split("-");
      const date = new Date(Number(y), Number(m) - 1, Number(d));
      return date.toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
      });
    }
    case "int":
      return content.currency
        ? `${content.value} ${content.currency}`
        : String(content.value);
    case "file":
      return `[file: ${content.fileName}]`;
    case "pending":
      return "(pending)";
    case "error":
      return "(error)";
    case "unsupported":
    case "clip":
      return "(unsupported)";
    default:
      return "";
  }
};

type WorkspaceToolsContext = {
  allowedWorkspaceIds: readonly SafeId<"workspace">[];
  refRegistry: ChatRefRegistry;
  scopedDb: ScopedDb;
};

type CreatedDocumentToolOutputProps = {
  entityId: SafeId<"entity">;
  fileName: string;
  refRegistry: ChatRefRegistry;
  workspaceId: SafeId<"workspace">;
};

export const buildCreatedDocumentToolOutput = ({
  entityId,
  fileName,
  refRegistry,
  workspaceId,
}: CreatedDocumentToolOutputProps) => {
  const entityRef = refRegistry.toEntityRef({ entityId, workspaceId });
  const matterRef = refRegistry.toMatterRef(workspaceId);
  const href = `${CHAT_ENTITY_REF_PREFIX}${entityRef}`;

  return {
    success: true as const,
    fileName,
    entityRef,
    matterRef,
    href,
    mention: refRegistry.toEntityMention({
      entityId,
      label: fileName,
      workspaceId,
    }),
  };
};

/**
 * Enumerate the allowed matters by their chat refs, never their UUIDs: this
 * description is serialized into the provider-visible tool catalog every
 * turn, so a raw workspace id here would hand the model exactly the tenant
 * identifier the ref invariant exists to keep away from it (and did, before
 * this took refs).
 */
const matterRefSchema = (allowedMatterRefs: readonly string[]) =>
  v.pipe(
    v.string(),
    v.description(
      "The matter ref to operate on. " +
        `Allowed values: ${allowedMatterRefs.join(", ")}`,
    ),
  );

const updateEntityFieldsOutputSchema = v.strictObject({
  success: v.literal(true),
  entityRef: v.string(),
  propertyRef: v.string(),
  newValue: v.string(),
});

const requireAllowedWorkspaceId = ({
  allowedIds,
  workspaceId,
}: {
  allowedIds: ReadonlySet<string>;
  workspaceId: SafeId<"workspace">;
}): SafeId<"workspace"> => {
  if (!allowedIds.has(workspaceId)) {
    throw new ChatToolError({
      kind: "not-found",
      message: "Matter not in the allowed set.",
    });
  }

  return workspaceId;
};

export const createWorkspaceTools = ({
  allowedWorkspaceIds,
  refRegistry,
  scopedDb,
}: WorkspaceToolsContext) => {
  if (allowedWorkspaceIds.length === 0) {
    return {};
  }

  const allowedWorkspaceIdSet: ReadonlySet<string> = new Set(
    allowedWorkspaceIds,
  );
  const wsSchema = matterRefSchema(
    allowedWorkspaceIds.map((id) => refRegistry.toMatterRef(id)),
  );

  return {
    [UPDATE_ENTITY_FIELDS_TOOL_NAME]: toolDefinition({
      name: UPDATE_ENTITY_FIELDS_TOOL_NAME,
      description:
        "Update a metadata field on an entity (document, " +
        "task, file). The property type is looked up " +
        "automatically; just pass the value. For " +
        "single-select: pass the option label as a string. " +
        "For text: pass a string. For date: pass an ISO " +
        "date string (YYYY-MM-DD) or null. For int: pass a " +
        "number. For multi-select: pass an array of " +
        "strings.",
      needsApproval: true,
      inputSchema: toTanStackToolSchema(
        v.strictObject({
          matterRef: wsSchema,
          entityRef: refSchema(
            "The entity ref (ent_N) of the entity to update, from read tools",
          ),
          propertyRef: refSchema(
            "The property ref (prop_N), from external_list_properties",
          ),
          value: v.pipe(
            v.union([v.string(), v.number(), v.array(v.string()), v.null_()]),
            v.description("New value for the field"),
          ),
        }),
      ),
      outputSchema: toTanStackToolSchema(updateEntityFieldsOutputSchema),
    }).server(async (input) => {
      const resolvedMatter = refRegistry.resolveMatterRefs([input.matterRef]);
      if (Result.isError(resolvedMatter)) {
        throw resolvedMatter.error;
      }
      const allowedWorkspaceId = requireAllowedWorkspaceId({
        allowedIds: allowedWorkspaceIdSet,
        workspaceId:
          resolvedMatter.value.at(0) ??
          panic("resolved matter ref list is unexpectedly empty"),
      });
      const resolvedEntity = refRegistry.resolveEntityRefTargets([
        input.entityRef,
      ]);
      if (Result.isError(resolvedEntity)) {
        throw resolvedEntity.error;
      }
      const entityTarget =
        resolvedEntity.value.at(0) ??
        panic("resolved entity ref list is unexpectedly empty");
      if (entityTarget.workspaceId !== allowedWorkspaceId) {
        throw new ChatToolError({
          kind: "invalid-input",
          message: `Entity "${input.entityRef}" does not belong to matter "${input.matterRef}".`,
        });
      }
      const entityId = entityTarget.entityId;
      const resolvedProperty = refRegistry.resolvePropertyRefs([
        input.propertyRef,
      ]);
      if (Result.isError(resolvedProperty)) {
        throw resolvedProperty.error;
      }
      const propertyId =
        resolvedProperty.value.at(0) ??
        panic("resolved property ref list is unexpectedly empty");
      const { value } = input;
      const property = await scopedDb((tx) =>
        tx.query.properties.findFirst({
          columns: { id: true, content: true },
          where: {
            id: { eq: propertyId },
            workspaceId: { eq: allowedWorkspaceId },
          },
        }),
      );

      if (!property) {
        throw new ChatToolError({
          kind: "not-found",
          message: `Property "${input.propertyRef}" not found in matter "${input.matterRef}". Discover property refs with external_list_properties.`,
        });
      }

      const propType = property.content.type;

      let content!: FieldContent;
      switch (propType) {
        case "file":
          throw new ChatToolError({
            kind: "invalid-input",
            message:
              'Property is "file"; use the document creation or upload tools instead.',
          });
        case "text": {
          if (typeof value !== "string") {
            throw new ChatToolError({
              kind: "invalid-input",
              message: `Property is "text"; pass a string value, not ${typeof value}.`,
            });
          }
          content = { version: 1, type: "text", value };
          break;
        }
        case "single-select": {
          if (value !== null && typeof value !== "string") {
            throw new ChatToolError({
              kind: "invalid-input",
              message: `Property is "single-select"; pass a string or null, not ${typeof value}.`,
            });
          }
          if (
            value !== null &&
            "options" in property.content &&
            Array.isArray(property.content.options)
          ) {
            const valid = new Set(
              property.content.options.flatMap((option) =>
                isRecord(option) && typeof option.value === "string"
                  ? [option.value]
                  : [],
              ),
            );
            if (!valid.has(value)) {
              throw new ChatToolError({
                kind: "invalid-input",
                message: `Invalid option "${value}". Valid: ${[...valid].join(", ")}`,
              });
            }
          }
          content = {
            version: 1,
            type: "single-select",
            value,
          };
          break;
        }
        case "multi-select": {
          if (!Array.isArray(value)) {
            throw new ChatToolError({
              kind: "invalid-input",
              message: 'Property is "multi-select"; pass an array of strings.',
            });
          }
          content = {
            version: 1,
            type: "multi-select",
            value,
          };
          break;
        }
        case "date": {
          if (value !== null && typeof value !== "string") {
            throw new ChatToolError({
              kind: "invalid-input",
              message:
                'Property is "date"; pass an ISO date string (YYYY-MM-DD) or null.',
            });
          }
          content = { version: 1, type: "date", value };
          break;
        }
        case "int": {
          if (value !== null && typeof value !== "number") {
            throw new ChatToolError({
              kind: "invalid-input",
              message: `Property is "int"; pass a number or null, not ${typeof value}.`,
            });
          }
          if (value !== null) {
            content = {
              version: 1,
              type: "int",
              value,
              currency: null,
            };
          }
          break;
        }
        default:
          panic("Unhandled property type in update-entity-fields tool");
      }

      const entity = await scopedDb((tx) =>
        tx.query.entities.findFirst({
          columns: { id: true, currentVersionId: true, readOnly: true },
          where: {
            id: { eq: entityId },
            workspaceId: { eq: allowedWorkspaceId },
          },
        }),
      );

      if (!entity) {
        throw new ChatToolError({
          kind: "not-found",
          message: `Entity "${input.entityRef}" not found.`,
        });
      }
      if (entity.readOnly) {
        throw new ChatToolError({
          kind: "invalid-input",
          message: `Entity "${input.entityRef}" is read-only.`,
        });
      }

      if (!entity.currentVersionId) {
        throw new ChatToolError({
          kind: "not-found",
          message: `Entity "${input.entityRef}" has no current version and cannot be updated.`,
        });
      }

      const versionId = entity.currentVersionId;
      const isEmpty =
        value === null ||
        value === "" ||
        (Array.isArray(value) && value.length === 0);

      await scopedDb(async (tx) => {
        // audit: skip — MCP tool execution metadata; audit happens at the parent user action
        await tx
          .delete(fields)
          .where(
            and(
              eq(fields.propertyId, propertyId),
              eq(fields.entityVersionId, versionId),
            ),
          );

        if (!isEmpty) {
          await tx.insert(fields).values({
            workspaceId: allowedWorkspaceId,
            propertyId,
            entityVersionId: versionId,
            content,
          });
        }

        await tx
          .update(entities)
          .set({ updatedAt: new Date() })
          .where(eq(entities.id, entityId));

        await enqueueEntitySearchRepairs(tx, [entityId]);
      });

      flushEntitySearchRepairs([entityId]).catch(captureError);

      return {
        success: true,
        entityRef: input.entityRef,
        propertyRef: input.propertyRef,
        newValue: isEmpty ? "" : formatFieldValue(content),
      };
    }),
  };
};
