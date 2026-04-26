import { Result } from "better-result";
import { eq } from "drizzle-orm";
import { t } from "elysia";

import { entities, entityVersions, workspaces } from "@/api/db/schema";
import type { LinkMetadata } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { createSafeId } from "@/api/lib/branded-types";
import { tDefaultVarchar } from "@/api/lib/custom-schema";
import { allocateEntityStamp } from "@/api/lib/document-counter";
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
  },
  async function* (ctx) {
    const {
      safeDb,
      workspaceId,
      user,
      body: { title, url, snippet, citation, jurisdiction, sourceType },
    } = ctx;

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

    yield* Result.await(
      safeDb(async (tx) => {
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
      }),
    );

    getSearchProvider().indexEntity(entityId).catch(captureError);

    return Result.ok({ entityId });
  },
);
