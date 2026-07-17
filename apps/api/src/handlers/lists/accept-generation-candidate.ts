import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import {
  legalListGenerationCandidates,
  legalListGenerationRuns,
  legalListItemSources,
} from "@/api/db/schema";
import { createTaskEntityHandler } from "@/api/handlers/tasks/create";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const bodySchema = t.Object({
  listId: tSafeId("legalList"),
  runId: tSafeId("legalListGenerationRun"),
  candidateId: tSafeId("legalListGenerationCandidate"),
  sectionId: t.Optional(tSafeId("legalListSection")),
});
const config = {
  permissions: { entity: ["create"] },
  mcp: { type: "capability", reason: "workflow_orchestration" },
  body: bodySchema,
} satisfies HandlerConfig;

const acceptGenerationCandidate = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, user, body, recordAuditEvent }) {
    const reservedEntityId = createSafeId<"entity">();
    const claimed = yield* Result.await(
      safeDb(async (tx) => {
        const candidate =
          await tx.query.legalListGenerationCandidates.findFirst({
            where: {
              id: { eq: body.candidateId },
              runId: { eq: body.runId },
              listId: { eq: body.listId },
              workspaceId: { eq: workspaceId },
            },
            with: { sources: true },
          });
        if (!candidate) {
          return { status: "missing" as const };
        }
        if (candidate.status === "accepted" && candidate.acceptedEntityId) {
          return {
            status: "accepted" as const,
            entityId: candidate.acceptedEntityId,
          };
        }
        if (candidate.status === "accepting" && candidate.reservedEntityId) {
          return { status: "claimed" as const, candidate };
        }
        if (candidate.status !== "pending") {
          return { status: "conflict" as const };
        }
        const row = await tx
          .update(legalListGenerationCandidates)
          .set({
            status: "accepting",
            reservedEntityId,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(legalListGenerationCandidates.id, body.candidateId),
              eq(legalListGenerationCandidates.workspaceId, workspaceId),
              eq(legalListGenerationCandidates.status, "pending"),
            ),
          )
          .returning({ id: legalListGenerationCandidates.id });
        if (!row.at(0)) {
          return { status: "conflict" as const };
        }
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.LEGAL_LIST_GENERATION,
          resourceId: body.runId,
          metadata: {
            operation: "candidate_acceptance_claimed",
            candidateId: body.candidateId,
          },
        });
        return {
          status: "claimed" as const,
          candidate: { ...candidate, reservedEntityId },
        };
      }),
    );

    if (claimed.status === "missing") {
      return Result.err(
        new HandlerError({ status: 404, message: "Candidate not found" }),
      );
    }
    if (claimed.status === "conflict") {
      return Result.err(
        new HandlerError({ status: 409, message: "Candidate is not pending" }),
      );
    }
    if (claimed.status === "accepted") {
      return Result.ok({ entityId: claimed.entityId });
    }
    const acceptedEntityId = claimed.candidate.reservedEntityId;
    if (!acceptedEntityId) {
      return Result.err(
        new HandlerError({
          status: 409,
          message: "Candidate reservation is missing",
        }),
      );
    }

    const existingItem = yield* Result.await(
      safeDb((tx) =>
        tx.query.legalListItems.findFirst({
          where: {
            entityId: { eq: acceptedEntityId },
            listId: { eq: body.listId },
            workspaceId: { eq: workspaceId },
          },
          columns: { entityId: true },
        }),
      ),
    );
    const taskResult = existingItem
      ? Result.ok({ entityId: existingItem.entityId })
      : await Result.gen(() =>
          createTaskEntityHandler({
            safeDb,
            workspaceId,
            userId: user.id,
            recordAuditEvent,
            entityId: acceptedEntityId,
            body: {
              name: claimed.candidate.name,
              listItemType: claimed.candidate.itemType,
              dueDate: claimed.candidate.dueDate,
              assigneeIds: claimed.candidate.suggestedAssigneeUserIds,
              listId: body.listId,
              listDescription: claimed.candidate.description,
              ...(claimed.candidate.itemStatus && {
                status: claimed.candidate.itemStatus,
              }),
              ...(claimed.candidate.priority && {
                priority: claimed.candidate.priority,
              }),
              ...(body.sectionId && { listSectionId: body.sectionId }),
            },
          }),
        );
    if (taskResult.isErr()) {
      yield* Result.await(
        safeDb(async (tx) => {
          await tx
            .update(legalListGenerationCandidates)
            .set({
              status: "pending",
              reservedEntityId: null,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(legalListGenerationCandidates.id, body.candidateId),
                eq(legalListGenerationCandidates.workspaceId, workspaceId),
                eq(legalListGenerationCandidates.status, "accepting"),
              ),
            );
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.LEGAL_LIST_GENERATION,
            resourceId: body.runId,
            metadata: {
              operation: "candidate_acceptance_released",
              candidateId: body.candidateId,
            },
          });
        }),
      );
      return Result.err(taskResult.error);
    }

    const entityId = taskResult.value.entityId;
    yield* Result.await(
      safeDb(async (tx) => {
        await tx.insert(legalListItemSources).values(
          claimed.candidate.sources.map((source) => ({
            id: createSafeId<"legalListItemSource">(),
            workspaceId,
            listId: body.listId,
            itemEntityId: entityId,
            sourceEntityId: source.sourceEntityId,
            sourceEntityVersionId: source.sourceEntityVersionId,
            locator: source.locator,
            quote: source.quote,
            createdBy: user.id,
          })),
        );
        await tx
          .update(legalListGenerationCandidates)
          .set({
            status: "accepted",
            acceptedEntityId: entityId,
            reservedEntityId: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(legalListGenerationCandidates.id, body.candidateId),
              eq(legalListGenerationCandidates.workspaceId, workspaceId),
              eq(legalListGenerationCandidates.status, "accepting"),
            ),
          );

        const pending = await tx.query.legalListGenerationCandidates.findFirst({
          where: {
            runId: { eq: body.runId },
            workspaceId: { eq: workspaceId },
            status: { in: ["pending", "accepting"] },
          },
          columns: { id: true },
        });
        if (!pending) {
          await tx
            .update(legalListGenerationRuns)
            .set({ status: "committed", updatedAt: new Date() })
            .where(
              and(
                eq(legalListGenerationRuns.id, body.runId),
                eq(legalListGenerationRuns.workspaceId, workspaceId),
              ),
            );
        }
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.LEGAL_LIST_GENERATION,
          resourceId: body.runId,
          metadata: {
            operation: "candidate_accepted",
            candidateId: body.candidateId,
            entityId,
          },
        });
      }),
    );
    return Result.ok({ entityId });
  },
);

export default acceptGenerationCandidate;
