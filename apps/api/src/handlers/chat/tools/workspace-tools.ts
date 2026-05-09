import { valibotSchema } from "@ai-sdk/valibot";
import { tool } from "ai";
import { panic } from "better-result";
import { and, eq } from "drizzle-orm";
import * as v from "valibot";

import type { ScopedDb } from "@/api/db";
import { entities, fields } from "@/api/db/schema";
import type { FieldContent } from "@/api/db/schema-validators";
import type { ChatRefRegistry } from "@/api/handlers/chat/tools/execute/ref-registry";
import { CHAT_ENTITY_REF_PREFIX } from "@/api/handlers/chat/tools/execute/ref-registry";
import { captureError } from "@/api/lib/analytics";
import type { SafeId } from "@/api/lib/branded-types";
import { ChatToolError } from "@/api/lib/errors/tagged-errors";
import {
  brandPersistedEntityId,
  brandPersistedPropertyId,
} from "@/api/lib/safe-id-boundaries";
import { getSearchProvider } from "@/api/lib/search/provider";

const idSchema = (description: string) =>
  v.pipe(v.string(), v.uuid(), v.description(description));

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
      if (content.value === null || content.value === undefined) {
        return "";
      }
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
    success: true,
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

const createAllowedWorkspaceIdMap = (
  allowedIds: readonly SafeId<"workspace">[],
) => {
  const allowedIdsByValue = new Map<string, SafeId<"workspace">>(
    allowedIds.map((id) => [id, id]),
  );
  return allowedIdsByValue;
};

const workspaceIdSchema = (allowedIds: readonly SafeId<"workspace">[]) =>
  v.pipe(
    v.string(),
    v.description(
      "The workspace/matter ID to operate on. " +
        `Allowed values: ${allowedIds.join(", ")}`,
    ),
  );

// This is a brand-minting validator: workspaceId is an untrusted
// string from chat-tool input (LLM-generated), looked up in the
// allowed-set Map and returned as SafeId<"workspace"> on success.
// The bare-string parameter is intentional and required.
const requireAllowedWorkspaceId = ({
  allowedIdsByValue,
  workspaceId,
}: {
  allowedIdsByValue: Map<string, SafeId<"workspace">>;
  // eslint-disable-next-line no-unbranded-ownership-id-param/no-unbranded-ownership-id-param
  workspaceId: string;
}): SafeId<"workspace"> => {
  const allowedWorkspaceId = allowedIdsByValue.get(workspaceId);
  if (!allowedWorkspaceId) {
    throw new ChatToolError({
      message: "Workspace not in the allowed set.",
    });
  }

  return allowedWorkspaceId;
};

export const createWorkspaceTools = ({
  allowedWorkspaceIds,
  scopedDb,
}: WorkspaceToolsContext) => {
  if (allowedWorkspaceIds.length === 0) {
    return {};
  }

  const allowedWorkspaceIdsByValue =
    createAllowedWorkspaceIdMap(allowedWorkspaceIds);
  const wsSchema = workspaceIdSchema(allowedWorkspaceIds);

  return {
    "update-entity-fields": tool({
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
      inputSchema: valibotSchema(
        v.strictObject({
          workspaceId: wsSchema,
          entityId: idSchema("The entity ID to update"),
          propertyId: idSchema("The property ID (from read-entity)"),
          value: v.pipe(
            v.union([v.string(), v.number(), v.array(v.string()), v.null_()]),
            v.description("New value for the field"),
          ),
          entityName: v.optional(
            v.pipe(
              v.string(),
              v.description("Entity name (for display in approval)"),
            ),
          ),
          propertyName: v.optional(
            v.pipe(
              v.string(),
              v.description("Property name (for display in approval)"),
            ),
          ),
          oldValue: v.optional(
            v.pipe(
              v.string(),
              v.description("Current value before the change"),
            ),
          ),
        }),
      ),
      execute: async (input) => {
        const allowedWorkspaceId = requireAllowedWorkspaceId({
          allowedIdsByValue: allowedWorkspaceIdsByValue,
          workspaceId: input.workspaceId,
        });
        const entityId = brandPersistedEntityId(input.entityId);
        const propertyId = brandPersistedPropertyId(input.propertyId);
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
            message: `Property "${propertyId}" not found. Check the system prompt for available property IDs.`,
          });
        }

        const propType = property.content.type;

        let content!: FieldContent;
        switch (propType) {
          case "file":
            throw new ChatToolError({
              message:
                'Property is "file"; use the document creation or upload tools instead.',
            });
          case "text": {
            if (typeof value !== "string") {
              throw new ChatToolError({
                message: `Property is "text"; pass a string value, not ${typeof value}.`,
              });
            }
            content = { version: 1, type: "text", value };
            break;
          }
          case "single-select": {
            if (value !== null && typeof value !== "string") {
              throw new ChatToolError({
                message: `Property is "single-select"; pass a string or null, not ${typeof value}.`,
              });
            }
            if (
              value !== null &&
              "options" in property.content &&
              Array.isArray(property.content.options)
            ) {
              const valid = new Set(
                (
                  property.content.options as {
                    value: string;
                  }[]
                ).map((option) => option.value),
              );
              if (!valid.has(value)) {
                throw new ChatToolError({
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
                message:
                  'Property is "multi-select"; pass an array of strings.',
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
            message: `Entity "${entityId}" not found.`,
          });
        }
        if (entity.readOnly) {
          throw new ChatToolError({
            message: `Entity "${entityId}" is read-only.`,
          });
        }

        if (!entity.currentVersionId) {
          throw new ChatToolError({
            message: `Entity "${entityId}" has no current version and cannot be updated.`,
          });
        }

        const versionId = entity.currentVersionId;
        const isEmpty =
          value === null ||
          value === "" ||
          (Array.isArray(value) && value.length === 0);

        await scopedDb(async (tx) => {
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
        });

        getSearchProvider().indexEntity(entityId).catch(captureError);

        return {
          success: true,
          entityId,
          propertyId,
          newValue: isEmpty ? "" : formatFieldValue(content),
        };
      },
    }),
  };
};
