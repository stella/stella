import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import {
  LIST_ITEM_TYPES,
  legalListGenerationCandidates,
  legalListGenerationCandidateSources,
  legalListGenerationRuns,
} from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { ENTITY_PRIORITIES, TASK_STATUSES } from "@/api/lib/entity-constants";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { parseLegalListSourceLocator } from "@/api/lib/lists/source-locator";
import type { LegalListSourceLocator } from "@/api/lib/lists/types";
import { includes } from "@/api/lib/type-guards";

const sourceSchema = t.Object({
  entityId: tSafeId("entity"),
  entityVersionId: tSafeId("entityVersion"),
  locator: t.Unknown(),
  quote: t.Optional(t.Nullable(t.String({ maxLength: 5000 }))),
});
const candidateSchema = t.Object({
  name: t.String({ minLength: 1, maxLength: 2000 }),
  description: t.Optional(t.Nullable(t.String({ maxLength: 10_000 }))),
  itemType: t.String({ minLength: 1, maxLength: 32 }),
  status: t.Optional(t.Nullable(t.String({ maxLength: 32 }))),
  priority: t.Optional(t.Nullable(t.String({ maxLength: 16 }))),
  dueDate: t.Optional(t.Nullable(t.String({ format: "date" }))),
  suggestedAssigneeUserIds: t.Optional(
    t.Array(tSafeId("user"), { maxItems: LIMITS.workspaceMembersCount }),
  ),
  sources: t.Array(sourceSchema, {
    minItems: 1,
    maxItems: LIMITS.legalListGenerationCandidateSourcesMax,
  }),
});
const bodySchema = t.Object({
  listId: tSafeId("legalList"),
  runId: tSafeId("legalListGenerationRun"),
  candidates: t.Array(candidateSchema, {
    maxItems: LIMITS.legalListGenerationCandidatesMax,
  }),
});
const config = {
  permissions: { entity: ["create"] },
  mcp: { type: "capability", reason: "workflow_orchestration" },
  body: bodySchema,
} satisfies HandlerConfig;

type ValidCandidate = {
  name: string;
  description: string | null;
  itemType: (typeof LIST_ITEM_TYPES)[number];
  status: (typeof TASK_STATUSES)[number] | null;
  priority: (typeof ENTITY_PRIORITIES)[number] | null;
  dueDate: string | null;
  suggestedAssigneeUserIds: SafeId<"user">[];
  sources: {
    entityId: SafeId<"entity">;
    entityVersionId: SafeId<"entityVersion">;
    locator: LegalListSourceLocator;
    quote: string | null;
  }[];
};

const validateCandidates = (
  candidates: Static<typeof bodySchema>["candidates"],
): ValidCandidate[] | null => {
  const validated: ValidCandidate[] = [];
  for (const candidate of candidates) {
    if (
      !includes(LIST_ITEM_TYPES, candidate.itemType) ||
      (candidate.status !== undefined &&
        candidate.status !== null &&
        !includes(TASK_STATUSES, candidate.status)) ||
      (candidate.priority !== undefined &&
        candidate.priority !== null &&
        !includes(ENTITY_PRIORITIES, candidate.priority))
    ) {
      return null;
    }
    const sources: ValidCandidate["sources"] = [];
    for (const source of candidate.sources) {
      const locator = parseLegalListSourceLocator(source.locator);
      if (!locator.success) {
        return null;
      }
      sources.push({
        entityId: source.entityId,
        entityVersionId: source.entityVersionId,
        locator: locator.output,
        quote: source.quote ?? null,
      });
    }
    validated.push({
      name: candidate.name,
      description: candidate.description ?? null,
      itemType: candidate.itemType,
      status: candidate.status ?? null,
      priority: candidate.priority ?? null,
      dueDate: candidate.dueDate ?? null,
      suggestedAssigneeUserIds: candidate.suggestedAssigneeUserIds ?? [],
      sources,
    });
  }
  return validated;
};

const submitGenerationCandidates = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, body, recordAuditEvent }) {
    const candidates = validateCandidates(body.candidates);
    if (!candidates) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Invalid generation candidate",
        }),
      );
    }
    const result = yield* Result.await(
      safeDb(async (tx) => {
        const run = await tx.query.legalListGenerationRuns.findFirst({
          where: {
            id: { eq: body.runId },
            listId: { eq: body.listId },
            workspaceId: { eq: workspaceId },
            status: { eq: "running" },
          },
          with: { sources: true },
        });
        if (!run) {
          return null;
        }
        const allowedVersions = new Map(
          run.sources.map((source) => [
            source.sourceEntityVersionId,
            source.sourceEntityId,
          ]),
        );
        const sourcesAreValid = candidates.every((candidate) =>
          candidate.sources.every(
            (source) =>
              allowedVersions.get(source.entityVersionId) === source.entityId,
          ),
        );
        if (!sourcesAreValid) {
          return null;
        }

        const claimed = await tx
          .update(legalListGenerationRuns)
          .set({
            status: "review",
            updatedAt: new Date(),
            completedAt: new Date(),
          })
          .where(
            and(
              eq(legalListGenerationRuns.id, body.runId),
              eq(legalListGenerationRuns.workspaceId, workspaceId),
              eq(legalListGenerationRuns.status, "running"),
            ),
          )
          .returning({ id: legalListGenerationRuns.id });
        if (!claimed.at(0)) {
          return null;
        }

        const ids: SafeId<"legalListGenerationCandidate">[] = [];
        const candidateValues: (typeof legalListGenerationCandidates.$inferInsert)[] =
          [];
        const sourceValues: (typeof legalListGenerationCandidateSources.$inferInsert)[] =
          [];
        for (const [position, candidate] of candidates.entries()) {
          const candidateId = createSafeId<"legalListGenerationCandidate">();
          ids.push(candidateId);
          candidateValues.push({
            id: candidateId,
            workspaceId,
            listId: body.listId,
            runId: body.runId,
            position,
            name: candidate.name,
            description: candidate.description,
            itemType: candidate.itemType,
            itemStatus: candidate.status,
            priority: candidate.priority,
            dueDate: candidate.dueDate,
            suggestedAssigneeUserIds: candidate.suggestedAssigneeUserIds,
          });
          for (const source of candidate.sources) {
            sourceValues.push({
              id: createSafeId<"legalListGenerationCandidateSource">(),
              workspaceId,
              listId: body.listId,
              runId: body.runId,
              candidateId,
              sourceEntityId: source.entityId,
              sourceEntityVersionId: source.entityVersionId,
              locator: source.locator,
              quote: source.quote,
            });
          }
        }
        if (candidateValues.length > 0) {
          await tx
            .insert(legalListGenerationCandidates)
            .values(candidateValues);
        }
        if (sourceValues.length > 0) {
          await tx
            .insert(legalListGenerationCandidateSources)
            .values(sourceValues);
        }
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.LEGAL_LIST_GENERATION,
          resourceId: body.runId,
          metadata: {
            operation: "candidates_submitted",
            candidateCount: candidates.length,
          },
        });
        return ids;
      }),
    );
    if (!result) {
      return Result.err(
        new HandlerError({
          status: 409,
          message: "Generation is not writable",
        }),
      );
    }
    return Result.ok({ ids: result, status: "review" as const });
  },
);

export default submitGenerationCandidates;
