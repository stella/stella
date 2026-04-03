import { valibotSchema } from "@ai-sdk/valibot";
import type { Tool, ToolExecutionOptions } from "ai";
import { panic } from "better-result";
import { and, eq } from "drizzle-orm";
import * as v from "valibot";

import type { ScopedDb } from "@/api/db";
import { entities, fields } from "@/api/db/schema";
import type { FieldContent } from "@/api/db/schema-validators";
import { markdownToDocx } from "@/api/handlers/docx/markdown-to-docx";
import { createEntityFromBuffer } from "@/api/handlers/entities/create-from-buffer";
import { captureError } from "@/api/lib/analytics";
import type { SafeId } from "@/api/lib/branded-types";
import { decryptContent } from "@/api/lib/content-encryption";
import { escapeLike } from "@/api/lib/escape-like";
import { LIMITS } from "@/api/lib/limits";
import { brandPersistedWorkspaceId } from "@/api/lib/safe-id-boundaries";
import { getSearchProvider } from "@/api/lib/search/provider";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

const CONTENT_MAX_CHARS = 8000;
type ToolErrorResult = { error: string };
type WrappedTool<INPUT, OUTPUT> = Tool<INPUT, OUTPUT | ToolErrorResult>;
type DefineToolReturn<INPUT, OUTPUT> = {
  description?: string;
  inputSchema: WrappedTool<INPUT, OUTPUT>["inputSchema"];
  needsApproval?: WrappedTool<INPUT, OUTPUT>["needsApproval"];
  execute: (
    args: INPUT,
    options: ToolExecutionOptions,
  ) => OUTPUT | ToolErrorResult | Promise<OUTPUT | ToolErrorResult>;
};
type DefineToolOptions<INPUT, OUTPUT> = {
  description?: string;
  inputSchema: WrappedTool<INPUT, OUTPUT>["inputSchema"];
  needsApproval?: WrappedTool<INPUT, OUTPUT>["needsApproval"];
  /** Tool name used for error reporting. */
  name: string;
  /** Execute function. Receives parsed args and, optionally,
   *  the full ToolExecutionOptions (abortSignal, toolCallId,
   *  messages). Tools that do not need cancellation can omit
   *  the second parameter. */
  execute: (
    args: INPUT,
    options?: ToolExecutionOptions,
  ) => OUTPUT | Promise<OUTPUT>;
};

/** Wrapper around AI SDK tools that automatically wraps the
 *  execute callback with error handling: unhandled errors
 *  become structured `{ error: string }` objects the model
 *  can act on, instead of throwing and causing an opaque
 *  output-error state.
 *
 *  Intentionally returns a structural `Tool` instead of
 *  calling `tool()`: in `ai@6.0.116`, `tool()` is a runtime
 *  no-op used for inference, and reintroducing it here would
 *  require unsafe casts to widen the output with the error
 *  branch. */
export function defineTool<INPUT, OUTPUT>(
  options: DefineToolOptions<INPUT, OUTPUT>,
): WrappedTool<INPUT, OUTPUT>;
export function defineTool<INPUT, OUTPUT>({
  name,
  execute,
  ...rest
}: DefineToolOptions<INPUT, OUTPUT>): DefineToolReturn<INPUT, OUTPUT> {
  return {
    ...(rest.description === undefined
      ? {}
      : { description: rest.description }),
    ...(rest.needsApproval === undefined
      ? {}
      : { needsApproval: rest.needsApproval }),
    inputSchema: rest.inputSchema,
    execute: async (args: INPUT, options: ToolExecutionOptions) => {
      try {
        return await execute(args, options);
      } catch (error) {
        captureError(error, { toolName: name });
        return { error: "Tool execution failed" };
      }
    },
  };
}

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

// -----------------------------------------------------------------
// Matter tools (workspace-scoped, explicit workspaceId)
// -----------------------------------------------------------------

type MatterToolsContext = {
  /** Validated workspace IDs the AI is allowed to access. */
  allowedWorkspaceIds: SafeId<"workspace">[];
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  scopedDb: ScopedDb;
};

const workspaceIdSchema = (allowedIds: SafeId<"workspace">[]) => {
  const allowedIdsByValue = new Map<string, SafeId<"workspace">>(
    allowedIds.map((id) => [id, id]),
  );
  return v.pipe(
    v.string(),
    v.description(
      "The workspace/matter ID to operate on. " +
        `Allowed values: ${allowedIds.join(", ")}`,
    ),
    v.check(
      (id) => allowedIdsByValue.has(id),
      "Workspace not in the allowed set",
    ),
    v.transform((id) => {
      const allowedId = allowedIdsByValue.get(id);
      if (!allowedId) {
        panic("Workspace ID passed validation but was not in the allowlist");
      }
      return allowedId;
    }),
  );
};

export const createMatterTools = ({
  allowedWorkspaceIds,
  organizationId,
  userId,
  scopedDb,
}: MatterToolsContext) => {
  const wsSchema = workspaceIdSchema(allowedWorkspaceIds);

  return {
    searchMatter: defineTool({
      name: "searchMatter",
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
        const provider = getSearchProvider();
        const result = await provider.search({
          query,
          organizationId,
          workspaceId,
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

    listEntities: defineTool({
      name: "listEntities",
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
        const [ents, properties] = await Promise.all([
          scopedDb((tx) =>
            tx.query.entities.findMany({
              where: {
                workspaceId: { eq: workspaceId },
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
              where: { workspaceId: { eq: workspaceId } },
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

    readEntity: defineTool({
      name: "readEntity",
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
        const entity = await scopedDb((tx) =>
          tx.query.entities.findFirst({
            where: {
              id: entityId,
              workspaceId: { eq: workspaceId },
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
          return { error: "Entity not found in this matter" };
        }

        const properties = await scopedDb((tx) =>
          tx.query.properties.findMany({
            where: { workspaceId: { eq: workspaceId } },
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

    readContent: defineTool({
      name: "readContent",
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
        const row = await scopedDb((tx) =>
          tx.query.extractedContent.findFirst({
            where: {
              entityId,
              organizationId: { eq: organizationId },
            },
            with: {
              entity: { columns: { workspaceId: true } },
            },
          }),
        );

        if (!row) {
          return {
            error:
              "No extracted content available. The file " +
              "may not have been processed yet, or its " +
              "format is not supported for extraction.",
          };
        }

        if (row.entity?.workspaceId !== workspaceId) {
          return {
            error: "Entity not found in this matter.",
          };
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
          truncated,
          text,
        };
      },
    }),

    updateEntityFields: defineTool({
      name: "updateEntityFields",
      description:
        "Update a metadata field on an entity (document, " +
        "task, file). The property type is looked up " +
        "automatically; just pass the value. For " +
        "single-select: pass the option label as a string. " +
        "For text: pass a string. For date: pass an ISO " +
        "date string (YYYY-MM-DD) or null. For int: pass " +
        "a number. For multi-select: pass an array of " +
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
            v.description("The property ID (from readEntity)"),
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
        const property = await scopedDb((tx) =>
          tx.query.properties.findFirst({
            columns: { id: true, content: true },
            where: {
              id: propertyId,
              workspaceId: { eq: workspaceId },
            },
          }),
        );

        if (!property) {
          return {
            error:
              `Property "${propertyId}" not found. ` +
              "Check the system prompt for available " +
              "property IDs.",
          };
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
            return {
              error:
                'Property is "file"; use the document ' +
                "creation or upload tools instead.",
            };
          case "text": {
            if (typeof value !== "string") {
              return {
                error:
                  `Property is "text"; pass a string ` +
                  `value, not ${typeof value}.`,
              };
            }
            content = { version: 1, type: "text", value };
            break;
          }
          case "single-select": {
            if (value !== null && typeof value !== "string") {
              return {
                error:
                  `Property is "single-select"; pass ` +
                  `a string or null, not ${typeof value}.`,
              };
            }
            // Validate option exists.
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
                return {
                  error:
                    `Invalid option "${value}". ` +
                    `Valid: ${[...valid].join(", ")}`,
                };
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
              return {
                error: 'Property is "multi-select"; pass an array of strings.',
              };
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
              return {
                error:
                  'Property is "date"; pass an ISO ' +
                  "date string (YYYY-MM-DD) or null.",
              };
            }
            content = { version: 1, type: "date", value };
            break;
          }
          case "int": {
            if (value !== null && typeof value !== "number") {
              return {
                error:
                  `Property is "int"; pass a number ` +
                  `or null, not ${typeof value}.`,
              };
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
            panic("Unhandled property type in updateEntityFields tool");
        }

        const entity = await scopedDb((tx) =>
          tx.query.entities.findFirst({
            columns: { id: true, currentVersionId: true },
            where: {
              id: entityId,
              workspaceId: { eq: workspaceId },
            },
          }),
        );

        if (!entity) {
          return {
            error:
              `Entity "${entityId}" not found. Use ` +
              "listEntities to get valid entity IDs.",
          };
        }

        if (!entity.currentVersionId) {
          return {
            error:
              `Entity "${entityId}" has no current ` +
              "version and cannot be updated.",
          };
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
              workspaceId,
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

    createDocument: defineTool({
      name: "createDocument",
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
        const buffer = await markdownToDocx(markdown);
        const fileName = `${name}.docx`;

        const result = await createEntityFromBuffer({
          scopedDb,
          organizationId,
          workspaceId,
          userId,
          buffer,
          fileName,
          mimeType: DOCX_MIME_TYPE,
        });

        if (!result.success) {
          return { error: result.error };
        }

        return {
          success: true,
          entityId: result.entityId,
          fileName: result.fileName,
        };
      },
    }),

    searchContent: defineTool({
      name: "searchContent",
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
        const provider = getSearchProvider();
        const result = await provider.searchContent({
          query,
          organizationId,
          workspaceId,
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

// -----------------------------------------------------------------
// Org-level tools (always available)
// -----------------------------------------------------------------

type OrgToolsContext = {
  organizationId: SafeId<"organization">;
  scopedDb: ScopedDb;
};

export const createOrgTools = ({
  organizationId,
  scopedDb,
}: OrgToolsContext) => ({
  searchAcrossMatters: defineTool({
    name: "searchAcrossMatters",
    description:
      "Search for documents across ALL matters in the " +
      "organization. Only use this when the user explicitly " +
      "asks to search outside the current matter.",
    inputSchema: valibotSchema(
      v.strictObject({
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
    execute: async ({ query, limit }) => {
      const provider = getSearchProvider();
      const result = await provider.search({
        query,
        organizationId,
        limit,
      });
      return {
        totalCount: result.totalCount,
        hits: result.hits.map((hit) => ({
          entityId: hit.entityId,
          workspaceId: hit.workspaceId,
          workspaceName: hit.workspaceName,
          name: hit.title,
          kind: hit.kind,
          headline: hit.headline,
        })),
      };
    },
  }),

  readContentAcrossMatters: defineTool({
    name: "readContentAcrossMatters",
    description:
      "Read the extracted text content of a document from " +
      "any matter. Use after searchAcrossMatters finds a " +
      "document outside the current matter.",
    inputSchema: valibotSchema(
      v.strictObject({
        entityId: v.pipe(
          v.string(),
          v.description("The entity ID whose content to read"),
        ),
      }),
    ),
    execute: async ({ entityId }) => {
      // extracted_content has RLS; use scopedDb which has
      // all the user's workspace IDs.
      const row = await scopedDb((tx) =>
        tx.query.extractedContent.findFirst({
          where: {
            entityId,
            organizationId: { eq: organizationId },
          },
          with: {
            entity: {
              columns: {
                workspaceId: true,
                name: true,
              },
            },
          },
        }),
      );

      if (!row) {
        return {
          error: "No extracted content available for this entity.",
        };
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
        workspaceId: row.entity?.workspaceId ?? null,
        name: row.entity?.name ?? null,
        charCount: row.charCount,
        truncated,
        text,
      };
    },
  }),

  readContact: defineTool({
    name: "readContact",
    description: "Get details about a contact (person or organization).",
    inputSchema: valibotSchema(
      v.strictObject({
        contactId: v.pipe(v.string(), v.description("The contact ID to read")),
      }),
    ),
    execute: async ({ contactId }) => {
      const contact = await scopedDb((tx) =>
        tx.query.contacts.findFirst({
          where: {
            id: contactId,
            organizationId: { eq: organizationId },
          },
          columns: {
            id: true,
            type: true,
            displayName: true,
            firstName: true,
            lastName: true,
            organizationName: true,
            emails: true,
            phones: true,
          },
        }),
      );

      if (!contact) {
        return { error: "Contact not found" };
      }

      return {
        contactId: contact.id,
        type: contact.type,
        displayName: contact.displayName,
        firstName: contact.firstName,
        lastName: contact.lastName,
        organizationName: contact.organizationName,
        emails: contact.emails ?? [],
        phones: contact.phones ?? [],
      };
    },
  }),

  listTemplates: defineTool({
    name: "listTemplates",
    description: "List available document templates.",
    inputSchema: valibotSchema(
      v.strictObject({
        query: v.optional(
          v.pipe(v.string(), v.description("Filter by name (substring match)")),
        ),
        limit: v.optional(
          v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(50)),
          20,
        ),
      }),
    ),
    execute: async ({ query, limit }) => {
      const templates = await scopedDb((tx) =>
        tx.query.templates.findMany({
          where: {
            organizationId: { eq: organizationId },
            ...(query ? { name: { ilike: `%${escapeLike(query)}%` } } : {}),
          },
          columns: {
            id: true,
            name: true,
            fileName: true,
            createdAt: true,
          },
          limit,
          orderBy: { createdAt: "desc" },
        }),
      );

      return templates.map((t) => ({
        templateId: t.id,
        name: t.name,
        fileName: t.fileName,
        createdAt: t.createdAt.toISOString(),
      }));
    },
  }),

  readClause: defineTool({
    name: "readClause",
    description: "Read a legal clause including its full text body.",
    inputSchema: valibotSchema(
      v.strictObject({
        clauseId: v.pipe(v.string(), v.description("The clause ID to read")),
      }),
    ),
    execute: async ({ clauseId }) => {
      const clause = await scopedDb((tx) =>
        tx.query.clauses.findFirst({
          where: {
            id: clauseId,
            organizationId: { eq: organizationId },
          },
          columns: {
            id: true,
            title: true,
            language: true,
            description: true,
            body: true,
            currentVersion: true,
          },
        }),
      );

      if (!clause) {
        return { error: "Clause not found" };
      }

      return {
        clauseId: clause.id,
        title: clause.title,
        language: clause.language,
        description: clause.description,
        version: clause.currentVersion,
        body: clause.body,
      };
    },
  }),

  askUser: defineTool({
    name: "askUser",
    description:
      "Ask the user clarifying questions before executing " +
      "a complex task. Use this when the request is " +
      "ambiguous or requires decisions you cannot make " +
      "alone (jurisdiction, parties, preferences, scope). " +
      "The UI renders the questions automatically. Once " +
      "the user answers, synthesize their input into a " +
      "plan and execute it.",
    inputSchema: valibotSchema(
      v.strictObject({
        analysis: v.pipe(
          v.string(),
          v.description(
            "Brief analysis of the task and what you " +
              "already know from context",
          ),
        ),
        questions: v.pipe(
          v.array(
            v.strictObject({
              question: v.string(),
              reason: v.pipe(
                v.string(),
                v.description("Why this matters for the task"),
              ),
              options: v.optional(
                v.pipe(
                  v.array(v.string()),
                  v.description(
                    "Suggested options (A/B/C style). " +
                      "The user can also write their " +
                      "own answer.",
                  ),
                ),
              ),
              default: v.optional(
                v.pipe(
                  v.string(),
                  v.description("Preselected option or default value"),
                ),
              ),
            }),
          ),
          v.minLength(1),
          v.maxLength(10),
          v.description("Clarifying questions to ask"),
        ),
      }),
    ),
    execute: ({ analysis, questions }) => ({
      status: "awaiting_response",
      analysis,
      questionCount: questions.length,
    }),
  }),
});

// -----------------------------------------------------------------
// Validation: check workspace IDs belong to an organization
// -----------------------------------------------------------------

export const validateWorkspaceIds = async (
  rawIds: string[],
  organizationId: SafeId<"organization">,
  scopedDb: ScopedDb,
): Promise<SafeId<"workspace">[]> => {
  if (rawIds.length === 0) {
    return [];
  }

  const rows = await scopedDb((tx) =>
    tx.query.workspaces.findMany({
      where: {
        id: { in: rawIds },
        organizationId: { eq: organizationId },
      },
      columns: { id: true },
    }),
  );

  return rows.map((w) => brandPersistedWorkspaceId(w.id));
};
