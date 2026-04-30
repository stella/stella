import { Result } from "better-result";
import { eq } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import type { SafeDb, Transaction } from "@/api/db";
import { entities, entityVersions, workspaces } from "@/api/db/schema";
import { entityKindSchema } from "@/api/db/schema-validators";
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
import { LIMITS } from "@/api/lib/limits";
import { getSearchProvider } from "@/api/lib/search/provider";

const createEntityBodySchema = t.Object({
  kind: t.Optional(entityKindSchema),
  parentId: t.Optional(t.Nullable(tSafeId("entity"))),
  name: t.String({ minLength: 1, maxLength: 255 }),
});

type CreateEntityBodySchema = Static<typeof createEntityBodySchema>;

type CreateEntitiesHandlerProps = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  auditContext: AuditContext;
  body: CreateEntityBodySchema;
};

const checkEntityLimit = async (
  tx: Transaction,
  workspaceId: SafeId<"workspace">,
) => {
  const totalEntities = await tx.$count(
    entities,
    eq(entities.workspaceId, workspaceId),
  );

  if (totalEntities >= LIMITS.entitiesCount) {
    return Result.err("Entities limit reached");
  }

  return Result.ok({ maxEntitiesCount: LIMITS.entitiesCount - totalEntities });
};

const validateParentId = async (
  tx: Transaction,
  parentId: SafeId<"entity">,
  workspaceId: SafeId<"workspace">,
): Promise<string | null> => {
  const parent = await tx.query.entities.findFirst({
    where: {
      id: { eq: parentId },
      workspaceId: { eq: workspaceId },
    },
    columns: {
      kind: true,
    },
  });

  if (!parent) {
    return "Parent entity not found in this workspace";
  }

  if (parent.kind !== "folder") {
    return "Parent entity must be a folder";
  }

  return null;
};

const createEntitiesHandler = async function* ({
  safeDb,
  workspaceId,
  userId,
  auditContext,
  body,
}: CreateEntitiesHandlerProps) {
  const parentId = body.parentId ?? null;
  const kind = body.kind;
  const name = body.name?.trim() ?? "";

  // `entities.name` is the canonical display label and is non-null
  // for every kind. Reject empty names here so the row never
  // reaches the DB without one.
  if (name.length === 0) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Entity name is required",
      }),
    );
  }

  const txResult = yield* Result.await(
    safeDb(async (tx) => {
      const limitResult = await checkEntityLimit(tx, workspaceId);
      if (Result.isError(limitResult)) {
        return {
          ok: false as const,
          status: 400 as const,
          message: limitResult.error,
        };
      }

      if (parentId) {
        const error = await validateParentId(tx, parentId, workspaceId);
        if (error) {
          return { ok: false as const, status: 400 as const, message: error };
        }
      }

      const entityId = createSafeId<"entity">();
      const effectiveKind = kind ?? "document";

      const entityStamp =
        effectiveKind === "document"
          ? await allocateEntityStamp(tx, workspaceId)
          : null;

      await tx.insert(entities).values({
        id: entityId,
        workspaceId,
        kind: effectiveKind,
        parentId,
        name,
        createdBy: userId,
        docSequence: entityStamp?.docSequence ?? null,
      });

      const entityVersionId = createSafeId<"entityVersion">();

      await tx.insert(entityVersions).values({
        id: entityVersionId,
        workspaceId,
        entityId,
        versionNumber: 1,
        stamp: entityStamp?.stamp ?? null,
        verificationCode: entityStamp?.verificationCode ?? null,
      });

      await tx
        .update(entities)
        .set({ currentVersionId: entityVersionId })
        .where(eq(entities.id, entityId));

      await tx
        .update(workspaces)
        .set({ lastActivityAt: new Date() })
        .where(eq(workspaces.id, workspaceId));

      await writeAuditLog(
        {
          ...auditContext,
          action: AUDIT_ACTION.CREATE,
          resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
          resourceId: entityId,
          changes: {
            created: {
              old: null,
              new: { kind: effectiveKind, name, parentId },
            },
          },
        },
        tx,
      );

      return { ok: true as const, entityId };
    }),
  );

  if (!txResult.ok) {
    return Result.err(
      new HandlerError({ status: txResult.status, message: txResult.message }),
    );
  }

  getSearchProvider().indexEntity(txResult.entityId).catch(captureError);

  return Result.ok({ entityId: txResult.entityId });
};

const config = {
  permissions: { entity: ["create"] },
  body: createEntityBodySchema,
} satisfies HandlerConfig;

const createEntities = createSafeHandler(
  config,
  async function* ({ safeDb, session, workspaceId, user, request, body }) {
    return yield* createEntitiesHandler({
      safeDb,
      workspaceId,
      userId: user.id,
      auditContext: createAuditContext({
        organizationId: session.activeOrganizationId,
        workspaceId,
        userId: user.id,
        request,
      }),
      body,
    });
  },
);

export default createEntities;
