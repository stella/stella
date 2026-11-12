/**
 * The review history of a verification run: every reviewer action, newest
 * first, each with who took it, when, why, and where the claim stood just
 * before and just after. Before and after are folded from the append-only
 * events (`claimReviewSteps`), never stored beside them.
 *
 * Bounded by construction: a page names at most `HISTORY_PAGE_MAX` events,
 * and the fold behind it reads only the claims on that page, each capped at
 * `REVIEW_EVENTS_PER_CLAIM_MAX` actions.
 */

import { panic } from "better-result";
import { and, asc, desc, eq, inArray, isNotNull } from "drizzle-orm";

import { member, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  legalListClaimReviewEvents,
  legalListClaims,
  legalListVerificationRuns,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { createTimestampIdCursorCodec } from "@/api/lib/db-pagination";
import type { ParsedPgTimestampCursor } from "@/api/lib/db-pagination";
import { readBounded } from "@/api/lib/db/read-bounded";
import type {
  ClaimReviewAction,
  ClaimReviewEventKind,
  StoredClaimReviewEventPayload,
} from "@/api/lib/lists/verification/contract";
import {
  reviewReasonOf,
  VERIFICATION_LIMITS,
} from "@/api/lib/lists/verification/contract";
import type { ClaimDisposition } from "@/api/lib/lists/verification/review-fold";
import {
  claimDisposition,
  claimReviewSteps,
} from "@/api/lib/lists/verification/review-fold";
import { createCursorPage } from "@/api/lib/pagination";
import { brandPersistedLegalListClaimReviewEventId } from "@/api/lib/safe-id-boundaries";

export const reviewHistoryCursor = createTimestampIdCursorCodec({
  column: legalListClaimReviewEvents.createdAt,
  brandId: brandPersistedLegalListClaimReviewEventId,
});

type ReviewHistoryCursor = {
  timestamp: ParsedPgTimestampCursor;
  id: SafeId<"legalListClaimReviewEvent">;
};

type ReadReviewHistoryArgs = {
  tx: Pick<Transaction, "select" | "selectDistinct">;
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  runId: SafeId<"legalListVerificationRun">;
  /** Narrow to one claim's history; omitted lists the whole run. */
  claimId?: SafeId<"legalListClaim">;
  kind?: ClaimReviewEventKind;
  /** Narrow to one reviewer's actions. */
  actorId?: string;
  cursor: ReviewHistoryCursor | null;
  limit: number;
};

/** Who took an action: a member of the organization, or someone whose
 *  account or membership is gone (the event keeps no name for them). */
type HistoryActor =
  | { type: "member"; id: string; name: string; image: string | null }
  | { type: "former" };

const historyActor = (row: {
  actorId: string | null;
  actorName: string | null;
  actorImage: string | null;
}): HistoryActor =>
  row.actorId === null || row.actorName === null
    ? { type: "former" }
    : {
        type: "member",
        id: row.actorId,
        name: row.actorName,
        image: row.actorImage,
      };

/** The action itself without its reason, which the entry states apart. */
const actionOf = ({
  reason: _reason,
  ...action
}: StoredClaimReviewEventPayload): ClaimReviewAction => action;

/** Whether the run, and the claim when one is named, exist in the
 *  workspace. */
const readHistoryTarget = async ({
  tx,
  workspaceId,
  runId,
  claimId,
}: Pick<ReadReviewHistoryArgs, "tx" | "workspaceId" | "runId" | "claimId">) => {
  const run = await tx
    .select({ id: legalListVerificationRuns.id })
    .from(legalListVerificationRuns)
    .where(
      and(
        eq(legalListVerificationRuns.id, runId),
        eq(legalListVerificationRuns.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  if (run.length === 0) {
    return "run-not-found";
  }
  if (claimId === undefined) {
    return "found";
  }
  const claim = await tx
    .select({ id: legalListClaims.id })
    .from(legalListClaims)
    .where(
      and(
        eq(legalListClaims.id, claimId),
        eq(legalListClaims.runId, runId),
        eq(legalListClaims.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  return claim.length === 0 ? "claim-not-found" : "found";
};

/**
 * One page of a run's review history, newest first, or which of the run and
 * the named claim the workspace does not hold. `reviewers` names everyone
 * who acted on the run, for a filter by reviewer, unless there are more than
 * the cap. Read inside the caller's transaction so the page and the fold
 * behind it agree.
 */
export const readReviewHistory = async ({
  tx,
  workspaceId,
  organizationId,
  runId,
  claimId,
  kind,
  actorId,
  cursor,
  limit,
}: ReadReviewHistoryArgs) => {
  const target = await readHistoryTarget({
    tx,
    workspaceId,
    runId,
    ...(claimId === undefined ? {} : { claimId }),
  });
  if (target !== "found") {
    return { type: target } as const;
  }
  const events = legalListClaimReviewEvents;
  const actorJoin = and(
    eq(member.userId, events.actorId),
    eq(member.organizationId, organizationId),
  );
  const rows = await tx
    .select({
      id: events.id,
      claimId: events.claimId,
      actorId: events.actorId,
      actorName: user.name,
      actorImage: user.image,
      createdAt: events.createdAt,
      createdAtCursor: reviewHistoryCursor.cursorValue.as("created_at_cursor"),
    })
    .from(events)
    .leftJoin(member, actorJoin)
    .leftJoin(user, eq(user.id, member.userId))
    .where(
      and(
        eq(events.workspaceId, workspaceId),
        eq(events.runId, runId),
        claimId === undefined ? undefined : eq(events.claimId, claimId),
        kind === undefined ? undefined : eq(events.kind, kind),
        actorId === undefined ? undefined : eq(events.actorId, actorId),
        cursor === null
          ? undefined
          : reviewHistoryCursor.keysetAfter({
              cursor,
              direction: "descending",
              idColumn: events.id,
            }),
      ),
    )
    .orderBy(desc(events.createdAt), desc(events.id))
    .limit(limit + 1);
  const page = createCursorPage({
    rows,
    limit,
    cursorForItem: (row) =>
      reviewHistoryCursor.encode(row.createdAtCursor, row.id),
  });

  const claimIds = [...new Set(page.items.map((row) => row.claimId))];
  const steps = await readClaimSteps({ tx, workspaceId, runId, claimIds });

  const reviewers = await readBounded(
    tx
      .selectDistinct({
        id: user.id,
        name: user.name,
        image: user.image,
      })
      .from(events)
      .innerJoin(member, actorJoin)
      .innerJoin(user, eq(user.id, member.userId))
      .where(
        and(
          eq(events.workspaceId, workspaceId),
          eq(events.runId, runId),
          isNotNull(events.actorId),
        ),
      )
      .orderBy(asc(user.name), asc(user.id)),
    VERIFICATION_LIMITS.HISTORY_REVIEWERS_MAX,
  );

  const history = {
    items: page.items.map((row) => {
      const step =
        steps.get(row.id) ?? panic("A history event is missing from its fold");
      return {
        id: row.id,
        claimId: row.claimId,
        kind: step.payload.kind,
        actor: historyActor(row),
        createdAt: row.createdAt.toISOString(),
        action: actionOf(step.payload),
        reason: reviewReasonOf(step.payload),
        before: step.before,
        after: step.after,
      };
    }),
    nextCursor: page.nextCursor,
    limit,
    reviewers:
      reviewers.type === "complete"
        ? ({ type: "complete", items: reviewers.rows } as const)
        : ({ type: "overflow", cap: reviewers.cap } as const),
  };
  return { type: "read", history } as const;
};

type ReadClaimStepsArgs = {
  tx: Pick<Transaction, "select">;
  workspaceId: SafeId<"workspace">;
  runId: SafeId<"legalListVerificationRun">;
  claimIds: readonly SafeId<"legalListClaim">[];
};

type ClaimStep = {
  payload: StoredClaimReviewEventPayload;
  before: ClaimDisposition;
  after: ClaimDisposition;
};

/** Each event of these claims with the disposition it found and left. */
const readClaimSteps = async ({
  tx,
  workspaceId,
  runId,
  claimIds,
}: ReadClaimStepsArgs) => {
  const byEvent = new Map<SafeId<"legalListClaimReviewEvent">, ClaimStep>();
  if (claimIds.length === 0) {
    return byEvent;
  }
  const claims = await tx
    .select({
      id: legalListClaims.id,
      state: legalListClaims.state,
      refs: legalListClaims.refs,
      recordConflict: legalListClaims.recordConflict,
    })
    .from(legalListClaims)
    .where(
      and(
        eq(legalListClaims.workspaceId, workspaceId),
        eq(legalListClaims.runId, runId),
        inArray(legalListClaims.id, [...claimIds]),
      ),
    )
    .limit(claimIds.length);
  const events = await tx
    .select({
      id: legalListClaimReviewEvents.id,
      claimId: legalListClaimReviewEvents.claimId,
      payload: legalListClaimReviewEvents.payload,
      actorId: legalListClaimReviewEvents.actorId,
      createdAt: legalListClaimReviewEvents.createdAt,
    })
    .from(legalListClaimReviewEvents)
    .where(
      and(
        eq(legalListClaimReviewEvents.workspaceId, workspaceId),
        eq(legalListClaimReviewEvents.runId, runId),
        inArray(legalListClaimReviewEvents.claimId, [...claimIds]),
      ),
    )
    // The fold's order, as `readClaimReviews` reads it.
    .orderBy(
      asc(legalListClaimReviewEvents.createdAt),
      asc(legalListClaimReviewEvents.id),
    )
    .limit(claimIds.length * VERIFICATION_LIMITS.REVIEW_EVENTS_PER_CLAIM_MAX);
  const eventsByClaim = Map.groupBy(events, (event) => event.claimId);
  for (const claim of claims) {
    const claimSteps = claimReviewSteps(
      eventsByClaim.get(claim.id) ??
        panic("A claim on a history page has no events"),
    );
    for (const { event, before, after } of claimSteps) {
      // Rows from before reasons were required carry none; widen to the
      // stored shape so their reason reads as unrecorded.
      const payload: StoredClaimReviewEventPayload = event.payload;
      byEvent.set(event.id, {
        payload,
        before: claimDisposition(claim, before),
        after: claimDisposition(claim, after),
      });
    }
  }
  return byEvent;
};
