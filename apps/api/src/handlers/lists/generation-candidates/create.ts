import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import * as v from "valibot";

import { apiDateSchema } from "@stll/api-contract/api-date";

import {
  legalListGenerationCandidates,
  legalListGenerationCandidateSources,
  legalListGenerationRuns,
  LIST_ITEM_TYPES,
} from "@/api/db/schema";
import { legalListRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { ENTITY_PRIORITIES, TASK_STATUSES } from "@/api/lib/entity-constants";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LEGAL_LISTS_FEATURE_ID } from "@/api/lib/feature-access/registry";
import { LIMITS } from "@/api/lib/limits";
import { parseLegalListSourceLocator } from "@/api/lib/lists/source-locator";
import type { LegalListSourceLocator } from "@/api/lib/lists/types";
import { includes } from "@/api/lib/type-guards";

const sourceSchema = v.object({
  entityId: resourceIdSchema("entity"),
  entityVersionId: resourceIdSchema("entityVersion"),
  locator: v.union([
    v.object({ type: v.literal("document") }),
    v.object({
      type: v.literal("docx-block"),
      blockId: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
    }),
    v.object({
      type: v.literal("pdf-page"),
      pageNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
    }),
  ]),
  quote: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(5000)))),
});
const candidateSchema = v.object({
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(2000)),
  description: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(10_000)))),
  itemType: v.pipe(v.string(), v.minLength(1), v.maxLength(32)),
  status: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(32)))),
  priority: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(16)))),
  dueDate: v.optional(v.nullable(apiDateSchema)),
  suggestedAssigneeUserIds: v.optional(
    v.pipe(
      v.array(resourceIdSchema("user")),
      v.maxLength(LIMITS.workspaceMembersCount),
    ),
  ),
  sources: v.pipe(
    v.array(sourceSchema),
    v.minLength(1),
    v.maxLength(LIMITS.legalListGenerationCandidateSourcesMax),
  ),
});
const bodySchema = v.object({
  listId: resourceIdSchema("legalList"),
  runId: resourceIdSchema("legalListGenerationRun"),
  candidates: v.pipe(
    v.array(candidateSchema),
    v.minLength(1),
    v.maxLength(LIMITS.legalListGenerationCandidatesMax),
  ),
});
const config = {
  contract: "patch",
  idempotency: { type: "replay" },
  featureAccess: { type: "required", featureId: LEGAL_LISTS_FEATURE_ID },
  description:
    "Submit the candidates a generation run produced: per candidate a name, " +
    "description, item type, status, priority, due date, suggested " +
    "assignees, and the sources it was drawn from, each naming a document " +
    "version with a locator and optional quote. Every source must be one of " +
    "the run's own source versions. The run moves from running to review; " +
    "candidates stay proposals until they are accepted or rejected.",
  permissions: { entity: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  realtime: legalListRealtimeUpdates,
  mcp: {
    type: "capability",
    reason: "workflow_orchestration",
    consumesServices: false,
  },
  body: bodySchema,
} satisfies WorkspaceHandlerConfig;

type ValidCandidate = {
  name: string;
  description: string | null;
  itemType: (typeof LIST_ITEM_TYPES)[number];
  status: (typeof TASK_STATUSES)[number] | null;
  priority: (typeof ENTITY_PRIORITIES)[number] | null;
  dueDate: string | null;
  // Omitted lets the column default (no suggested assignees) apply.
  suggestedAssigneeUserIds: SafeId<"user">[] | undefined;
  sources: {
    entityId: SafeId<"entity">;
    entityVersionId: SafeId<"entityVersion">;
    locator: LegalListSourceLocator;
    quote: string | null;
  }[];
};

const validateCandidates = (
  candidates: v.InferOutput<typeof bodySchema>["candidates"],
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
      suggestedAssigneeUserIds: candidate.suggestedAssigneeUserIds,
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
