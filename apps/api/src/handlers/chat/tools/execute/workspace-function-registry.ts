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
} from "@/api/handlers/chat/tools/execute/workspace-manifest";
import type { SafeId } from "@/api/lib/branded-types";
import { decryptContent } from "@/api/lib/content-encryption";
import { ChatToolError } from "@/api/lib/errors/tagged-errors";
import { deserializeAITool } from "@/api/lib/markdown/ai-tool";

const CONTENT_MAX_CHARS = 8000;

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
      const scopedWorkspaceIds = yield* refRegistry
        .resolveMatterRefs(input.matterRefs)
        .andThen((workspaceIds) =>
          ensureAllowedWorkspaceIds({ allowedWorkspaceIds, workspaceIds }),
        );
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
      const scopedWorkspaceIds = yield* refRegistry
        .resolveMatterRefs(input.matterRefs)
        .andThen((workspaceIds) =>
          ensureAllowedWorkspaceIds({ allowedWorkspaceIds, workspaceIds }),
        );
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
      const scopedWorkspaceIds = yield* refRegistry
        .resolveMatterRefs(input.matterRefs)
        .andThen((workspaceIds) =>
          ensureAllowedWorkspaceIds({ allowedWorkspaceIds, workspaceIds }),
        );
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

            const name = entity.name ?? "Untitled";

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
      const scopedWorkspaceIds = yield* refRegistry
        .resolveMatterRefs(input.matterRefs)
        .andThen((workspaceIds) =>
          ensureAllowedWorkspaceIds({ allowedWorkspaceIds, workspaceIds }),
        );
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

          const name = entity.name ?? "Untitled";

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
      const scopedWorkspaceIds = yield* refRegistry
        .resolveMatterRefs(input.matterRefs)
        .andThen((workspaceIds) =>
          ensureAllowedWorkspaceIds({ allowedWorkspaceIds, workspaceIds }),
        );
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
});
