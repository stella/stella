import { panic, Result } from "better-result";

import type { SafeDb } from "@/api/db";
import { buildChatSourceDocument } from "@/api/handlers/chat/tools/chat-source-document";
import { createToolFunction } from "@/api/handlers/chat/tools/execute/execute-tool-function";
import { buildPaginatedResult } from "@/api/handlers/chat/tools/execute/pagination";
import {
  getMatterEntitiesContract,
  getMatterEntityContentsContract,
  getMatterPropertiesContract,
  listMatterEntitiesContract,
  listMatterPropertiesContract,
} from "@/api/handlers/chat/tools/execute/workspace-manifest";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { decryptContent } from "@/api/lib/content-encryption";
import { ChatToolError } from "@/api/lib/errors/tagged-errors";
import { deserializeAITool } from "@/api/lib/markdown/ai-tool";

import { getScopedWorkspaceIds } from "./utils";

const CONTENT_MAX_CHARS = 8000;

const toSafeEntityIds = (ids: string[]) =>
  ids.map((id) => toSafeId<"entity">(id));

const toSafePropertyIds = (ids: string[]) =>
  ids.map((id) => toSafeId<"property">(id));

type WorkspaceFunctionContext = {
  allowedWorkspaceIds: SafeId<"workspace">[];
  organizationId: SafeId<"organization">;
  safeDb: SafeDb;
};

export const createReadonlyWorkspaceFunctionRegistry = ({
  organizationId,
  safeDb,
  allowedWorkspaceIds,
}: WorkspaceFunctionContext) => ({
  [listMatterPropertiesContract.name]: createToolFunction(
    listMatterPropertiesContract,
    async function* (input) {
      const scopedWorkspaceIds = yield* getScopedWorkspaceIds(
        allowedWorkspaceIds,
        input.matterIds,
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
            matterId: property.workspaceId,
            name: property.name,
            propertyId: property.id,
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
      const scopedWorkspaceIds = yield* getScopedWorkspaceIds(
        allowedWorkspaceIds,
        input.matterIds,
      );
      const propertyIds = toSafePropertyIds(input.propertyIds);

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

      return Result.ok(
        properties.map((property) => ({
          content: property.content,
          createdAt: property.createdAt.toISOString(),
          matterId: property.workspaceId,
          name: property.name,
          propertyId: property.id,
          status: property.status,
          tool:
            property.tool.type === "ai-model"
              ? deserializeAITool({
                  ...property.tool,
                  dependencies: property.dependencies,
                })
              : property.tool,
          type: property.content.type,
        })),
      );
    },
  ),

  [listMatterEntitiesContract.name]: createToolFunction(
    listMatterEntitiesContract,
    async function* (input) {
      const scopedWorkspaceIds = yield* getScopedWorkspaceIds(
        allowedWorkspaceIds,
        input.matterIds,
      );
      const offset = input.offset ?? 0;
      const parentId = input.parentId
        ? toSafeId<"entity">(input.parentId)
        : undefined;

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

            return {
              entityId: entity.id,
              fields: entity.currentVersion.fields.map((field) => ({
                content: field.content,
                propertyId: field.propertyId,
              })),
              kind: entity.kind,
              matterId: entity.workspaceId,
              name: entity.name ?? "Untitled",
              parentId: entity.parentId,
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
      const scopedWorkspaceIds = yield* getScopedWorkspaceIds(
        allowedWorkspaceIds,
        input.matterIds,
      );
      const entityIds = toSafeEntityIds(input.entityIds);

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

      return Result.ok(
        entities.map((entity) => {
          if (!entity.currentVersion) {
            panic("Entity has no currentVersion");
          }

          const currentVersion = entity.currentVersion;

          return {
            createdAt: entity.createdAt.toISOString(),
            createdBy: entity.createdByUser?.name ?? null,
            entityId: entity.id,
            fields: currentVersion.fields.map((field) => ({
              content: field.content,
              propertyId: field.propertyId,
            })),
            kind: entity.kind,
            matterId: entity.workspaceId,
            name: entity.name ?? "Untitled",
            parentId: entity.parentId,
            sourceDocument: buildChatSourceDocument({
              entityId: entity.id,
              fields: currentVersion.fields,
              kind: entity.kind,
              name: entity.name,
              workspaceId: entity.workspaceId,
            }),
            versionCount: entity.versions.length,
          };
        }),
      );
    },
  ),

  [getMatterEntityContentsContract.name]: createToolFunction(
    getMatterEntityContentsContract,
    async function* (input) {
      const scopedWorkspaceIds = yield* getScopedWorkspaceIds(
        allowedWorkspaceIds,
        input.matterIds,
      );
      const entityIds = toSafeEntityIds(input.entityIds);

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

              return {
                charCount: row.charCount,
                entityId: row.entityId,
                matterId: row.workspaceId,
                name: entity?.name ?? null,
                sourceDocument: buildChatSourceDocument({
                  entityId: row.entityId,
                  fields: fieldsForSource,
                  kind: entity?.kind,
                  name: entity?.name,
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

      return Result.ok(items);
    },
  ),
});
