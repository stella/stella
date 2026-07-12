import { Result } from "better-result";
import { eq } from "drizzle-orm";
import { t } from "elysia";

import { entities, entityVersions, workspaces } from "@/api/db/schema";
import type { LinkMetadata } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { tDefaultVarchar } from "@/api/lib/custom-schema";
import { allocateEntityStamp } from "@/api/lib/document-counter";
import { lockWorkspacesForEntityCap } from "@/api/lib/entity-cap-lock";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { getSearchProvider } from "@/api/lib/search/provider";

const clipBodySchema = t.Object({
  title: tDefaultVarchar,
  url: t.String({ minLength: 1, maxLength: 2048 }),
  snippet: t.Optional(t.String({ maxLength: 10_000 })),
  citation: t.Optional(t.String({ maxLength: 1000 })),
  jurisdiction: t.Optional(t.String({ maxLength: 128 })),
  sourceType: t.Optional(t.String({ maxLength: 64 })),
});

export default createSafeHandler(
  {
    body: clipBodySchema,
    permissions: { entity: ["create"] },
    mcp: { type: "capability", reason: "document_processing" },
  },
  async function* (ctx) {
    const {
      safeDb,
      workspaceId,
      user,
      recordAuditEvent,
      body: { title, url, snippet, citation, jurisdiction, sourceType },
    } = ctx;

    // Non-authoritative fast-fail: cheap, unlocked, avoids doing
    // metadata work for a request that's obviously over the limit.
    // The authoritative check is inside the write transaction below,
    // behind the workspace-row lock.
    const entityCount = yield* Result.await(
      safeDb((tx) =>
        tx.$count(entities, eq(entities.workspaceId, workspaceId)),
      ),
    );

    if (entityCount >= LIMITS.entitiesCount) {
      return Result.err(
        new HandlerError({ status: 400, message: "Entities limit reached" }),
      );
    }

    const metadata: LinkMetadata = {
      url,
      ...(snippet !== undefined && { snippet }),
      ...(citation !== undefined && { citation }),
      ...(jurisdiction !== undefined && { jurisdiction }),
      ...(sourceType !== undefined && { sourceType }),
    };

    const entityId = createSafeId<"entity">();
    const entityVersionId = createSafeId<"entityVersion">();

    const writeResult = yield* Result.await(
      safeDb(async (tx) => {
        // See `lockWorkspacesForEntityCap` for the canonical lock
        // order every entity-creating path follows (issue #1139).
        await lockWorkspacesForEntityCap(tx, [workspaceId]);

        const authoritativeEntityCount = await tx.$count(
          entities,
          eq(entities.workspaceId, workspaceId),
        );
        if (authoritativeEntityCount >= LIMITS.entitiesCount) {
          return { ok: false as const };
        }

        const entityStamp = await allocateEntityStamp(tx, workspaceId);

        await tx.insert(entities).values({
          id: entityId,
          workspaceId,
          kind: "link",
          name: title,
          metadata,
          createdBy: user.id,
          docSequence: entityStamp.docSequence,
        });

        await tx.insert(entityVersions).values({
          id: entityVersionId,
          workspaceId,
          entityId,
          versionNumber: 1,
          stamp: entityStamp.stamp,
          verificationCode: entityStamp.verificationCode,
        });

        await tx
          .update(entities)
          .set({ currentVersionId: entityVersionId })
          .where(eq(entities.id, entityId));

        await tx
          .update(workspaces)
          .set({ lastActivityAt: new Date() })
          .where(eq(workspaces.id, workspaceId));

        await recordAuditEvent(tx, [
          {
            action: AUDIT_ACTION.CREATE,
            resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
            resourceId: entityId,
            changes: {
              created: {
                old: null,
                new: {
                  kind: "link",
                  name: title,
                  metadata,
                  currentVersionId: entityVersionId,
                },
              },
            },
          },
          {
            action: AUDIT_ACTION.CREATE,
            resourceType: AUDIT_RESOURCE_TYPE.ENTITY_VERSION,
            resourceId: entityVersionId,
            changes: {
              created: {
                old: null,
                new: {
                  entityId,
                  versionNumber: 1,
                },
              },
            },
          },
        ]);

        return { ok: true as const };
      }),
    );

    if (!writeResult.ok) {
      return Result.err(
        new HandlerError({ status: 400, message: "Entities limit reached" }),
      );
    }

    getSearchProvider().indexEntity(entityId).catch(captureError);

    return Result.ok({ entityId });
  },
);
