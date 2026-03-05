import { tool } from "ai";
import { z } from "zod";

import { db } from "@/api/db";
import type { FieldContent } from "@/api/db/schema-validators";
import type { SafeId } from "@/api/lib/branded-types";
import { decryptContent } from "@/api/lib/content-encryption";
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

type MatterToolsContext = {
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
};

export const createMatterTools = ({
  workspaceId,
  organizationId,
}: MatterToolsContext) => ({
  searchMatter: tool({
    description:
      "Search for documents and files within the current " +
      "matter using full-text search. Returns matching " +
      "entity names with highlighted excerpts.",
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

  listEntities: tool({
    description:
      "List documents, files, tasks, and folders in the " +
      "current matter. Returns names, types, dates, and " +
      "custom property values (metadata columns).",
    inputSchema: z.object({
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
    execute: async ({ kind, parentId, limit }) => {
      const [entities, properties] = await Promise.all([
        db.query.entities.findMany({
          where: {
            workspaceId: {
              eq: workspaceId,
            },
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
          where: {
            workspaceId: {
              eq: workspaceId,
            },
          },
          columns: { id: true, name: true },
        }),
      ]);
      const propNameById = new Map(properties.map((p) => [p.id, p.name]));

      return entities.map((entity) => ({
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
      entityId: z.string().describe("The entity ID to read"),
    }),
    execute: async ({ entityId }) => {
      const entity = await db.query.entities.findFirst({
        where: {
          id: entityId,
          workspaceId: {
            eq: workspaceId,
          },
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
          createdByUser: {
            columns: { name: true },
          },
          versions: {
            columns: { id: true },
          },
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
        where: {
          workspaceId: {
            eq: workspaceId,
          },
        },
        columns: { id: true, name: true },
      });
      const propNameById = new Map(properties.map((p) => [p.id, p.name]));

      return {
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
            columns: { workspaceId: true },
          },
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
        entityId,
        charCount: row.charCount,
        truncated,
        text,
      };
    },
  }),
});
