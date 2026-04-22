import { Result } from "better-result";
import { and, desc, eq } from "drizzle-orm";
import { t } from "elysia";

import { entities, entityVersions, fields, workspaces } from "@/api/db/schema";
import { buildVersionStamp } from "@/api/handlers/entities/version-utils";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { broadcast } from "@/api/lib/sse";

const paramsSchema = workspaceParams({
  entityId: t.String(),
  versionId: t.String(),
});

const config = {
  permissions: { entity: ["update"] },
  params: paramsSchema,
} satisfies HandlerConfig;

export default createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, params, user }) {
    const userId = user.id;

    // Verify the version belongs to this entity in this workspace
    const version = yield* Result.await(
      safeDb((tx) =>
        tx.query.entityVersions.findFirst({
          where: {
            id: params.versionId,
            entityId: params.entityId,
            workspaceId: { eq: workspaceId },
          },
          columns: { id: true, versionNumber: true },
          with: {
            fields: { columns: { content: true, propertyId: true } },
          },
        }),
      ),
    );

    if (!version) {
      return Result.err(
        new HandlerError({ status: 404, message: "Version not found" }),
      );
    }

    // Get the current highest version number
    const latestVersion = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({ versionNumber: entityVersions.versionNumber })
          .from(entityVersions)
          .where(
            and(
              eq(entityVersions.entityId, params.entityId),
              eq(entityVersions.workspaceId, workspaceId),
            ),
          )
          .orderBy(desc(entityVersions.versionNumber))
          .limit(1),
      ),
    );

    const nextVersionNumber = (latestVersion.at(0)?.versionNumber ?? 0) + 1;
    const nextVersionId = crypto.randomUUID();

    // Get entity info for stamp
    const entity = yield* Result.await(
      safeDb((tx) =>
        tx.query.entities.findFirst({
          where: { id: params.entityId, workspaceId: { eq: workspaceId } },
          columns: { docSequence: true },
        }),
      ),
    );

    const workspace = yield* Result.await(
      safeDb((tx) =>
        tx.query.workspaces.findFirst({
          where: { id: workspaceId },
          columns: { reference: true },
        }),
      ),
    );

    const nextVersionStamp = buildVersionStamp({
      docSequence: entity?.docSequence ?? null,
      versionNumber: nextVersionNumber,
      workspaceReference: workspace?.reference ?? null,
    });

    // Create a new version (copy-to-top) with all fields from the source version
    yield* Result.await(
      safeDb(async (tx) => {
        await tx.insert(entityVersions).values({
          createdBy: userId,
          entityId: params.entityId,
          id: nextVersionId,
          label: `Restored from v${String(version.versionNumber)}`,
          stamp: nextVersionStamp.stamp,
          verificationCode: nextVersionStamp.verificationCode,
          versionNumber: nextVersionNumber,
          workspaceId,
        });

        // Clone all fields from the source version
        if (version.fields.length > 0) {
          await tx.insert(fields).values(
            version.fields.map((f) => ({
              content: f.content,
              entityVersionId: nextVersionId,
              propertyId: f.propertyId,
              workspaceId,
            })),
          );
        }

        // Point entity to the new version
        await tx
          .update(entities)
          .set({
            currentVersionId: nextVersionId,
            lastEditedBy: userId,
            updatedAt: new Date(),
          })
          .where(eq(entities.id, params.entityId));

        await tx
          .update(workspaces)
          .set({ lastActivityAt: new Date() })
          .where(eq(workspaces.id, workspaceId));
      }),
    );

    broadcast(workspaceId, {
      type: "invalidate-query",
      data: ["entities", workspaceId],
    });

    return Result.ok({
      versionId: nextVersionId,
      versionNumber: nextVersionNumber,
    });
  },
);
