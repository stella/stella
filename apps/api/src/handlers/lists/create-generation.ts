import { Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";
import { t } from "elysia";

import {
  entities,
  entityVersions,
  legalListGenerationRuns,
  legalListGenerationSources,
} from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

const sourceSchema = t.Object({
  entityId: tSafeId("entity"),
  entityVersionId: tSafeId("entityVersion"),
});
const bodySchema = t.Object({
  listId: tSafeId("legalList"),
  instruction: t.String({ minLength: 1, maxLength: 4000 }),
  sources: t.Array(sourceSchema, {
    minItems: 1,
    maxItems: LIMITS.legalListGenerationSourcesMax,
  }),
});
const config = {
  permissions: { entity: ["create"] },
  mcp: { type: "capability", reason: "workflow_orchestration" },
  body: bodySchema,
} satisfies HandlerConfig;

const createGeneration = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, user, body, recordAuditEvent }) {
    const distinctVersionIds = [
      ...new Set(body.sources.map((source) => source.entityVersionId)),
    ];
    const distinctEntityIds = [
      ...new Set(body.sources.map((source) => source.entityId)),
    ];
    if (
      distinctVersionIds.length !== body.sources.length ||
      distinctEntityIds.length !== body.sources.length
    ) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Duplicate generation source",
        }),
      );
    }

    const result = yield* Result.await(
      safeDb(async (tx) => {
        const [list, versions] = await Promise.all([
          tx.query.legalLists.findFirst({
            where: {
              id: { eq: body.listId },
              workspaceId: { eq: workspaceId },
              status: { eq: "active" },
            },
            columns: { id: true },
          }),
          tx
            .select({
              id: entityVersions.id,
              entityId: entityVersions.entityId,
            })
            .from(entityVersions)
            .innerJoin(
              entities,
              and(
                eq(entities.id, entityVersions.entityId),
                eq(entities.workspaceId, workspaceId),
                eq(entities.kind, "document"),
              ),
            )
            .where(inArray(entityVersions.id, distinctVersionIds)),
        ]);
        const versionsById = new Map(
          versions.map((version) => [version.id, version.entityId]),
        );
        const sourcesAreValid = body.sources.every(
          (source) =>
            versionsById.get(source.entityVersionId) === source.entityId,
        );
        if (!list || !sourcesAreValid) {
          return null;
        }

        const runId = createSafeId<"legalListGenerationRun">();
        await tx.insert(legalListGenerationRuns).values({
          id: runId,
          workspaceId,
          listId: body.listId,
          status: "running",
          instruction: body.instruction,
          requestedBy: user.id,
        });
        await tx.insert(legalListGenerationSources).values(
          body.sources.map((source) => ({
            id: createSafeId<"legalListGenerationSource">(),
            workspaceId,
            listId: body.listId,
            runId,
            sourceEntityId: source.entityId,
            sourceEntityVersionId: source.entityVersionId,
          })),
        );
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.EXECUTE,
          resourceType: AUDIT_RESOURCE_TYPE.LEGAL_LIST_GENERATION,
          resourceId: runId,
          metadata: {
            operation: "generation_started",
            listId: body.listId,
            sourceCount: body.sources.length,
          },
        });
        return runId;
      }),
    );
    if (!result) {
      return Result.err(
        new HandlerError({ status: 404, message: "List or source not found" }),
      );
    }
    return Result.ok({ id: result, status: "running" as const });
  },
);

export default createGeneration;
