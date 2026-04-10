import { valibotSchema } from "@ai-sdk/valibot";
// oxlint-disable-next-line no-restricted-imports
import { tool } from "ai";
import * as v from "valibot";

import type { ScopedDb } from "@/api/db";
import { buildChatSourceDocument } from "@/api/handlers/chat/tools/chat-source-document";
import type { SafeId } from "@/api/lib/branded-types";
import { decryptContent } from "@/api/lib/content-encryption";
import { ChatToolError } from "@/api/lib/errors/tagged-errors";
import { escapeLike } from "@/api/lib/escape-like";
import { LIMITS } from "@/api/lib/limits";
import { getSearchProvider } from "@/api/lib/search/provider";

const CONTENT_MAX_CHARS = 8000;

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
  "search-across-matters": tool({
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

  "read-content-across-matters": tool({
    description:
      "Read the extracted text content of a document from " +
      "any matter. Use after search-across-matters finds a " +
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
          message: "No extracted content available for this entity.",
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
        workspaceId: row.entity?.workspaceId ?? null,
        name: row.entity?.name ?? null,
        charCount: row.charCount,
        sourceDocument: buildChatSourceDocument({
          entityId,
          fields: row.entity?.currentVersion?.fields,
          kind: row.entity?.kind,
          name: row.entity?.name,
          workspaceId: row.entity?.workspaceId ?? null,
        }),
        truncated,
        text,
      };
    },
  }),

  "read-contact": tool({
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
        throw new ChatToolError({ message: "Contact not found" });
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

  "list-templates": tool({
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

  "read-clause": tool({
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
        throw new ChatToolError({ message: "Clause not found" });
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

  "ask-user": tool({
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
