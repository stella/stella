import { Result } from "better-result";

import type { SafeDb } from "@/api/db/safe-db";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  FLOW_TASK_FEATURE_ACCESS,
  admitTaskFlowAccess,
} from "@/api/lib/flows/review-gate-task";

const readVersionByIdParamsSchema = workspaceParams({
  entityId: tSafeId("entity"),
  versionId: tSafeId("entityVersion"),
});

type ReadVersionByIdHandlerProps = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  entityId: SafeId<"entity">;
  userId: SafeId<"user">;
  versionId: SafeId<"entityVersion">;
};

const readVersionByIdHandler = async function* ({
  safeDb,
  workspaceId,
  entityId,
  userId,
  versionId,
}: ReadVersionByIdHandlerProps) {
  const admission = yield* Result.await(
    safeDb(
      async (tx) =>
        await admitTaskFlowAccess(tx, {
          workspaceId,
          taskEntityId: entityId,
          userId,
        }),
    ),
  );
  yield* admission;

  // Validate entity exists in workspace
  const entity = yield* Result.await(
    safeDb((tx) =>
      tx.query.entities.findFirst({
        where: {
          id: { eq: entityId },
          workspaceId: { eq: workspaceId },
        },
        columns: { id: true },
      }),
    ),
  );

  if (!entity) {
    return Result.err(
      new HandlerError({ status: 404, message: "Entity not found" }),
    );
  }

  // Fetch the version metadata AND its fields in a single tombstone-checked
  // query. Reading the fields separately (keyed only by entityVersionId) after
  // a `deletedAt IS NULL` metadata check left a TOCTOU window: a tombstone
  // landing between the two reads would still return the withdrawn version's
  // field content. Tying the fields to the same live-version row closes it —
  // either the live version and its fields come back together, or neither does.
  const read = yield* Result.await(
    safeDb(async (tx) => {
      const currentAdmission = await admitTaskFlowAccess(tx, {
        workspaceId,
        taskEntityId: entityId,
        userId,
      });
      if (currentAdmission.isErr()) {
        return currentAdmission;
      }
      const version = await tx.query.entityVersions.findFirst({
        where: {
          id: { eq: versionId },
          entityId: { eq: entityId },
          workspaceId: { eq: workspaceId },
          deletedAt: { isNull: true },
        },
        columns: {
          id: true,
          versionNumber: true,
          stamp: true,
          createdAt: true,
        },
        with: {
          // SAFETY: fields of one entity version, bounded by
          // properties-per-workspace (LIMITS.propertiesCount).
          fields: {
            columns: {
              id: true,
              propertyId: true,
              content: true,
            },
          },
        },
      });
      return Result.ok(version);
    }),
  );
  const versionRow = yield* read;

  if (!versionRow) {
    return Result.err(
      new HandlerError({ status: 404, message: "Version not found" }),
    );
  }

  return Result.ok({
    id: versionRow.id,
    versionNumber: versionRow.versionNumber,
    stamp: versionRow.stamp,
    createdAt: versionRow.createdAt.toISOString(),
    fields: versionRow.fields,
  });
};

const config = {
  description:
    "Read one specific version of a document in a matter: its version " +
    "number, stamp, creation time, and the field values stored on that " +
    "version. A version tombstoned by entities.versions.delete reads as not " +
    "found. Use entities.get for the current version.",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  featureAccess: FLOW_TASK_FEATURE_ACCESS,
  mcp: { type: "covered", by: "read_document" },
  access: "read",
  params: readVersionByIdParamsSchema,
} satisfies WorkspaceHandlerConfig;

const readVersionById = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, params, user }) {
    return yield* readVersionByIdHandler({
      safeDb,
      workspaceId,
      entityId: params.entityId,
      userId: user.id,
      versionId: params.versionId,
    });
  },
);

export default readVersionById;
