import { tool } from "ai";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/api/db";
import { workspaces } from "@/api/db/schema";
import type { FieldContent } from "@/api/db/schema-validators";
// biome-ignore lint/style/noRestrictedImports: brands actor-validated IDs
import { toSafeId, type SafeId } from "@/api/lib/branded-types";
import { decryptContent } from "@/api/lib/content-encryption";
import { escapeLike } from "@/api/lib/escape-like";
import { LIMITS } from "@/api/lib/limits";
import { getSearchProvider } from "@/api/lib/search/provider";

const CONTENT_MAX_CHARS = 8000;

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
      execute: async ({ workspaceId, query, limit }) => {
        const provider = getSearchProvider();
        const result = await provider.search({
          query,
          organizationId,
          workspaceId,
          limit,
        });
        return {
          workspaceId,
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
              createdAt: true,
              updatedAt: true,
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

        return ents.map((entity) => ({
          workspaceId,
          entityId: entity.id,
          kind: entity.kind,
          name: entity.name,
          parentId: entity.parentId,
          createdAt: entity.createdAt.toISOString(),
          updatedAt: entity.updatedAt?.toISOString() ?? null,
          fields:
            entity.currentVersion?.fields
              .map((f) => ({
                property: propNameById.get(f.propertyId) ?? f.propertyId,
                value: formatFieldValue(f.content),
              }))
              .filter((f) => f.value !== "") ?? [],
        }));
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
          workspaceId,
          entityId: entity.id,
          kind: entity.kind,
          name: entity.name,
          parentId: entity.parentId,
          createdAt: entity.createdAt.toISOString(),
          updatedAt: entity.updatedAt?.toISOString() ?? null,
          createdBy: entity.createdByUser?.name ?? null,
          versionCount: entity.versions.length,
          fields:
            entity.currentVersion?.fields
              .map((f) => ({
                property: propNameById.get(f.propertyId) ?? f.propertyId,
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
      execute: async ({ workspaceId, entityId }) => {
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
              "No extracted content available for this entity. " +
              "The file may not have been processed yet or its " +
              "format is not supported for text extraction.",
          };
        }

        if (row.entity?.workspaceId !== workspaceId) {
          return { error: "Entity not found in this matter" };
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
          workspaceId,
          entityId,
          charCount: row.charCount,
          truncated,
          text,
        };
      },
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
          workspaceId,
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

  readContentAcrossMatters: tool({
    description:
      "Read the extracted text content of a document from " +
      "any matter. Use after searchAcrossMatters finds a " +
      "document outside the current matter.",
    inputSchema: z.object({
      entityId: z.string().describe("The entity ID whose content to read"),
    }),
    execute: async ({ entityId }) => {
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
    },
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
