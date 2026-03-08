import { tool } from "ai";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/api/db";
import { entities, fields, workspaces } from "@/api/db/schema";
import type { FieldContent } from "@/api/db/schema-validators";
import { markdownToDocx } from "@/api/handlers/docx/markdown-to-docx";
import { createEntityFromBuffer } from "@/api/handlers/entities/create-from-buffer";
// biome-ignore lint/style/noRestrictedImports: brands actor-validated IDs
import { toSafeId, type SafeId } from "@/api/lib/branded-types";
import { decryptContent } from "@/api/lib/content-encryption";
import { escapeLike } from "@/api/lib/escape-like";
import { LIMITS } from "@/api/lib/limits";
import { captureError } from "@/api/lib/posthog";
import { getSearchProvider } from "@/api/lib/search/provider";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

const CONTENT_MAX_CHARS = 8000;

/** Wrap a tool execute function so unhandled errors are
 *  returned as structured error objects the model can act
 *  on, instead of throwing and causing an opaque
 *  output-error state. */
const safeExecute =
  <TArgs, TResult>(
    fn: (args: TArgs) => Promise<TResult>,
  ): ((args: TArgs) => Promise<TResult | { error: string }>) =>
  async (args) => {
    try {
      return await fn(args);
    } catch (err) {
      captureError(err);
      const msg = err instanceof Error ? err.message : String(err);
      return { error: `Tool failed: ${msg}` };
    }
  };

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
      if (content.value == null) {
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
  userId: string;
};

const workspaceIdSchema = (allowedIds: SafeId<"workspace">[]) => {
  const allowedSet: ReadonlySet<string> = new Set(allowedIds);
  return z
    .string()
    .describe(
      "The workspace/matter ID to operate on. " +
        `Allowed values: ${allowedIds.join(", ")}`,
    )
    .refine((id) => allowedSet.has(id), {
      message: "Workspace not in the allowed set",
    })
    .transform((id) => toSafeId<"workspace">(id));
};

export const createMatterTools = ({
  allowedWorkspaceIds,
  organizationId,
  userId,
}: MatterToolsContext) => {
  const wsSchema = workspaceIdSchema(allowedWorkspaceIds);

  return {
    searchMatter: tool({
      description:
        "Search for documents and files within a matter " +
        "using full-text search. Returns matching entity " +
        "names with highlighted excerpts.",
      inputSchema: z.object({
        workspaceId: wsSchema,
        query: z
          .string()
          .max(LIMITS.searchQueryMaxLength)
          .describe("Search query (keywords or phrases)"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .default(10)
          .describe("Max results to return"),
      }),
      execute: safeExecute(async ({ workspaceId, query, limit }) => {
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
      }),
    }),

    listEntities: tool({
      description:
        "List documents, files, tasks, and folders in a " +
        "matter. Returns names, types, dates, and custom " +
        "property values (metadata columns).",
      inputSchema: z.object({
        workspaceId: wsSchema,
        kind: z
          .enum(["document", "folder", "task", "message"])
          .optional()
          .describe("Filter by entity type"),
        parentId: z
          .string()
          .optional()
          .describe("List contents of a specific folder"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .default(50)
          .describe("Max entities to return"),
      }),
      execute: async ({ workspaceId, kind, parentId, limit }) => {
        const [ents, properties] = await Promise.all([
          db.query.entities.findMany({
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
          db.query.properties.findMany({
            where: { workspaceId: { eq: workspaceId } },
            columns: { id: true, name: true },
          }),
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

    readEntity: tool({
      description:
        "Get detailed information about a specific entity " +
        "including all its property values (metadata).",
      inputSchema: z.object({
        workspaceId: wsSchema,
        entityId: z.string().describe("The entity ID to read"),
      }),
      execute: async ({ workspaceId, entityId }) => {
        const entity = await db.query.entities.findFirst({
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
        });

        if (!entity) {
          return { error: "Entity not found in this matter" };
        }

        const properties = await db.query.properties.findMany({
          where: { workspaceId: { eq: workspaceId } },
          columns: { id: true, name: true },
        });
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

    readContent: tool({
      description:
        "Read the extracted text content of a document. Use " +
        "this to read actual file contents, not just metadata. " +
        "Returns up to 8000 characters of extracted text.",
      inputSchema: z.object({
        workspaceId: wsSchema,
        entityId: z.string().describe("The entity ID whose content to read"),
      }),
      execute: safeExecute(async ({ workspaceId, entityId }) => {
        const row = await db.query.extractedContent.findFirst({
          where: {
            entityId,
            organizationId: { eq: organizationId },
          },
          with: {
            entity: { columns: { workspaceId: true } },
          },
        });

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
      }),
    }),

    updateEntityFields: tool({
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
      inputSchema: z.object({
        workspaceId: wsSchema,
        entityId: z.string().describe("The entity ID to update"),
        propertyId: z.string().describe("The property ID (from readEntity)"),
        value: z
          .union([z.string(), z.number(), z.array(z.string()), z.null()])
          .describe("New value for the field"),
        entityName: z
          .string()
          .optional()
          .describe("Entity name (for display in approval)"),
        propertyName: z
          .string()
          .optional()
          .describe("Property name (for display in approval)"),
        oldValue: z
          .string()
          .optional()
          .describe(
            "Current value before the change (for display in approval)",
          ),
      }),
      execute: safeExecute(
        async ({ workspaceId, entityId, propertyId, value }) => {
          const property = await db.query.properties.findFirst({
            columns: { id: true, content: true },
            where: {
              id: propertyId,
              workspaceId: { eq: workspaceId },
            },
          });

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
                  error:
                    'Property is "multi-select"; pass ' +
                    "an array of strings.",
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
              return {
                error: `Unsupported property type "${propType}".`,
              };
          }

          const entity = await db.query.entities.findFirst({
            columns: { id: true, currentVersionId: true },
            where: {
              id: entityId,
              workspaceId: { eq: workspaceId },
            },
          });

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

          await db.transaction(async (tx) => {
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
      ),
    }),

    createDocument: tool({
      description:
        "Create a new DOCX document in the matter from " +
        "markdown content. Write the document body as " +
        "markdown; it is converted to a styled DOCX file " +
        "and stored in the matter.",
      needsApproval: true,
      inputSchema: z.object({
        workspaceId: wsSchema,
        name: z
          .string()
          .max(256)
          .describe("Document file name (without .docx extension)"),
        markdown: z.string().describe("Document content as markdown"),
      }),
      execute: safeExecute(async ({ workspaceId, name, markdown }) => {
        const buffer = await markdownToDocx(markdown);
        const fileName = `${name}.docx`;

        const result = await createEntityFromBuffer({
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
      }),
    }),

    searchContent: tool({
      description:
        "Search across document text content within a " +
        "matter. Returns matching passages from documents " +
        "with document name and entity ID. Use this to find " +
        "specific clauses, terms, or information across " +
        "all documents without reading each one individually.",
      inputSchema: z.object({
        workspaceId: wsSchema,
        query: z
          .string()
          .max(LIMITS.searchQueryMaxLength)
          .describe("Text or keywords to search for"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .default(5)
          .describe("Max results (default: 5)"),
      }),
      execute: safeExecute(async ({ workspaceId, query, limit }) => {
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
      }),
    }),
  };
};

// -----------------------------------------------------------------
// Org-level tools (always available)
// -----------------------------------------------------------------

type OrgToolsContext = {
  organizationId: SafeId<"organization">;
};

export const createOrgTools = ({ organizationId }: OrgToolsContext) => ({
  searchAcrossMatters: tool({
    description:
      "Search for documents across ALL matters in the " +
      "organization. Only use this when the user explicitly " +
      "asks to search outside the current matter.",
    inputSchema: z.object({
      query: z
        .string()
        .max(LIMITS.searchQueryMaxLength)
        .describe("Search query (keywords or phrases)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .default(10)
        .describe("Max results to return"),
    }),
    execute: safeExecute(async ({ query, limit }) => {
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
    }),
  }),

  readContentAcrossMatters: tool({
    description:
      "Read the extracted text content of a document from " +
      "any matter. Use after searchAcrossMatters finds a " +
      "document outside the current matter.",
    inputSchema: z.object({
      entityId: z.string().describe("The entity ID whose content to read"),
    }),
    execute: safeExecute(async ({ entityId }) => {
      const row = await db.query.extractedContent.findFirst({
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
      });

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
    }),
  }),

  readContact: tool({
    description: "Get details about a contact (person or organization).",
    inputSchema: z.object({
      contactId: z.string().describe("The contact ID to read"),
    }),
    execute: async ({ contactId }) => {
      const contact = await db.query.contacts.findFirst({
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
      });

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

  listTemplates: tool({
    description: "List available document templates.",
    inputSchema: z.object({
      query: z.string().optional().describe("Filter by name (substring match)"),
      limit: z.number().int().min(1).max(50).optional().default(20),
    }),
    execute: async ({ query, limit }) => {
      const templates = await db.query.templates.findMany({
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
      });

      return templates.map((t) => ({
        templateId: t.id,
        name: t.name,
        fileName: t.fileName,
        createdAt: t.createdAt.toISOString(),
      }));
    },
  }),

  readClause: tool({
    description: "Read a legal clause including its full text body.",
    inputSchema: z.object({
      clauseId: z.string().describe("The clause ID to read"),
    }),
    execute: async ({ clauseId }) => {
      const clause = await db.query.clauses.findFirst({
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
      });

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

  askUser: tool({
    description:
      "Ask the user clarifying questions before executing " +
      "a complex task. Use this when the request is " +
      "ambiguous or requires decisions you cannot make " +
      "alone (jurisdiction, parties, preferences, scope). " +
      "The UI renders the questions automatically. Once " +
      "the user answers, synthesize their input into a " +
      "plan and execute it.",
    inputSchema: z.object({
      analysis: z
        .string()
        .describe(
          "Brief analysis of the task and what you " +
            "already know from context",
        ),
      questions: z
        .array(
          z.object({
            question: z.string(),
            reason: z.string().describe("Why this matters for the task"),
            options: z
              .array(z.string())
              .optional()
              .describe(
                "Suggested options (A/B/C style). The " +
                  "user can also write their own answer.",
              ),
            default: z
              .string()
              .optional()
              .describe("Preselected option or default value"),
          }),
        )
        .min(1)
        .max(10)
        .describe("Clarifying questions to ask"),
    }),
    execute: async ({ analysis, questions }) => ({
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
): Promise<SafeId<"workspace">[]> => {
  if (rawIds.length === 0) {
    return [];
  }

  const rows = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(
      and(
        inArray(workspaces.id, rawIds),
        eq(workspaces.organizationId, organizationId),
      ),
    );

  return rows.map((w) => toSafeId<"workspace">(w.id));
};
