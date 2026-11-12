import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import * as v from "valibot";

import { LIST_ITEM_TYPE } from "@stll/api-contract/entity-options";

import type { Transaction } from "@/api/db/root";
import { abortableTx } from "@/api/db/safe-db";
import type { SafeDb } from "@/api/db/safe-db";
import {
  entities,
  legalListFactDetails,
  legalListGenerationCandidates,
  legalListGenerationCandidateSources,
  legalListGenerationRuns,
  legalListItemSources,
  WORK_OBLIGATION_SOURCE,
} from "@/api/db/schema";
import { commitSettledRun } from "@/api/handlers/lists/generation-candidates/commit-settled-run";
import { legalListRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LEGAL_LISTS_FEATURE_ID } from "@/api/lib/feature-access/registry";
import { writeFactSourceEdges } from "@/api/lib/lists/graph/fact-source-edges";
import { createTaskEntityHandler } from "@/api/lib/tasks/create-task-entity";
import type { CreateTaskFactDetails } from "@/api/lib/tasks/create-task-entity";
import { isWorkObligationEligible } from "@/api/lib/work-obligations/eligibility";

const bodySchema = v.object({
  listId: resourceIdSchema("legalList"),
  runId: resourceIdSchema("legalListGenerationRun"),
  candidateId: resourceIdSchema("legalListGenerationCandidate"),
  sectionId: v.optional(resourceIdSchema("legalListSection")),
});
const config = {
  contract: "patch",
  idempotency: { type: "replay" },
  featureAccess: { type: "required", featureId: LEGAL_LISTS_FEATURE_ID },
  description:
    "Accept one candidate from a generation run: create the item it proposes " +
    "as a task in the matter, optionally in a named section, and copy the " +
    "candidate's sources onto the new item with their locators and quotes. " +
    "An accepted fact also gets the candidate's fact details, scored as " +
    "included unless the candidate holds it. " +
    "The candidate is claimed before the item is created, so two concurrent " +
    "accepts cannot both produce one, and the run flips to committed once no " +
    "candidate is left pending. A candidate whose sources have disappeared " +
    "is refused and the reserved item is cleaned up.",
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

type AcceptanceBody = v.InferOutput<typeof bodySchema>;

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

type ClaimCandidateOptions = {
  body: AcceptanceBody;
  recordAuditEvent: AuditRecorder;
  reservedEntityId: SafeId<"entity">;
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
};

/**
 * Claims a pending candidate under `reservedEntityId`, or takes over an
 * `accepting` reservation whose list item was never written.
 */
const claimCandidate = async ({
  body,
  recordAuditEvent,
  reservedEntityId,
  tx,
  workspaceId,
}: ClaimCandidateOptions) => {
  const candidate = await tx.query.legalListGenerationCandidates.findFirst({
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
};

type ClaimedCandidate = Extract<
  Awaited<ReturnType<typeof claimCandidate>>,
  { status: "claimed" }
>["candidate"];

// Whether this request created the task entity or adopted one an earlier
// acceptance attempt already committed. Deleting an adopted entity cascades
// through legal_list_items_entity_fk and takes a live list item, its
// sources, and its assignees with it, none of which this request wrote.
type AcceptanceEntityOwnership = "created-here" | "adopted";

/** The claimed candidate and the reserved entity one acceptance works on. */
type AcceptanceScope = {
  acceptedEntityId: SafeId<"entity">;
  body: AcceptanceBody;
  recordAuditEvent: AuditRecorder;
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
};

type ReleaseAcceptanceOptions = {
  reason: string;
  entityOwnership: AcceptanceEntityOwnership;
};

const cleanupAcceptance = async (
  {
    acceptedEntityId,
    body,
    recordAuditEvent,
    safeDb,
    workspaceId,
  }: AcceptanceScope,
  { reason, entityOwnership }: ReleaseAcceptanceOptions,
) =>
  await safeDb(async (tx) => {
    const current = (
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
          eq(legalListGenerationCandidates.reservedEntityId, acceptedEntityId),
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

type ReleaseLostClaimOptions = ReleaseAcceptanceOptions & {
  entityId: SafeId<"entity">;
};

// Releasing the reservation after the finalizing transaction gave up. The
// entity is deleted only when this request created it: an item the previous
// attempt already committed is live user data that a release must leave
// alone.
const releaseLostClaim = async (
  scope: AcceptanceScope,
  { entityId, entityOwnership, reason }: ReleaseLostClaimOptions,
) => {
  const cleanup = await cleanupAcceptance(scope, { reason, entityOwnership });
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

/** A fact candidate's proposal as the item's details; unstated scoring is
 *  included. */
const acceptedFactDetails = (
  candidate: Pick<
    ClaimedCandidate,
    | "occurredOn"
    | "occurredOnPrecision"
    | "evidenceKind"
    | "medium"
    | "confidence"
    | "interpretationNote"
    | "scoring"
  >,
): CreateTaskFactDetails => ({
  occurredOn: candidate.occurredOn,
  occurredOnPrecision: candidate.occurredOnPrecision,
  evidenceKind: candidate.evidenceKind,
  medium: candidate.medium,
  confidence: candidate.confidence,
  interpretationNote: candidate.interpretationNote,
  scoring: candidate.scoring ?? "included",
});

type CreateCandidateTaskOptions = {
  body: AcceptanceBody;
  candidate: ClaimedCandidate;
  dependencies: AcceptanceDependencies;
  entityId: SafeId<"entity">;
  recordAuditEvent: AuditRecorder;
  safeDb: SafeDb;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
};

const createCandidateTask = async ({
  body,
  candidate,
  dependencies,
  entityId,
  recordAuditEvent,
  safeDb,
  userId,
  workspaceId,
}: CreateCandidateTaskOptions) => {
  // The row the model proposed cites documents in the matter, and the
  // governed obligation records where its deadline came from. Ordering by
  // id matches the candidate-sources index, so replaying an acceptance
  // attributes the obligation to the same document every time. Only an
  // actionable row gets an obligation at all, so only it carries
  // provenance; the sources are copied onto every accepted row regardless.
  const firstSource = candidate.sources.toSorted(byCandidateSourceId).at(0);
  const workObligationSource =
    firstSource && isWorkObligationEligible(candidate.itemType)
      ? {
          type: WORK_OBLIGATION_SOURCE.DOCUMENT,
          description: null,
          entityId: firstSource.sourceEntityId,
        }
      : undefined;

  return await Result.gen(() =>
    dependencies.createTaskEntityHandler({
      safeDb,
      workspaceId,
      userId,
      recordAuditEvent,
      entityId,
      body: {
        name: candidate.name,
        listItemType: candidate.itemType,
        dueDate: candidate.dueDate,
        assigneeIds: candidate.suggestedAssigneeUserIds,
        listId: body.listId,
        listDescription: candidate.description,
        ...(candidate.itemStatus && {
          status: candidate.itemStatus,
        }),
        ...(candidate.priority && {
          priority: candidate.priority,
        }),
        ...(body.sectionId && { listSectionId: body.sectionId }),
      },
      ...(workObligationSource ? { workObligationSource } : {}),
      // Written with the item, so verification never reads an accepted fact
      // before its details exist.
      ...(candidate.itemType === LIST_ITEM_TYPE.FACT
        ? { factDetails: acceptedFactDetails(candidate) }
        : {}),
    }),
  );
};

type FinalizeAcceptanceOptions = {
  body: AcceptanceBody;
  claimedSources: ClaimedCandidate["sources"];
  entityId: SafeId<"entity">;
  recordAuditEvent: AuditRecorder;
  tx: Transaction;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
};

/**
 * Under the run and candidate locks, copies the claimed sources onto the item
 * and marks the candidate accepted. Throws `HandlerError` to abort when the
 * claim is lost after the source rows were staged.
 */
const finalizeAcceptance = async ({
  body,
  claimedSources,
  entityId,
  recordAuditEvent,
  tx,
  userId,
  workspaceId,
}: FinalizeAcceptanceOptions) => {
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
        eq(legalListGenerationCandidateSources.candidateId, body.candidateId),
        eq(legalListGenerationCandidateSources.runId, body.runId),
        eq(legalListGenerationCandidateSources.listId, body.listId),
        eq(legalListGenerationCandidateSources.workspaceId, workspaceId),
      ),
    );
  // No row lock here: the application role holds no UPDATE on candidate
  // sources, which every row-locking clause needs. None is needed either:
  // the rows are insert-only, the run and candidate locks above hold off a
  // cascade from either, and a cited document deleted meanwhile fails the
  // item-source insert's foreign key check, so no copy outlives it.
  const claimedSourceIds = new Set(claimedSources.map((source) => source.id));
  if (
    liveSources.length === 0 ||
    liveSources.length !== claimedSourceIds.size ||
    liveSources.some((source) => !claimedSourceIds.has(source.id))
  ) {
    return { status: "source-missing" as const };
  }
  const itemSources = liveSources.map((source) => ({
    id: createSafeId<"legalListItemSource">(),
    source,
  }));
  await tx.insert(legalListItemSources).values(
    itemSources.map(({ id, source }) => ({
      id,
      workspaceId,
      listId: body.listId,
      itemEntityId: entityId,
      sourceEntityId: source.sourceEntityId,
      sourceEntityVersionId: source.sourceEntityVersionId,
      locator: source.locator,
      quote: source.quote,
      createdBy: userId,
    })),
  );
  // The candidate row is locked above, so its proposal cannot change under
  // this read; the item's own type is read too, since an item an earlier
  // attempt committed may have been retyped since.
  const proposal = (
    await tx
      .select({
        itemType: legalListGenerationCandidates.itemType,
        liveItemType: entities.listItemType,
        occurredOn: legalListGenerationCandidates.occurredOn,
        occurredOnPrecision: legalListGenerationCandidates.occurredOnPrecision,
        evidenceKind: legalListGenerationCandidates.evidenceKind,
        medium: legalListGenerationCandidates.medium,
        confidence: legalListGenerationCandidates.confidence,
        interpretationNote: legalListGenerationCandidates.interpretationNote,
        scoring: legalListGenerationCandidates.scoring,
      })
      .from(legalListGenerationCandidates)
      .innerJoin(
        entities,
        and(
          eq(entities.id, entityId),
          eq(entities.workspaceId, legalListGenerationCandidates.workspaceId),
        ),
      )
      .where(
        and(
          eq(legalListGenerationCandidates.id, body.candidateId),
          eq(legalListGenerationCandidates.runId, body.runId),
          eq(legalListGenerationCandidates.listId, body.listId),
          eq(legalListGenerationCandidates.workspaceId, workspaceId),
        ),
      )
  ).at(0);
  if (
    proposal?.itemType === LIST_ITEM_TYPE.FACT &&
    proposal.liveItemType === LIST_ITEM_TYPE.FACT
  ) {
    // The item is normally created with its details. This covers an item an
    // interrupted earlier attempt committed without them, so an accepted fact
    // never scores by the row's absence; a row already there wins.
    await tx
      .insert(legalListFactDetails)
      .values({
        ...acceptedFactDetails(proposal),
        itemEntityId: entityId,
        workspaceId,
        listId: body.listId,
        updatedBy: userId,
      })
      .onConflictDoNothing({ target: legalListFactDetails.itemEntityId });
  }
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
  // After the candidate reads as accepted, so each edge names the
  // extraction run that proposed its passage.
  await writeFactSourceEdges(tx, workspaceId, {
    type: "fact-sources",
    sourceIds: itemSources.map(({ id }) => id),
    producer: { type: "extraction", runId: body.runId },
  });

  await commitSettledRun(tx, {
    runId: body.runId,
    listId: body.listId,
    workspaceId,
  });
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
};

export const createAcceptGenerationCandidate = (
  dependencies: AcceptanceDependencies = DEFAULT_ACCEPTANCE_DEPENDENCIES,
) =>
  createSafeHandler(
    config,
    async function* ({ safeDb, workspaceId, user, body, recordAuditEvent }) {
      const reservedEntityId = createSafeId<"entity">();
      const claimed = yield* Result.await(
        safeDb(
          async (tx) =>
            await claimCandidate({
              body,
              recordAuditEvent,
              reservedEntityId,
              tx,
              workspaceId,
            }),
        ),
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
      const scope = {
        acceptedEntityId,
        body,
        recordAuditEvent,
        safeDb,
        workspaceId,
      } satisfies AcceptanceScope;

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
        const cleanup = await cleanupAcceptance(scope, {
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

      const taskResult = existingItemResult.value
        ? Result.ok({ entityId: existingItemResult.value.entityId })
        : await createCandidateTask({
            body,
            candidate: claimed.candidate,
            dependencies,
            entityId: acceptedEntityId,
            recordAuditEvent,
            safeDb,
            userId: user.id,
            workspaceId,
          });
      if (taskResult.isErr()) {
        // Only reachable when this request ran the task creation itself.
        const cleanup = await cleanupAcceptance(scope, {
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

      const finalizedResult = await abortableTx(
        safeDb,
        async (tx) =>
          await finalizeAcceptance({
            body,
            claimedSources: claimed.candidate.sources,
            entityId,
            recordAuditEvent,
            tx,
            userId: user.id,
            workspaceId,
          }),
      );
      if (finalizedResult.isErr()) {
        // A lost claim aborts the transaction rather than committing the staged
        // source rows, so it arrives as the thrown HandlerError; anything else is
        // a database failure.
        if (HandlerError.is(finalizedResult.error)) {
          return await releaseLostClaim(scope, {
            entityId,
            entityOwnership,
            reason: "claim_lost",
          });
        }
        const cleanup = await cleanupAcceptance(scope, {
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
        return await releaseLostClaim(scope, {
          entityId,
          entityOwnership,
          reason: "claim_lost",
        });
      }
      if (finalized.status === "source-missing") {
        const cleanup = await cleanupAcceptance(scope, {
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
