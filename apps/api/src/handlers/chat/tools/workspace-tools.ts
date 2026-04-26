import { valibotSchema } from "@ai-sdk/valibot";
// oxlint-disable-next-line no-restricted-imports
import { tool } from "ai";
import { panic, Result } from "better-result";
import { and, eq } from "drizzle-orm";
import * as v from "valibot";

import type { ScopedDb } from "@/api/db";
import { entities, fields } from "@/api/db/schema";
import type { FieldContent } from "@/api/db/schema-validators";
import { buildChatSourceDocument } from "@/api/handlers/chat/tools/chat-source-document";
import { markdownToDocx } from "@/api/handlers/docx/markdown-to-docx";
import { createEntityFromBuffer } from "@/api/handlers/entities/create-from-buffer";
import { captureError } from "@/api/lib/analytics";
import type { SafeId } from "@/api/lib/branded-types";
import { decryptContent } from "@/api/lib/content-encryption";
import { ChatToolError, unreachable } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import { getSearchProvider } from "@/api/lib/search/provider";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

const CONTENT_MAX_CHARS = 8000;

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
      // Parse ISO date and format as "29 Jul 2025" so the
      // model sees an unambiguous, human-readable date.
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
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  scopedDb: ScopedDb;
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
  organizationId,
  userId,
  scopedDb,
}: WorkspaceToolsContext) => {
  if (allowedWorkspaceIds.length === 0) {
    return {};
  }

  const allowedWorkspaceIdsByValue =
    createAllowedWorkspaceIdMap(allowedWorkspaceIds);
  const wsSchema = workspaceIdSchema(allowedWorkspaceIds);

  return {
    "search-matter": tool({
      description:
        "Search for documents and files within a matter " +
        "using full-text search. Returns matching entity " +
        "names with highlighted excerpts.",
      inputSchema: valibotSchema(
        v.strictObject({
          workspaceId: wsSchema,
          query: v.pipe(
            v.string(),
            v.maxLength(LIMITS.searchQueryMaxLength),
            v.description("Search query (keywords or phrases)"),
          ),
          limit: v.optional(
            v.pipe(
              v.number(),
              v.integer(),
              v.minValue(1),
              v.maxValue(20),
              v.description("Max results to return"),
            ),
            10,
          ),
        }),
      ),
      execute: async ({ workspaceId, query, limit }) => {
        const allowedWorkspaceId = requireAllowedWorkspaceId({
          allowedIdsByValue: allowedWorkspaceIdsByValue,
          workspaceId,
        });
        const provider = getSearchProvider();
        const result = await provider.search({
          query,
          organizationId,
          workspaceId: allowedWorkspaceId,
          limit,
        });
        return {
          totalCount: result.totalCount,
          hits: result.hits.map((hit) => ({
            entityId: hit.entityId,
            name: hit.title,
            kind: hit.kind,
            headline: hit.headline,
          })),
        };
      },
    }),

    "list-entities": tool({
      description:
        "List documents, files, tasks, and folders in a " +
        "matter. Returns names, types, dates, and custom " +
        "property values (metadata columns).",
      inputSchema: valibotSchema(
        v.strictObject({
          workspaceId: wsSchema,
          kind: v.optional(
            v.pipe(
              v.picklist(["document", "folder", "task", "message"]),
              v.description("Filter by entity type"),
            ),
          ),
          parentId: v.optional(
            v.pipe(
              v.string(),
              v.description("List contents of a specific folder"),
            ),
          ),
          limit: v.optional(
            v.pipe(
              v.number(),
              v.integer(),
              v.minValue(1),
              v.maxValue(100),
              v.description("Max entities to return"),
            ),
            50,
          ),
        }),
      ),
      execute: async ({ workspaceId, kind, parentId, limit }) => {
        const allowedWorkspaceId = requireAllowedWorkspaceId({
          allowedIdsByValue: allowedWorkspaceIdsByValue,
          workspaceId,
        });
        const [ents, properties] = await Promise.all([
          scopedDb((tx) =>
            tx.query.entities.findMany({
              where: {
                workspaceId: { eq: allowedWorkspaceId },
                ...(kind ? { kind } : {}),
                ...(parentId ? { parentId } : {}),
              },
              orderBy: { createdAt: "asc" },
              limit,
              columns: {
                id: true,
                kind: true,
                name: true,
                parentId: true,
              },
              with: {
                currentVersion: {
                  columns: { id: true },
                  with: {
                    fields: {
                      columns: {
                        propertyId: true,
                        content: true,
                      },
                    },
                  },
                },
              },
            }),
          ),
          scopedDb((tx) =>
            tx.query.properties.findMany({
              where: { workspaceId: { eq: allowedWorkspaceId } },
              columns: { id: true, name: true },
            }),
          ),
        ]);
        const propNameById = new Map(properties.map((p) => [p.id, p.name]));

        // Build a compact { propertyName: value } map per
        // entity to minimize token usage in AI context.
        return ents.map((entity) => {
          const fieldMap: Record<string, string> = {};
          for (const f of entity.currentVersion?.fields ?? []) {
            const val = formatFieldValue(f.content);
            if (val === "") {
              continue;
            }
            const key = propNameById.get(f.propertyId) ?? f.propertyId;
            fieldMap[key] = val;
          }
          return {
            id: entity.id,
            kind: entity.kind,
            name: entity.name,
            parentId: entity.parentId,
            fields: fieldMap,
          };
        });
      },
    }),

    "read-entity": tool({
      description:
        "Get detailed information about a specific entity " +
        "including all its property values (metadata).",
      inputSchema: valibotSchema(
        v.strictObject({
          workspaceId: wsSchema,
          entityId: v.pipe(v.string(), v.description("The entity ID to read")),
        }),
      ),
      execute: async ({ workspaceId, entityId }) => {
        const allowedWorkspaceId = requireAllowedWorkspaceId({
          allowedIdsByValue: allowedWorkspaceIdsByValue,
          workspaceId,
        });
        const entity = await scopedDb((tx) =>
          tx.query.entities.findFirst({
            where: {
              id: entityId,
              workspaceId: { eq: allowedWorkspaceId },
            },
            columns: {
              id: true,
              kind: true,
              name: true,
              parentId: true,
              createdAt: true,
              updatedAt: true,
            },
            with: {
              createdByUser: { columns: { name: true } },
              versions: { columns: { id: true } },
              currentVersion: {
                columns: { id: true },
                with: {
                  fields: {
                    columns: {
                      propertyId: true,
                      content: true,
                    },
                  },
                },
              },
            },
          }),
        );

        if (!entity) {
          throw new ChatToolError({
            message: "Entity not found in this matter",
          });
        }

        const properties = await scopedDb((tx) =>
          tx.query.properties.findMany({
            where: { workspaceId: { eq: allowedWorkspaceId } },
            columns: { id: true, name: true },
          }),
        );
        const propNameById = new Map(properties.map((p) => [p.id, p.name]));

        return {
          entityId: entity.id,
          kind: entity.kind,
          name: entity.name,
          parentId: entity.parentId,
          createdAt: entity.createdAt.toISOString(),
          createdBy: entity.createdByUser?.name ?? null,
          sourceDocument: buildChatSourceDocument({
            entityId: entity.id,
            fields: entity.currentVersion?.fields,
            kind: entity.kind,
            name: entity.name,
            workspaceId: allowedWorkspaceId,
          }),
          versionCount: entity.versions.length,
          fields:
            entity.currentVersion?.fields
              .map((f) => ({
                propertyId: f.propertyId,
                property: propNameById.get(f.propertyId) ?? f.propertyId,
                type: f.content.type,
                value: formatFieldValue(f.content),
              }))
              .filter((f) => f.value !== "") ?? [],
        };
      },
    }),

    "read-content": tool({
      description:
        "Read the extracted text content of a document. Use " +
        "this to read actual file contents, not just metadata. " +
        "Returns up to 8000 characters of extracted text.",
      inputSchema: valibotSchema(
        v.strictObject({
          workspaceId: wsSchema,
          entityId: v.pipe(
            v.string(),
            v.description("The entity ID whose content to read"),
          ),
        }),
      ),
      execute: async ({ workspaceId, entityId }) => {
        const allowedWorkspaceId = requireAllowedWorkspaceId({
          allowedIdsByValue: allowedWorkspaceIdsByValue,
          workspaceId,
        });
        const row = await scopedDb((tx) =>
          tx.query.extractedContent.findFirst({
            where: {
              entityId,
              organizationId: { eq: organizationId },
            },
            with: {
              entity: {
                where: {
                  workspaceId: { eq: allowedWorkspaceId },
                },
                columns: {
                  name: true,
                  kind: true,
                },
                with: {
                  currentVersion: {
                    columns: {},
                    with: {
                      fields: {
                        columns: { content: true },
                      },
                    },
                  },
                },
              },
            },
          }),
        );

        if (!row) {
          throw new ChatToolError({
            message:
              "No extracted content available. The file may not have been processed yet, or its format is not supported for extraction.",
          });
        }

        if (!row.entity) {
          throw new ChatToolError({
            message: "Entity not found in this matter.",
          });
        }

        const plaintext = await decryptContent(
          organizationId,
          row.ciphertext,
          row.iv,
        );

        const truncated = plaintext.length > CONTENT_MAX_CHARS;
        const text = truncated
          ? plaintext.slice(0, CONTENT_MAX_CHARS)
          : plaintext;

        return {
          entityId,
          charCount: row.charCount,
          sourceDocument: buildChatSourceDocument({
            entityId,
            fields: row.entity?.currentVersion?.fields,
            kind: row.entity?.kind,
            name: row.entity?.name,
            workspaceId: allowedWorkspaceId,
          }),
          truncated,
          text,
        };
      },
    }),

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
          entityId: v.pipe(
            v.string(),
            v.description("The entity ID to update"),
          ),
          propertyId: v.pipe(
            v.string(),
            v.description("The property ID (from read-entity)"),
          ),
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
              v.description(
                "Current value before the change " +
                  "(for display in approval)",
              ),
            ),
          ),
        }),
      ),
      execute: async ({ workspaceId, entityId, propertyId, value }) => {
        const allowedWorkspaceId = requireAllowedWorkspaceId({
          allowedIdsByValue: allowedWorkspaceIdsByValue,
          workspaceId,
        });
        const property = await scopedDb((tx) =>
          tx.query.properties.findFirst({
            columns: { id: true, content: true },
            where: {
              id: propertyId,
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

        // Build typed content from the flat value,
        // validating against the property type.
        // SAFETY: content is always assigned in the switch
        // for non-null values; null values hit the isEmpty
        // path which skips the insert.
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
                ).map((o) => o.value),
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
            columns: { id: true, currentVersionId: true },
            where: {
              id: entityId,
              workspaceId: { eq: allowedWorkspaceId },
            },
          }),
        );

        if (!entity) {
          throw new ChatToolError({
            message: `Entity "${entityId}" not found. Use list-entities to get valid entity IDs.`,
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

    "create-document": tool({
      description:
        "Create a new DOCX document in the matter from " +
        "markdown content. Write the document body as " +
        "markdown; it is converted to a styled DOCX file " +
        "and stored in the matter.",
      needsApproval: true,
      inputSchema: valibotSchema(
        v.strictObject({
          workspaceId: wsSchema,
          name: v.pipe(
            v.string(),
            v.maxLength(256),
            v.description("Document file name (without .docx extension)"),
          ),
          markdown: v.pipe(
            v.string(),
            v.description("Document content as markdown"),
          ),
        }),
      ),
      execute: async ({ workspaceId, name, markdown }) => {
        const allowedWorkspaceId = requireAllowedWorkspaceId({
          allowedIdsByValue: allowedWorkspaceIdsByValue,
          workspaceId,
        });
        const buffer = await markdownToDocx(markdown);
        const fileName = sanitizeFilename(`${name}.docx`);

        const result = await createEntityFromBuffer({
          scopedDb,
          organizationId,
          workspaceId: allowedWorkspaceId,
          userId,
          buffer,
          fileName,
          mimeType: DOCX_MIME_TYPE,
        });

        if (Result.isOk(result)) {
          const { entityId: newEntityId, fileName: newFileName } = result.value;

          return {
            success: true,
            entityId: newEntityId,
            fileName: newFileName,
          };
        }

        switch (result.error._tag) {
          case "EntityLimitError":
            throw new ChatToolError({
              message:
                "This matter has reached the entity limit, so the document could not be created.",
            });
          case "MissingFilePropertyError":
            throw new ChatToolError({
              message:
                "This matter is missing a file property, so the document could not be created.",
            });
          default:
            return unreachable("Unhandled createEntityFromBuffer error tag");
        }
      },
    }),

    "search-content": tool({
      description:
        "Search across document text content within a " +
        "matter. Returns matching passages from documents " +
        "with document name and entity ID. Use this to find " +
        "specific clauses, terms, or information across " +
        "all documents without reading each one individually.",
      inputSchema: valibotSchema(
        v.strictObject({
          workspaceId: wsSchema,
          query: v.pipe(
            v.string(),
            v.maxLength(LIMITS.searchQueryMaxLength),
            v.description("Text or keywords to search for"),
          ),
          limit: v.optional(
            v.pipe(
              v.number(),
              v.integer(),
              v.minValue(1),
              v.maxValue(20),
              v.description("Max results (default: 5)"),
            ),
            5,
          ),
        }),
      ),
      execute: async ({ workspaceId, query, limit }) => {
        const allowedWorkspaceId = requireAllowedWorkspaceId({
          allowedIdsByValue: allowedWorkspaceIdsByValue,
          workspaceId,
        });
        const provider = getSearchProvider();
        const result = await provider.searchContent({
          query,
          organizationId,
          workspaceId: allowedWorkspaceId,
          limit,
        });
        const truncated = result.totalCount > result.hits.length;
        return {
          totalCount: result.totalCount,
          truncated,
          ...(truncated && {
            note: `Showing ${result.hits.length} of ${result.totalCount} matches. Refine your query for more targeted results.`,
          }),
          results: result.hits.map((hit) => ({
            entityId: hit.entityId,
            name: hit.title,
            kind: hit.kind,
            passage: hit.passage,
          })),
        };
      },
    }),
  };
};
