import { Result } from "better-result";
import { and, asc, eq, gt, inArray, or } from "drizzle-orm";
import { t } from "elysia";

import {
  legalListGenerationCandidates,
  legalListGenerationCandidateSources,
} from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
  isUuidPaginationCursorPart,
} from "@/api/lib/pagination";
import { brandPersistedLegalListGenerationCandidateId } from "@/api/lib/safe-id-boundaries";

const paramsSchema = t.Object({
  listId: tSafeId("legalList"),
  runId: tSafeId("legalListGenerationRun"),
});
const querySchema = t.Object({
  limit: t.Optional(
    t.Integer({
      minimum: 1,
      maximum: LIMITS.legalListGenerationCandidatesMax,
    }),
  ),
  cursor: t.Optional(t.String({ maxLength: 512 })),
});
const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "capability", reason: "workflow_orchestration" },
  params: paramsSchema,
  query: querySchema,
} satisfies HandlerConfig;

type CandidateCursor = {
  position: number;
  id: SafeId<"legalListGenerationCandidate">;
};

const decodeCursor = (value: string): CandidateCursor | null => {
  const parts = decodePaginationCursor(value);
  const position = Number(parts?.at(0));
  const id = parts?.at(1);
  if (!Number.isInteger(position) || !isUuidPaginationCursorPart(id)) {
    return null;
  }
  return {
    position,
    id: brandPersistedLegalListGenerationCandidateId(id),
  };
};

const readGenerationCandidates = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, params, query }) {
    const limit = query.limit ?? LIMITS.legalListGenerationCandidatesMax;
    const conditions = [
      eq(legalListGenerationCandidates.workspaceId, workspaceId),
      eq(legalListGenerationCandidates.listId, params.listId),
      eq(legalListGenerationCandidates.runId, params.runId),
    ];
    if (query.cursor) {
      const cursor = decodeCursor(query.cursor);
      if (!cursor) {
        return Result.err(
          new HandlerError({ status: 400, message: "Invalid cursor" }),
        );
      }
      const cursorCondition = or(
        gt(legalListGenerationCandidates.position, cursor.position),
        and(
          eq(legalListGenerationCandidates.position, cursor.position),
          gt(legalListGenerationCandidates.id, cursor.id),
        ),
      );
      if (cursorCondition) {
        conditions.push(cursorCondition);
      }
    }

    const result = yield* Result.await(
      safeDb(async (tx) => {
        const run = await tx.query.legalListGenerationRuns.findFirst({
          where: {
            id: { eq: params.runId },
            listId: { eq: params.listId },
            workspaceId: { eq: workspaceId },
          },
          columns: { id: true, status: true },
        });
        if (!run) {
          return null;
        }
        const candidates = await tx
          .select({
            id: legalListGenerationCandidates.id,
            position: legalListGenerationCandidates.position,
            name: legalListGenerationCandidates.name,
            description: legalListGenerationCandidates.description,
            itemType: legalListGenerationCandidates.itemType,
            itemStatus: legalListGenerationCandidates.itemStatus,
            priority: legalListGenerationCandidates.priority,
            dueDate: legalListGenerationCandidates.dueDate,
            suggestedAssigneeUserIds:
              legalListGenerationCandidates.suggestedAssigneeUserIds,
            status: legalListGenerationCandidates.status,
            acceptedEntityId: legalListGenerationCandidates.acceptedEntityId,
          })
          .from(legalListGenerationCandidates)
          .where(and(...conditions))
          .orderBy(
            asc(legalListGenerationCandidates.position),
            asc(legalListGenerationCandidates.id),
          )
          .limit(limit + 1);
        const candidateIds = candidates
          .slice(0, limit)
          .map((candidate) => candidate.id);
        const sources =
          candidateIds.length === 0
            ? []
            : await tx
                .select({
                  id: legalListGenerationCandidateSources.id,
                  candidateId: legalListGenerationCandidateSources.candidateId,
                  sourceEntityId:
                    legalListGenerationCandidateSources.sourceEntityId,
                  sourceEntityVersionId:
                    legalListGenerationCandidateSources.sourceEntityVersionId,
                  locator: legalListGenerationCandidateSources.locator,
                  quote: legalListGenerationCandidateSources.quote,
                })
                .from(legalListGenerationCandidateSources)
                .where(
                  and(
                    eq(
                      legalListGenerationCandidateSources.workspaceId,
                      workspaceId,
                    ),
                    inArray(
                      legalListGenerationCandidateSources.candidateId,
                      candidateIds,
                    ),
                  ),
                )
                .orderBy(asc(legalListGenerationCandidateSources.id))
                .limit(
                  LIMITS.legalListGenerationCandidatesMax *
                    LIMITS.legalListGenerationCandidateSourcesMax,
                );
        const sourcesByCandidate = new Map<
          SafeId<"legalListGenerationCandidate">,
          typeof sources
        >();
        for (const source of sources) {
          const grouped = sourcesByCandidate.get(source.candidateId) ?? [];
          grouped.push(source);
          sourcesByCandidate.set(source.candidateId, grouped);
        }
        return { runStatus: run.status, candidates, sourcesByCandidate };
      }),
    );
    if (!result) {
      return Result.err(
        new HandlerError({ status: 404, message: "Generation not found" }),
      );
    }
    const page = createCursorPage({
      rows: result.candidates,
      limit,
      cursorForItem: (candidate) =>
        encodePaginationCursor([candidate.position, candidate.id]),
    });
    return Result.ok({
      ...page,
      runStatus: result.runStatus,
      items: page.items.map((candidate) =>
        Object.assign(candidate, {
          sources: result.sourcesByCandidate.get(candidate.id) ?? [],
        }),
      ),
    });
  },
);

export default readGenerationCandidates;
