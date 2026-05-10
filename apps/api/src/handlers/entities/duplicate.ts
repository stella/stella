import { Result } from "better-result";
import { and, eq, isNull, like } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import type { SafeDb, Transaction } from "@/api/db";
import { entities, entityVersions, fields, workspaces } from "@/api/db/schema";
import type { EntityKind, FieldContent } from "@/api/db/schema-validators";
import { captureError } from "@/api/lib/analytics";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createAuditContext,
  writeAuditLog,
} from "@/api/lib/audit-log";
import type { AuditContext } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { allocateEntityStamp } from "@/api/lib/document-counter";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { escapeLike } from "@/api/lib/escape-like";
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

/** Escape regex metacharacters. */
const escapeRegex = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const trailingSuffixRe = /_\d+$/;

type ResolveEntityNameProps = {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  parentId: SafeId<"entity"> | null;
  name: string;
};

type EntityFieldSnapshot = {
  propertyId: SafeId<"property">;
  content: FieldContent;
};

type EntitySnapshot = {
  id: SafeId<"entity">;
  kind: EntityKind;
  name: string;
  parentId: SafeId<"entity"> | null;
  currentVersion: {
    fields: EntityFieldSnapshot[];
  } | null;
};

type DuplicatedEntity = {
  sourceId: SafeId<"entity">;
  entityId: SafeId<"entity">;
  kind: EntityKind;
  name: string;
  parentId: SafeId<"entity"> | null;
};

/**
 * Generate a unique entity name by appending `_N` suffix.
 * Splits on the last dot to preserve file extensions:
 *   "Report.pdf" → "Report_1.pdf", "Report_2.pdf", …
 *   "My Folder"  → "My Folder_1", "My Folder_2", …
 * Strips any existing `_N` suffix before computing the
 * next number so re-duplicating "Report_1" still increments
 * from the highest sibling, not from the stripped base.
 */
const resolveEntityName = async ({
  tx,
  workspaceId,
  parentId,
  name,
}: ResolveEntityNameProps): Promise<string> => {
  const lastDot = name.lastIndexOf(".");
  const hasExt = lastDot > 0;
  const rawBase = hasExt ? name.slice(0, lastDot) : name;
  const ext = hasExt ? name.slice(lastDot) : "";

  // Strip trailing _N to get the root name
  const base = rawBase.replace(trailingSuffixRe, "");

  const pattern = `${escapeLike(base)}%${escapeLike(ext)}`;
  const parentCondition = parentId
    ? eq(entities.parentId, parentId)
    : isNull(entities.parentId);

  const siblings = await tx
    .select({ name: entities.name })
    .from(entities)
    .where(
      and(
        eq(entities.workspaceId, workspaceId),
        parentCondition,
        like(entities.name, pattern),
      ),
    );

  const suffixRe = new RegExp(
    `^${escapeRegex(base)}(?:_(\\d+))?${escapeRegex(ext)}$`,
  );

  let maxN = 0;
  for (const sibling of siblings) {
    if (!sibling.name) {
      continue;
    }
    const match = suffixRe.exec(sibling.name);
    if (!match) {
      continue;
    }
    const n = match[1] ? Number.parseInt(match[1], 10) : 0;
    if (n > maxN) {
      maxN = n;
    }
  }

  return `${base}_${maxN + 1}${ext}`;
};

const getEffectiveName = (entity: EntitySnapshot): string => entity.name;

const getFolderSubtree = (
  allEntities: EntitySnapshot[],
  rootId: SafeId<"entity">,
) => {
  const childrenByParentId = new Map<SafeId<"entity">, EntitySnapshot[]>();

  for (const entity of allEntities) {
    if (!entity.parentId) {
      continue;
    }

    const children = childrenByParentId.get(entity.parentId);
    if (children) {
      children.push(entity);
      continue;
    }

    childrenByParentId.set(entity.parentId, [entity]);
  }

  const root = allEntities.find((entity) => entity.id === rootId);
  if (!root) {
    return null;
  }

  const subtree: EntitySnapshot[] = [];
  const queue = [root];

  for (const entity of queue) {
    subtree.push(entity);
    for (const child of childrenByParentId.get(entity.id) ?? []) {
      queue.push(child);
    }
  }

  return subtree;
};

type DuplicateEntitiesProps = {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  auditContext: AuditContext;
  sourceEntityId: SafeId<"entity">;
  sourceEntities: EntitySnapshot[];
};

const duplicateEntities = async ({
  tx,
  workspaceId,
  userId,
  auditContext,
  sourceEntityId,
  sourceEntities,
}: DuplicateEntitiesProps) => {
  const entityCount = await tx.$count(
    entities,
    eq(entities.workspaceId, workspaceId),
  );

  if (entityCount + sourceEntities.length > LIMITS.entitiesCount) {
    return {
      ok: false as const,
      status: 400 as const,
      message: "Entities limit reached",
    };
  }

  const idMap = new Map<SafeId<"entity">, SafeId<"entity">>();
  const duplicatedEntities: DuplicatedEntity[] = [];
  const duplicatedEntityIds: SafeId<"entity">[] = [];

  for (const source of sourceEntities) {
    if (!source.currentVersion) {
      return {
        ok: false as const,
        status: 400 as const,
        message: "Entity has no current version",
      };
    }

    const newEntityId = createSafeId<"entity">();
    const newVersionId = createSafeId<"entityVersion">();
    const mappedParentId = source.parentId
      ? idMap.get(source.parentId)
      : undefined;
    const newParentId =
      source.id === sourceEntityId ? source.parentId : mappedParentId;
    const duplicateName =
      source.id === sourceEntityId
        ? await resolveEntityName({
            tx,
            workspaceId,
            parentId: source.parentId,
            name: getEffectiveName(source),
          })
        : source.name;

    if (source.id !== sourceEntityId && !newParentId) {
      return {
        ok: false as const,
        status: 500 as const,
        message: "Duplicate parent was not created",
      };
    }

    const entityStamp =
      source.kind === "document"
        ? await allocateEntityStamp(tx, workspaceId)
        : null;

    await tx.insert(entities).values({
      id: newEntityId,
      workspaceId,
      kind: source.kind,
      parentId: newParentId ?? null,
      name: duplicateName,
      createdBy: userId,
      docSequence: entityStamp?.docSequence ?? null,
    });

    await tx.insert(entityVersions).values({
      id: newVersionId,
      workspaceId,
      entityId: newEntityId,
      versionNumber: 1,
      stamp: entityStamp?.stamp ?? null,
      verificationCode: entityStamp?.verificationCode ?? null,
    });

    await tx
      .update(entities)
      .set({ currentVersionId: newVersionId })
      .where(eq(entities.id, newEntityId));

    const sourceFields = source.currentVersion.fields;
    if (sourceFields.length > 0) {
      await tx.insert(fields).values(
        sourceFields.map((field) => ({
          workspaceId,
          propertyId: field.propertyId,
          entityVersionId: newVersionId,
          content: field.content,
        })),
      );
    }

    idMap.set(source.id, newEntityId);
    duplicatedEntityIds.push(newEntityId);
    duplicatedEntities.push({
      sourceId: source.id,
      entityId: newEntityId,
      kind: source.kind,
      name: duplicateName,
      parentId: newParentId ?? null,
    });
  }

  await tx
    .update(workspaces)
    .set({ lastActivityAt: new Date() })
    .where(eq(workspaces.id, workspaceId));

  await writeAuditLog(
    duplicatedEntities.map((entity) => ({
      organizationId: auditContext.organizationId,
      workspaceId: auditContext.workspaceId ?? null,
      userId: auditContext.userId,
      metadata: auditContext.metadata,
      action: AUDIT_ACTION.CREATE,
      resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
      resourceId: entity.entityId,
      changes: {
        created: {
          old: { sourceEntityId: entity.sourceId },
          new: {
            kind: entity.kind,
            name: entity.name,
            parentId: entity.parentId,
          },
        },
      },
    })),
    tx,
  );

  const rootEntityId = idMap.get(sourceEntityId);
  if (!rootEntityId) {
    return {
      ok: false as const,
      status: 500 as const,
      message: "Duplicate root was not created",
    };
  }

  return {
    ok: true as const,
    entityId: rootEntityId,
    entityIds: duplicatedEntityIds,
  };
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
        return await duplicateEntities({
          tx,
          workspaceId,
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

      return await duplicateEntities({
        tx,
        workspaceId,
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
