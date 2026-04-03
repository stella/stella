import { Result } from "better-result";
import { eq } from "drizzle-orm";
import { status, t } from "elysia";
import type { Static } from "elysia";

import type { ScopedDb, Transaction } from "@/api/db";
import { entities, entityVersions, workspaces } from "@/api/db/schema";
import { entityKindSchema } from "@/api/db/schema-validators";
import { captureError } from "@/api/lib/analytics";
import { createHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { tNanoid } from "@/api/lib/custom-schema";
import { allocateEntityStamp } from "@/api/lib/document-counter";
import { LIMITS } from "@/api/lib/limits";
import { getSearchProvider } from "@/api/lib/search/provider";

const createEntityBodySchema = t.Object({
  kind: t.Optional(entityKindSchema),
  parentId: t.Optional(t.Nullable(tNanoid)),
  name: t.Optional(t.String()),
});

type CreateEntityBodySchema = Static<typeof createEntityBodySchema>;

type CreateEntitiesHandlerProps = {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
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
  parentId: string,
  workspaceId: SafeId<"workspace">,
) => {
  const parent = await tx.query.entities.findFirst({
    where: {
      id: parentId,
      workspaceId: { eq: workspaceId },
    },
    columns: {
      kind: true,
    },
  });

  if (!parent) {
    return status(400, {
      message: "Parent entity not found in this workspace",
    });
  }

  if (parent.kind !== "folder") {
    return status(400, {
      message: "Parent entity must be a folder",
    });
  }

  return null;
};

const createEntitiesHandler = async ({
  scopedDb,
  workspaceId,
  userId,
  body,
}: CreateEntitiesHandlerProps) => {
  const parentId = body.parentId ?? null;
  const kind = body.kind;
  const name = body.name ?? null;

  const txResult = await scopedDb(async (tx) => {
    const limitResult = await checkEntityLimit(tx, workspaceId);
    if (Result.isError(limitResult)) {
      return status(400, {
        message: limitResult.error,
      });
    }

    if (parentId) {
      const error = await validateParentId(tx, parentId, workspaceId);
      if (error) {
        return error;
      }
    }

    const entityId = crypto.randomUUID();
    const effectiveKind = kind ?? "document";

    const entityStamp =
      effectiveKind === "document"
        ? await allocateEntityStamp(tx, workspaceId)
        : null;

    await tx.insert(entities).values({
      id: entityId,
      workspaceId,
      kind,
      parentId,
      name,
      createdBy: userId,
      docSequence: entityStamp?.docSequence ?? null,
    });

    const entityVersionId = crypto.randomUUID();

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

    return { entityId };
  });

  // oxlint-disable-next-line typescript/strict-boolean-expressions -- txResult discriminated union check
  if (txResult && typeof txResult === "object" && "entityId" in txResult) {
    getSearchProvider().indexEntity(txResult.entityId).catch(captureError);
  }

  return txResult;
};

const config = {
  permissions: { entity: ["create"] },
  body: createEntityBodySchema,
} satisfies HandlerConfig;

const createEntities = createHandler(
  config,
  async ({ scopedDb, workspaceId, user, body }) =>
    await createEntitiesHandler({
      scopedDb,
      workspaceId,
      userId: user.id,
      body,
    }),
);

export default createEntities;
