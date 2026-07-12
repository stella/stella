import { panic, Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";
import { t } from "elysia";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  entities,
  entityVersions,
  fields,
  justifications,
} from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";

type ReadJustificationsHandlerProps = {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
  entityIds: SafeId<"entity">[];
};

export const readJustificationsHandler = async ({
  scopedDb,
  workspaceId,
  entityIds,
}: ReadJustificationsHandlerProps) => {
  // Defensive depth: the route schema enforces minItems/maxItems,
  // so these branches are unreachable via the API route.
  if (entityIds.length === 0) {
    return [];
  }

  if (entityIds.length > LIMITS.entitiesPageSizeMax) {
    panic("Justifications query exceeded max entity batch size");
  }

  const uniqueEntityIds = [...new Set(entityIds)];

  return await scopedDb((tx) =>
    tx
      .select({
        id: justifications.id,
        fieldId: justifications.fieldId,
        content: justifications.content,
        boundingBoxes: justifications.boundingBoxes,
        fileFieldIds: justifications.fileFieldIds,
      })
      .from(justifications)
      .innerJoin(fields, eq(justifications.fieldId, fields.id))
      .innerJoin(entityVersions, eq(fields.entityVersionId, entityVersions.id))
      .innerJoin(
        entities,
        and(
          eq(entityVersions.id, entities.currentVersionId),
          eq(entities.workspaceId, workspaceId),
        ),
      )
      .where(
        and(
          eq(justifications.workspaceId, workspaceId),
          inArray(entityVersions.entityId, uniqueEntityIds),
        ),
      ),
  );
};

const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "capability", reason: "workflow_orchestration" },
  body: t.Object({
    entityIds: t.Array(tSafeId("entity"), {
      minItems: 1,
      maxItems: LIMITS.entitiesPageSizeMax,
    }),
  }),
} satisfies HandlerConfig;

const readJustifications = createSafeHandler(
  config,
  async function* ({ body: { entityIds }, scopedDb, workspaceId }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await readJustificationsHandler({
            workspaceId,
            scopedDb,
            entityIds,
          }),
      ),
    );

    return Result.ok(response);
  },
);

export default readJustifications;
