import { and, eq } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  legalListGenerationCandidates,
  legalListGenerationCandidateSources,
  legalListGenerationRuns,
} from "@/api/db/schema";
import type { AcceptanceBody } from "@/api/handlers/lists/generation-candidates/acceptance/create";
import type { SafeId } from "@/api/lib/branded-types";
import {
  withAggregateRowQuery,
  withAggregateSetQuery,
} from "@/api/lib/db/aggregate-lock";

type LockAcceptanceCandidateOptions = {
  body: AcceptanceBody;
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
};

export const lockAcceptanceCandidate = async ({
  body,
  tx,
  workspaceId,
}: LockAcceptanceCandidateOptions) => {
  const currentAcquisition = await withAggregateRowQuery({
    tx,
    aggregate: "listGenerationCandidate",
    id: { id: body.candidateId, workspaceId },
    mode: "update",
    select: (lockTx) =>
      lockTx
        .select({
          id: legalListGenerationCandidates.id,
          workspaceId: legalListGenerationCandidates.workspaceId,
          acceptedEntityId: legalListGenerationCandidates.acceptedEntityId,
          reservedEntityId: legalListGenerationCandidates.reservedEntityId,
          status: legalListGenerationCandidates.status,
        })
        .from(legalListGenerationCandidates),
    where: and(
      eq(legalListGenerationCandidates.id, body.candidateId),
      eq(legalListGenerationCandidates.runId, body.runId),
      eq(legalListGenerationCandidates.listId, body.listId),
      eq(legalListGenerationCandidates.workspaceId, workspaceId),
    ),
  });
  return currentAcquisition.rows.at(0);
};

type LockAcceptanceFinalizationOptions = LockAcceptanceCandidateOptions & {
  claimedSources: (typeof legalListGenerationCandidateSources.$inferSelect)[];
  entityId: SafeId<"entity">;
};

export const lockAcceptanceFinalization = async ({
  body,
  claimedSources,
  entityId,
  tx,
  workspaceId,
}: LockAcceptanceFinalizationOptions) => {
  const runAcquisition = await withAggregateRowQuery({
    tx,
    aggregate: "listGenerationRun",
    id: { id: body.runId, workspaceId },
    mode: "update",
    select: (lockTx) =>
      lockTx
        .select({
          id: legalListGenerationRuns.id,
          workspaceId: legalListGenerationRuns.workspaceId,
        })
        .from(legalListGenerationRuns),
    where: and(
      eq(legalListGenerationRuns.id, body.runId),
      eq(legalListGenerationRuns.listId, body.listId),
      eq(legalListGenerationRuns.workspaceId, workspaceId),
    ),
  });
  const run = runAcquisition.rows.at(0);
  if (!run) {
    return { status: "conflict" as const };
  }
  const liveCandidate = await lockAcceptanceCandidate({
    tx,
    body,
    workspaceId,
  });
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
  const sourceAcquisition = await withAggregateSetQuery({
    tx,
    aggregate: "listGenerationSource",
    scope: {
      workspaceId,
      listId: body.listId,
      runId: body.runId,
      candidateId: body.candidateId,
    },
    mode: "update",
    select: (lockTx) =>
      lockTx
        .select({
          id: legalListGenerationCandidateSources.id,
          workspaceId: legalListGenerationCandidateSources.workspaceId,
          listId: legalListGenerationCandidateSources.listId,
          runId: legalListGenerationCandidateSources.runId,
          candidateId: legalListGenerationCandidateSources.candidateId,
          sourceEntityId: legalListGenerationCandidateSources.sourceEntityId,
          sourceEntityVersionId:
            legalListGenerationCandidateSources.sourceEntityVersionId,
          locator: legalListGenerationCandidateSources.locator,
          quote: legalListGenerationCandidateSources.quote,
        })
        .from(legalListGenerationCandidateSources),
    where: and(
      eq(legalListGenerationCandidateSources.candidateId, body.candidateId),
      eq(legalListGenerationCandidateSources.runId, body.runId),
      eq(legalListGenerationCandidateSources.listId, body.listId),
      eq(legalListGenerationCandidateSources.workspaceId, workspaceId),
    ),
  });
  const liveSources = sourceAcquisition.rows;
  const claimedSourceIds = new Set(claimedSources.map((source) => source.id));
  if (
    liveSources.length === 0 ||
    liveSources.length !== claimedSourceIds.size ||
    liveSources.some((source) => !claimedSourceIds.has(source.id))
  ) {
    return { status: "source-missing" as const };
  }
  return { status: "ready" as const, sources: liveSources };
};
