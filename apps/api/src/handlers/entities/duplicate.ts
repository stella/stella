import { Result } from "better-result";
import { t } from "elysia";
import type { Static } from "elysia";

import type { SafeDb } from "@/api/db";
import {
  copyEntities,
  getFolderSubtree,
} from "@/api/handlers/entities/copy-utils";
import { captureError } from "@/api/lib/analytics";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createAuditContext } from "@/api/lib/audit-log";
import type { AuditContext } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { processExtraction } from "@/api/lib/search/process-extraction";

const duplicateEntityBodySchema = t.Object({
  entityId: tSafeId("entity"),
});

type DuplicateEntityHandlerProps = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  auditContext: AuditContext;
  body: Static<typeof duplicateEntityBodySchema>;
};

const duplicateEntityHandler = async function* ({
  safeDb,
  workspaceId,
  userId,
  auditContext,
  body: { entityId: sourceEntityId },
}: DuplicateEntityHandlerProps) {
  const source = yield* Result.await(
    safeDb((tx) =>
      tx.query.entities.findFirst({
        where: { id: { eq: sourceEntityId }, workspaceId: { eq: workspaceId } },
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
  );

  if (!source) {
    return Result.err(
      new HandlerError({ status: 404, message: "Entity not found" }),
    );
  }

  const txResult = yield* Result.await(
    safeDb(async (tx) => {
      if (source.kind !== "folder") {
        return await copyEntities({
          tx,
          targetWorkspaceId: workspaceId,
          targetParentId: source.parentId,
          userId,
          auditContext,
          sourceEntityId,
          sourceEntities: [source],
        });
      }

      const workspaceEntities = await tx.query.entities.findMany({
        where: { workspaceId: { eq: workspaceId } },
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
        limit: LIMITS.entitiesCount,
      });

      const subtree = getFolderSubtree(workspaceEntities, sourceEntityId);
      if (!subtree) {
        return {
          ok: false as const,
          status: 404 as const,
          message: "Entity not found",
        };
      }

      return await copyEntities({
        tx,
        targetWorkspaceId: workspaceId,
        targetParentId: source.parentId,
        userId,
        auditContext,
        sourceEntityId,
        sourceEntities: subtree,
      });
    }),
  );

  if (!txResult.ok) {
    return Result.err(
      new HandlerError({ status: txResult.status, message: txResult.message }),
    );
  }

  for (const entityId of txResult.entityIds) {
    processExtraction(entityId).catch(captureError);
  }

  return Result.ok({ entityId: txResult.entityId });
};

const config = {
  permissions: { entity: ["create"] },
  body: duplicateEntityBodySchema,
} satisfies HandlerConfig;

const duplicateEntity = createSafeHandler(
  config,
  async function* ({
    safeDb,
    session,
    workspaceId,
    user,
    request,
    server,
    body,
  }) {
    return yield* duplicateEntityHandler({
      safeDb,
      workspaceId,
      userId: user.id,
      auditContext: createAuditContext({
        organizationId: session.activeOrganizationId,
        workspaceId,
        userId: user.id,
        request,
        server,
      }),
      body,
    });
  },
);

export default duplicateEntity;
