import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { abortableTx } from "@/api/db/safe-db";
import {
  entities,
  legalListGenerationCandidates,
  legalListGenerationCandidateSources,
  legalListGenerationRuns,
  legalListItemSources,
  WORK_OBLIGATION_SOURCE,
} from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { createTaskEntityHandler } from "@/api/lib/tasks/create-task-entity";
import { isWorkObligationEligible } from "@/api/lib/work-obligations/eligibility";

const bodySchema = t.Object({
  listId: tSafeId("legalList"),
  runId: tSafeId("legalListGenerationRun"),
  candidateId: tSafeId("legalListGenerationCandidate"),
  sectionId: t.Optional(tSafeId("legalListSection")),
});
const config = {
  description:
    "Accept one candidate from a generation run: create the item it proposes " +
    "as a task in the matter, optionally in a named section, and copy the " +
    "candidate's sources onto the new item with their locators and quotes. " +
    "The candidate is claimed before the item is created, so two concurrent " +
    "accepts cannot both produce one, and the run flips to committed once no " +
    "candidate is left pending. A candidate whose sources have disappeared " +
    "is refused and the reserved item is cleaned up.",
  permissions: { entity: ["create"] },
  mcp: { type: "capability", reason: "workflow_orchestration" },
  body: bodySchema,
} satisfies HandlerConfig;

/** Candidate source ids are unique uuids, so byte order is a total order. */
const byCandidateSourceId = (
  left: { id: string },
  right: { id: string },
): number => (left.id < right.id ? -1 : 1);

type AcceptanceDependencies = {
  createTaskEntityHandler: typeof createTaskEntityHandler;
};

const DEFAULT_ACCEPTANCE_DEPENDENCIES: AcceptanceDependencies = {
  createTaskEntityHandler,
};

export const createAcceptGenerationCandidate = (
  dependencies: AcceptanceDependencies = DEFAULT_ACCEPTANCE_DEPENDENCIES,
) =>
  createSafeHandler(
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
            const existingItem = await tx.query.legalListItems.findFirst({
              where: {
                entityId: { eq: candidate.reservedEntityId },
                listId: { eq: body.listId },
                workspaceId: { eq: workspaceId },
              },
              columns: { entityId: true },
            });
            if (existingItem) {
              return { status: "claimed" as const, candidate };
            }
            const resumed = await tx
              .update(legalListGenerationCandidates)
              .set({ reservedEntityId, updatedAt: new Date() })
              .where(
                and(
                  eq(legalListGenerationCandidates.id, body.candidateId),
                  eq(legalListGenerationCandidates.runId, body.runId),
                  eq(legalListGenerationCandidates.listId, body.listId),
                  eq(legalListGenerationCandidates.workspaceId, workspaceId),
                  eq(legalListGenerationCandidates.status, "accepting"),
                  eq(
                    legalListGenerationCandidates.reservedEntityId,
                    candidate.reservedEntityId,
                  ),
                ),
              )
              .returning({ id: legalListGenerationCandidates.id });
            if (!resumed.at(0)) {
              return { status: "conflict" as const };
            }
            await recordAuditEvent(tx, {
              action: AUDIT_ACTION.UPDATE,
              resourceType: AUDIT_RESOURCE_TYPE.LEGAL_LIST_GENERATION,
              resourceId: body.runId,
              metadata: {
                operation: "candidate_acceptance_resumed",
                candidateId: body.candidateId,
              },
            });
            return {
              status: "claimed" as const,
              candidate: { ...candidate, reservedEntityId },
            };
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
                eq(legalListGenerationCandidates.runId, body.runId),
                eq(legalListGenerationCandidates.listId, body.listId),
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
          new HandlerError({
            status: 409,
            message: "Candidate is not pending",
          }),
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

      // Whether this request created the task entity or adopted one an earlier
      // acceptance attempt already committed. Deleting an adopted entity cascades
      // through legal_list_items_entity_fk and takes a live list item, its
      // sources, and its assignees with it, none of which this request wrote.
      type AcceptanceEntityOwnership = "created-here" | "adopted";

      type ReleaseAcceptanceOptions = {
        reason: string;
        entityOwnership: AcceptanceEntityOwnership;
      };

      const cleanupAcceptance = async ({
        reason,
        entityOwnership,
      }: ReleaseAcceptanceOptions) =>
        await safeDb(async (tx) => {
          const current = (
            await tx
              .select({
                acceptedEntityId:
                  legalListGenerationCandidates.acceptedEntityId,
                reservedEntityId:
                  legalListGenerationCandidates.reservedEntityId,
                status: legalListGenerationCandidates.status,
              })
              .from(legalListGenerationCandidates)
              .where(
                and(
                  eq(legalListGenerationCandidates.id, body.candidateId),
                  eq(legalListGenerationCandidates.runId, body.runId),
                  eq(legalListGenerationCandidates.listId, body.listId),
                  eq(legalListGenerationCandidates.workspaceId, workspaceId),
                ),
              )
              .for("update")
          ).at(0);
          if (
            current?.status === "accepted" &&
            current.acceptedEntityId === acceptedEntityId
          ) {
            return { status: "accepted" as const };
          }

          if (entityOwnership === "created-here") {
            await tx
              .delete(entities)
              .where(
                and(
                  eq(entities.id, acceptedEntityId),
                  eq(entities.workspaceId, workspaceId),
                ),
              );
          }

          if (
            current?.status !== "accepting" ||
            current.reservedEntityId !== acceptedEntityId
          ) {
            return { status: "orphan-cleaned" as const };
          }
          const released = await tx
            .update(legalListGenerationCandidates)
            .set({
              status: "pending",
              reservedEntityId: null,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(legalListGenerationCandidates.id, body.candidateId),
                eq(legalListGenerationCandidates.runId, body.runId),
                eq(legalListGenerationCandidates.listId, body.listId),
                eq(legalListGenerationCandidates.workspaceId, workspaceId),
                eq(legalListGenerationCandidates.status, "accepting"),
                eq(
                  legalListGenerationCandidates.reservedEntityId,
                  acceptedEntityId,
                ),
              ),
            )
            .returning({ id: legalListGenerationCandidates.id });
          if (!released.at(0)) {
            return { status: "orphan-cleaned" as const };
          }
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.LEGAL_LIST_GENERATION,
            resourceId: body.runId,
            metadata: {
              operation: "candidate_acceptance_released",
              candidateId: body.candidateId,
              reason,
            },
          });
          return { status: "released" as const };
        });

      const existingItemResult = await safeDb((tx) =>
        tx.query.legalListItems.findFirst({
          where: {
            entityId: { eq: acceptedEntityId },
            listId: { eq: body.listId },
            workspaceId: { eq: workspaceId },
          },
          columns: { entityId: true },
        }),
      );
      if (existingItemResult.isErr()) {
        // The lookup failed, so this request never reached entity creation and
        // owns nothing to delete.
        const cleanup = await cleanupAcceptance({
          reason: "item_lookup_failed",
          entityOwnership: "adopted",
        });
        if (cleanup.isOk() && cleanup.value.status === "accepted") {
          return Result.ok({ entityId: acceptedEntityId });
        }
        return Result.err(existingItemResult.error);
      }
      const entityOwnership: AcceptanceEntityOwnership =
        existingItemResult.value ? "adopted" : "created-here";

      // The row the model proposed cites documents in the matter, and the
      // governed obligation records where its deadline came from. Ordering by
      // id matches the candidate-sources index, so replaying an acceptance
      // attributes the obligation to the same document every time. Only an
      // actionable row gets an obligation at all, so only it carries
      // provenance; the sources are copied onto every accepted row regardless.
      const firstSource = claimed.candidate.sources
        .toSorted(byCandidateSourceId)
        .at(0);
      const workObligationSource =
        firstSource && isWorkObligationEligible(claimed.candidate.itemType)
          ? {
              type: WORK_OBLIGATION_SOURCE.DOCUMENT,
              description: null,
              entityId: firstSource.sourceEntityId,
            }
          : undefined;

      const taskResult = existingItemResult.value
        ? Result.ok({ entityId: existingItemResult.value.entityId })
        : await Result.gen(() =>
            dependencies.createTaskEntityHandler({
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
              ...(workObligationSource ? { workObligationSource } : {}),
            }),
          );
      if (taskResult.isErr()) {
        // Only reachable when this request ran the task creation itself.
        const cleanup = await cleanupAcceptance({
          reason: "task_creation_failed",
          entityOwnership: "created-here",
        });
        if (cleanup.isErr()) {
          return Result.err(cleanup.error);
        }
        if (cleanup.value.status === "accepted") {
          return Result.ok({ entityId: acceptedEntityId });
        }
        return Result.err(taskResult.error);
      }

      const entityId = taskResult.value.entityId;

      // Releasing the reservation after the finalizing transaction gave up. The
      // entity is deleted only when this request created it: an item the previous
      // attempt already committed is live user data that a release must leave
      // alone.
      const releaseLostClaim = async (reason: string) => {
        const cleanup = await cleanupAcceptance({ reason, entityOwnership });
        if (cleanup.isErr()) {
          return Result.err(cleanup.error);
        }
        if (cleanup.value.status === "accepted") {
          return Result.ok({ entityId });
        }
        return Result.err(
          new HandlerError({
            status: 409,
            message: "Candidate claim was lost",
          }),
        );
      };

      const finalizedResult = await abortableTx(safeDb, async (tx) => {
        const run = (
          await tx
            .select({ id: legalListGenerationRuns.id })
            .from(legalListGenerationRuns)
            .where(
              and(
                eq(legalListGenerationRuns.id, body.runId),
                eq(legalListGenerationRuns.listId, body.listId),
                eq(legalListGenerationRuns.workspaceId, workspaceId),
              ),
            )
            .for("update")
        ).at(0);
        if (!run) {
          return { status: "conflict" as const };
        }
        const liveCandidate = (
          await tx
            .select({
              acceptedEntityId: legalListGenerationCandidates.acceptedEntityId,
              reservedEntityId: legalListGenerationCandidates.reservedEntityId,
              status: legalListGenerationCandidates.status,
            })
            .from(legalListGenerationCandidates)
            .where(
              and(
                eq(legalListGenerationCandidates.id, body.candidateId),
                eq(legalListGenerationCandidates.runId, body.runId),
                eq(legalListGenerationCandidates.listId, body.listId),
                eq(legalListGenerationCandidates.workspaceId, workspaceId),
              ),
            )
            .for("update")
        ).at(0);
        if (
          liveCandidate?.status === "accepted" &&
          liveCandidate.acceptedEntityId === entityId
        ) {
          return { status: "accepted" as const };
        }
        if (
          liveCandidate?.status !== "accepting" ||
          liveCandidate.reservedEntityId !== entityId
        ) {
          return { status: "conflict" as const };
        }
        const liveSources = await tx
          .select({
            id: legalListGenerationCandidateSources.id,
            sourceEntityId: legalListGenerationCandidateSources.sourceEntityId,
            sourceEntityVersionId:
              legalListGenerationCandidateSources.sourceEntityVersionId,
            locator: legalListGenerationCandidateSources.locator,
            quote: legalListGenerationCandidateSources.quote,
          })
          .from(legalListGenerationCandidateSources)
          .where(
            and(
              eq(
                legalListGenerationCandidateSources.candidateId,
                body.candidateId,
              ),
              eq(legalListGenerationCandidateSources.runId, body.runId),
              eq(legalListGenerationCandidateSources.listId, body.listId),
              eq(legalListGenerationCandidateSources.workspaceId, workspaceId),
            ),
          )
          .for("update");
        const claimedSourceIds = new Set(
          claimed.candidate.sources.map((source) => source.id),
        );
        if (
          liveSources.length === 0 ||
          liveSources.length !== claimedSourceIds.size ||
          liveSources.some((source) => !claimedSourceIds.has(source.id))
        ) {
          return { status: "source-missing" as const };
        }
        await tx.insert(legalListItemSources).values(
          liveSources.map((source) => ({
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
        const accepted = await tx
          .update(legalListGenerationCandidates)
          .set({
            status: "accepted",
            acceptedEntityId: entityId,
            acceptedEntityWorkspaceId: workspaceId,
            reservedEntityId: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(legalListGenerationCandidates.id, body.candidateId),
              eq(legalListGenerationCandidates.runId, body.runId),
              eq(legalListGenerationCandidates.listId, body.listId),
              eq(legalListGenerationCandidates.workspaceId, workspaceId),
              eq(legalListGenerationCandidates.status, "accepting"),
              eq(legalListGenerationCandidates.reservedEntityId, entityId),
            ),
          )
          .returning({ id: legalListGenerationCandidates.id });
        if (!accepted.at(0)) {
          // The item source rows were inserted just above, so returning here
          // would commit sources for an item this candidate never accepted.
          throw new HandlerError({
            status: 409,
            message: "Candidate claim was lost",
          });
        }

        const pending = await tx.query.legalListGenerationCandidates.findFirst({
          where: {
            runId: { eq: body.runId },
            listId: { eq: body.listId },
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
                eq(legalListGenerationRuns.listId, body.listId),
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
        return { status: "accepted" as const };
      });
      if (finalizedResult.isErr()) {
        // A lost claim aborts the transaction rather than committing the staged
        // source rows, so it arrives as the thrown HandlerError; anything else is
        // a database failure.
        if (HandlerError.is(finalizedResult.error)) {
          return await releaseLostClaim("claim_lost");
        }
        const cleanup = await cleanupAcceptance({
          reason: "finalization_failed",
          entityOwnership,
        });
        if (cleanup.isOk() && cleanup.value.status === "accepted") {
          return Result.ok({ entityId });
        }
        return Result.err(finalizedResult.error);
      }
      const finalized = finalizedResult.value;
      if (finalized.status === "conflict") {
        return await releaseLostClaim("claim_lost");
      }
      if (finalized.status === "source-missing") {
        const cleanup = await cleanupAcceptance({
          reason: "source_missing",
          entityOwnership,
        });
        if (cleanup.isErr()) {
          return Result.err(cleanup.error);
        }
        if (cleanup.value.status === "accepted") {
          return Result.ok({ entityId });
        }
        return Result.err(
          new HandlerError({
            status: 409,
            message: "Candidate source is no longer available",
          }),
        );
      }
      return Result.ok({ entityId });
    },
  );

const acceptGenerationCandidate = createAcceptGenerationCandidate();

export default acceptGenerationCandidate;
