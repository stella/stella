import { panic, Result } from "better-result";

import type { SafeDb } from "@/api/db";
import { buildChatSourceDocument } from "@/api/handlers/chat/tools/chat-source-document";
import { createToolFunction } from "@/api/handlers/chat/tools/execute/execute-tool-function";
import { buildPaginatedResult } from "@/api/handlers/chat/tools/execute/pagination";
import type { ChatRefRegistry } from "@/api/handlers/chat/tools/execute/ref-registry";
import { ensureAllowedWorkspaceIds } from "@/api/handlers/chat/tools/execute/utils";
import {
  getMatterEntitiesContract,
  getMatterEntityContentsContract,
  getMatterPropertiesContract,
  listMatterEntitiesContract,
  listMatterPropertiesContract,
  searchInEntityContentContract,
} from "@/api/handlers/chat/tools/execute/workspace-manifest";
import type { SafeId } from "@/api/lib/branded-types";
import { decryptContent } from "@/api/lib/content-encryption";
import { ChatToolError } from "@/api/lib/errors/tagged-errors";
import { deserializeAITool } from "@/api/lib/markdown/ai-tool";

const CONTENT_MAX_CHARS = 8000;

/**
 * Window of context to include on each side of a search hit
 * returned by `searchInEntityContent`. 200 + 200 + query length
 * is enough to read a full sentence around most matches without
 * blowing up the AI's token budget.
 */
const SEARCH_SNIPPET_CONTEXT_CHARS = 200;

/**
 * Hard cap on how many matches the search scans for per entity,
 * regardless of the requested `limit`. Prevents pathological queries
 * (a single space, a single common letter) from walking the whole
 * doc. `totalHits` clamps to this value and is reported back so the
 * model knows when it should narrow its query.
 */
const SEARCH_MAX_HITS_SCANNED = 100;

/**
 * Escape a literal substring so it can be embedded into a `RegExp`.
 * The caller wants to search for the user's query verbatim, not as
 * a regex pattern, so any regex metacharacter is neutralised.
 */
const escapeRegExp = (value: string): string =>
  // eslint-disable-next-line require-unicode-regexp -- u flag rejected by @valibot/to-json-schema elsewhere; keeping policy consistent here.
  value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");

type SearchHit = { position: number; snippet: string };
type SearchResult = {
  hits: SearchHit[];
  totalHits: number;
  truncated: boolean;
};

const findHitsInText = (
  text: string,
  query: string,
  options: { caseSensitive: boolean; limit: number; wholeWord: boolean },
): SearchResult => {
  const flags = options.caseSensitive ? "g" : "gi";
  const escaped = escapeRegExp(query);
  const pattern = options.wholeWord
    ? `(?:^|[^\\p{L}\\p{N}])(${escaped})(?=$|[^\\p{L}\\p{N}])`
    : `(${escaped})`;
  // Unicode flag (`u`) is appended explicitly so `\p{L}` / `\p{N}`
  // whole-word boundaries cover non-ASCII alphabets used in legal
  // docs (the rule only fires on `new RegExp(literal)` without `u`).
  const re = new RegExp(pattern, `${flags}u`);
  const hits: SearchHit[] = [];
  let totalHits = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    // Capture group 1 always exists because the pattern wraps the
    // escaped query in `(...)`. Narrowing here keeps the helper
    // self-contained without a runtime branch.
    const captured = match[1] ?? panic("search match missing capture group");
    totalHits++;
    if (hits.length < options.limit) {
      const hitStart = match.index + (match[0].length - captured.length);
      const snippetStart = Math.max(0, hitStart - SEARCH_SNIPPET_CONTEXT_CHARS);
      const snippetEnd = Math.min(
        text.length,
        hitStart + captured.length + SEARCH_SNIPPET_CONTEXT_CHARS,
      );
      hits.push({
        position: hitStart,
        snippet: text.slice(snippetStart, snippetEnd),
      });
    }
    if (totalHits >= SEARCH_MAX_HITS_SCANNED) {
      break;
    }
    // Guard against zero-width matches (shouldn't happen with a
    // non-empty `query`, but cheap insurance against an infinite loop).
    if (match.index === re.lastIndex) {
      re.lastIndex++;
    }
  }
  return {
    hits,
    totalHits,
    truncated: hits.length < totalHits,
  };
};

type WorkspaceFunctionContext = {
  allowedWorkspaceIds: SafeId<"workspace">[];
  organizationId: SafeId<"organization">;
  refRegistry: ChatRefRegistry;
  safeDb: SafeDb;
};

type SourceDocumentRefProps = {
  entityId: SafeId<"entity">;
  fields?: Parameters<typeof buildChatSourceDocument>[0]["fields"];
  kind?: string | null | undefined;
  name?: string | null | undefined;
  refRegistry: ChatRefRegistry;
  workspaceId: SafeId<"workspace">;
};

const buildChatSourceDocumentWithRefs = ({
  entityId,
  fields,
  kind,
  name,
  refRegistry,
  workspaceId,
}: SourceDocumentRefProps) => {
  const sourceDocument = buildChatSourceDocument({
    entityId,
    fields,
    kind,
    name,
    workspaceId,
  });

  return {
    ...sourceDocument,
    entityRef: refRegistry.toEntityRef({ entityId, workspaceId }),
    matterRef: refRegistry.toMatterRef(workspaceId),
    mention: refRegistry.toEntityMention({
      entityId,
      label: sourceDocument.title,
      workspaceId,
    }),
  };
};

export const createReadonlyWorkspaceFunctionRegistry = ({
  organizationId,
  refRegistry,
  safeDb,
  allowedWorkspaceIds,
}: WorkspaceFunctionContext) => ({
  [listMatterPropertiesContract.name]: createToolFunction(
    listMatterPropertiesContract,
    async function* (input) {
      const workspaceIds = yield* refRegistry.resolveMatterRefs(
        input.matterRefs,
      );
      const scopedWorkspaceIds = yield* ensureAllowedWorkspaceIds({
        allowedWorkspaceIds,
        workspaceIds,
      });
      const offset = input.offset ?? 0;

      const properties = yield* await safeDb((tx) =>
        tx.query.properties.findMany({
          where: {
            workspaceId: { in: scopedWorkspaceIds },
          },
          columns: {
            id: true,
            name: true,
            status: true,
            content: true,
            workspaceId: true,
          },
          orderBy: {
            createdAt: "asc",
          },
          limit: input.limit + 1,
          offset,
        }),
      );

      return Result.ok(
        buildPaginatedResult({
          items: properties.map((property) => ({
            matterRef: refRegistry.toMatterRef(property.workspaceId),
            name: property.name,
            propertyRef: refRegistry.toPropertyRef(property.id),
            status: property.status,
            type: property.content.type,
          })),
          limit: input.limit,
          offset,
        }),
      );
    },
  ),

  [getMatterPropertiesContract.name]: createToolFunction(
    getMatterPropertiesContract,
    async function* (input) {
      const workspaceIds = yield* refRegistry.resolveMatterRefs(
        input.matterRefs,
      );
      const scopedWorkspaceIds = yield* ensureAllowedWorkspaceIds({
        allowedWorkspaceIds,
        workspaceIds,
      });
      const propertyIds = yield* refRegistry.resolvePropertyRefs(
        input.propertyRefs,
      );

      const properties = yield* await safeDb((tx) =>
        tx.query.properties.findMany({
          where: {
            id: { in: propertyIds },
            workspaceId: { in: scopedWorkspaceIds },
          },
          columns: {
            id: true,
            name: true,
            status: true,
            content: true,
            tool: true,
            workspaceId: true,
            createdAt: true,
          },
          with: {
            dependencies: {
              columns: {
                condition: true,
                dependsOnPropertyId: true,
              },
            },
          },
          orderBy: {
            createdAt: "asc",
          },
        }),
      );

      return Result.ok({
        items: properties.map((property) => ({
          content: property.content,
          createdAt: property.createdAt.toISOString(),
          matterRef: refRegistry.toMatterRef(property.workspaceId),
          name: property.name,
          propertyRef: refRegistry.toPropertyRef(property.id),
          status: property.status,
          tool:
            property.tool.type === "ai-model"
              ? {
                  ...deserializeAITool({
                    ...property.tool,
                    dependencies: property.dependencies,
                  }),
                  dependencies: property.dependencies.map((dependency) => ({
                    condition: dependency.condition,
                    dependsOnPropertyRef: refRegistry.toPropertyRef(
                      dependency.dependsOnPropertyId,
                    ),
                  })),
                }
              : property.tool,
          type: property.content.type,
        })),
      });
    },
  ),

  [listMatterEntitiesContract.name]: createToolFunction(
    listMatterEntitiesContract,
    async function* (input) {
      const workspaceIds = yield* refRegistry.resolveMatterRefs(
        input.matterRefs,
      );
      const scopedWorkspaceIds = yield* ensureAllowedWorkspaceIds({
        allowedWorkspaceIds,
        workspaceIds,
      });
      const offset = input.offset ?? 0;
      const parentId = yield* refRegistry.resolveParentRef(input.parentRef);

      const entities = yield* await safeDb((tx) =>
        tx.query.entities.findMany({
          where: {
            ...(input.kind ? { kind: input.kind } : {}),
            ...(parentId ? { parentId: { eq: parentId } } : {}),
            workspaceId: { in: scopedWorkspaceIds },
          },
          columns: {
            id: true,
            kind: true,
            name: true,
            parentId: true,
            workspaceId: true,
          },
          with: {
            currentVersion: {
              columns: { id: true },
              with: {
                fields: {
                  columns: {
                    content: true,
                    propertyId: true,
                  },
                },
              },
            },
          },
          orderBy: {
            createdAt: "asc",
          },
          limit: input.limit + 1,
          offset,
        }),
      );

      return Result.ok(
        buildPaginatedResult({
          items: entities.map((entity) => {
            if (!entity.currentVersion) {
              panic("Entity has no currentVersion");
            }

            const name = entity.name;

            return {
              entityRef: refRegistry.toEntityRef({
                entityId: entity.id,
                workspaceId: entity.workspaceId,
              }),
              fields: entity.currentVersion.fields.map((field) => ({
                content: field.content,
                propertyRef: refRegistry.toPropertyRef(field.propertyId),
              })),
              kind: entity.kind,
              matterRef: refRegistry.toMatterRef(entity.workspaceId),
              mention: refRegistry.toEntityMention({
                entityId: entity.id,
                label: name,
                workspaceId: entity.workspaceId,
              }),
              name,
              parentRef: entity.parentId
                ? refRegistry.toEntityRef({
                    entityId: entity.parentId,
                    workspaceId: entity.workspaceId,
                  })
                : null,
            };
          }),
          limit: input.limit,
          offset,
        }),
      );
    },
  ),

  [getMatterEntitiesContract.name]: createToolFunction(
    getMatterEntitiesContract,
    async function* (input) {
      const workspaceIds = yield* refRegistry.resolveMatterRefs(
        input.matterRefs,
      );
      const scopedWorkspaceIds = yield* ensureAllowedWorkspaceIds({
        allowedWorkspaceIds,
        workspaceIds,
      });
      const entityIds = yield* refRegistry.resolveEntityRefs(input.entityRefs);

      const entities = yield* await safeDb((tx) =>
        tx.query.entities.findMany({
          where: {
            id: { in: entityIds },
            workspaceId: { in: scopedWorkspaceIds },
          },
          columns: {
            id: true,
            kind: true,
            name: true,
            parentId: true,
            workspaceId: true,
            createdAt: true,
          },
          with: {
            createdByUser: { columns: { name: true } },
            versions: { columns: { id: true } },
            currentVersion: {
              columns: { id: true },
              with: {
                fields: {
                  columns: {
                    content: true,
                    propertyId: true,
                  },
                },
              },
            },
          },
          orderBy: {
            createdAt: "asc",
          },
        }),
      );

      return Result.ok({
        items: entities.map((entity) => {
          if (!entity.currentVersion) {
            panic("Entity has no currentVersion");
          }

          const currentVersion = entity.currentVersion;

          const name = entity.name;

          return {
            createdAt: entity.createdAt.toISOString(),
            createdBy: entity.createdByUser?.name ?? null,
            entityRef: refRegistry.toEntityRef({
              entityId: entity.id,
              workspaceId: entity.workspaceId,
            }),
            fields: currentVersion.fields.map((field) => ({
              content: field.content,
              propertyRef: refRegistry.toPropertyRef(field.propertyId),
            })),
            kind: entity.kind,
            matterRef: refRegistry.toMatterRef(entity.workspaceId),
            mention: refRegistry.toEntityMention({
              entityId: entity.id,
              label: name,
              workspaceId: entity.workspaceId,
            }),
            name,
            parentRef: entity.parentId
              ? refRegistry.toEntityRef({
                  entityId: entity.parentId,
                  workspaceId: entity.workspaceId,
                })
              : null,
            sourceDocument: buildChatSourceDocumentWithRefs({
              entityId: entity.id,
              fields: currentVersion.fields,
              kind: entity.kind,
              name: entity.name,
              refRegistry,
              workspaceId: entity.workspaceId,
            }),
            versionCount: entity.versions.length,
          };
        }),
      });
    },
  ),

  [getMatterEntityContentsContract.name]: createToolFunction(
    getMatterEntityContentsContract,
    async function* (input) {
      const workspaceIds = yield* refRegistry.resolveMatterRefs(
        input.matterRefs,
      );
      const scopedWorkspaceIds = yield* ensureAllowedWorkspaceIds({
        allowedWorkspaceIds,
        workspaceIds,
      });
      const entityIds = yield* refRegistry.resolveEntityRefs(input.entityRefs);

      const contentRows = yield* await safeDb((tx) =>
        tx.query.extractedContent.findMany({
          where: {
            entityId: { in: entityIds },
            organizationId: { eq: organizationId },
            workspaceId: { in: scopedWorkspaceIds },
          },
          columns: {
            charCount: true,
            ciphertext: true,
            entityId: true,
            extractedAt: true,
            iv: true,
            workspaceId: true,
          },
          with: {
            entity: {
              columns: {
                kind: true,
                name: true,
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
          orderBy: {
            extractedAt: "asc",
          },
        }),
      );

      const items = yield* await Result.tryPromise({
        try: async () =>
          await Promise.all(
            contentRows.map(async (row) => {
              const plaintext = await decryptContent(
                organizationId,
                row.ciphertext,
                row.iv,
              );
              const truncated = plaintext.length > CONTENT_MAX_CHARS;

              const entity = row.entity;
              const fieldsForSource = entity?.currentVersion?.fields;
              const name = entity?.name ?? null;

              return {
                charCount: row.charCount,
                entityRef: refRegistry.toEntityRef({
                  entityId: row.entityId,
                  workspaceId: row.workspaceId,
                }),
                matterRef: refRegistry.toMatterRef(row.workspaceId),
                mention: refRegistry.toEntityMention({
                  entityId: row.entityId,
                  label: name ?? "Untitled",
                  workspaceId: row.workspaceId,
                }),
                name,
                sourceDocument: buildChatSourceDocumentWithRefs({
                  entityId: row.entityId,
                  fields: fieldsForSource,
                  kind: entity?.kind,
                  name: entity?.name,
                  refRegistry,
                  workspaceId: row.workspaceId,
                }),
                text: truncated
                  ? plaintext.slice(0, CONTENT_MAX_CHARS)
                  : plaintext,
                truncated,
              };
            }),
          ),
        catch: (cause) =>
          new ChatToolError({
            message: "Failed to load extracted content.",
            cause,
          }),
      });

      return Result.ok({ items });
    },
  ),

  [searchInEntityContentContract.name]: createToolFunction(
    searchInEntityContentContract,
    async function* (input) {
      const workspaceIds = yield* refRegistry.resolveMatterRefs(
        input.matterRefs,
      );
      const scopedWorkspaceIds = yield* ensureAllowedWorkspaceIds({
        allowedWorkspaceIds,
        workspaceIds,
      });
      const entityIds = yield* refRegistry.resolveEntityRefs(input.entityRefs);

      const contentRows = yield* await safeDb((tx) =>
        tx.query.extractedContent.findMany({
          where: {
            entityId: { in: entityIds },
            organizationId: { eq: organizationId },
            workspaceId: { in: scopedWorkspaceIds },
          },
          columns: {
            charCount: true,
            ciphertext: true,
            entityId: true,
            extractedAt: true,
            iv: true,
            workspaceId: true,
          },
          with: {
            entity: {
              columns: {
                kind: true,
                name: true,
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
          orderBy: {
            extractedAt: "asc",
          },
        }),
      );

      const items = yield* await Result.tryPromise({
        try: async () =>
          await Promise.all(
            contentRows.map(async (row) => {
              const plaintext = await decryptContent(
                organizationId,
                row.ciphertext,
                row.iv,
              );
              const entity = row.entity;
              const fieldsForSource = entity?.currentVersion?.fields;
              const name = entity?.name ?? null;
              const { hits, totalHits, truncated } = findHitsInText(
                plaintext,
                input.query,
                {
                  caseSensitive: input.caseSensitive,
                  limit: input.limit,
                  wholeWord: input.wholeWord,
                },
              );

              return {
                charCount: row.charCount,
                entityRef: refRegistry.toEntityRef({
                  entityId: row.entityId,
                  workspaceId: row.workspaceId,
                }),
                hits,
                matterRef: refRegistry.toMatterRef(row.workspaceId),
                mention: refRegistry.toEntityMention({
                  entityId: row.entityId,
                  label: name ?? "Untitled",
                  workspaceId: row.workspaceId,
                }),
                name,
                sourceDocument: buildChatSourceDocumentWithRefs({
                  entityId: row.entityId,
                  fields: fieldsForSource,
                  kind: entity?.kind,
                  name: entity?.name,
                  refRegistry,
                  workspaceId: row.workspaceId,
                }),
                totalHits,
                truncated,
              };
            }),
          ),
        catch: (cause) =>
          new ChatToolError({
            message: "Failed to search extracted content.",
            cause,
          }),
      });

      return Result.ok({ items });
    },
  ),
});
