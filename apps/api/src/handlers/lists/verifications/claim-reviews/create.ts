/**
 * Record one reviewer action on a verification claim. Each action is its own
 * append-only event, so the claim's review is always the fold of who did what
 * and when; this handler never rewrites an earlier event.
 */

import { Result, panic } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { legalListClaimReviewEvents, legalListClaims } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  CLAIM_OVERRIDE_STATES,
  CLAIM_REVIEW_STATUSES,
  VERIFICATION_LIMITS,
} from "@/api/lib/lists/verification/contract";
import {
  readClaimReviews,
  serializeClaimReview,
} from "@/api/lib/lists/verification/read-run";
import type { ClaimReviewEventRejection } from "@/api/lib/lists/verification/review-fold";
import {
  EMPTY_CLAIM_REVIEW,
  rejectReviewEvent,
} from "@/api/lib/lists/verification/review-fold";

// `t.UnionEnum` keeps the literal union in the inferred body type, which
// the web client reads its event and detail types from.
const literals = <T extends string>(values: readonly T[]) =>
  t.UnionEnum([...values]);

/** Events are stored as sent and never rewritten, so a key the schema does
 *  not name is refused rather than kept. */
const STRICT = { additionalProperties: false } as const;

const eventSchema = t.Union([
  t.Object(
    {
      kind: t.Literal("status"),
      status: t.Nullable(literals(CLAIM_REVIEW_STATUSES)),
    },
    STRICT,
  ),
  t.Object(
    {
      kind: t.Literal("override"),
      state: t.Nullable(literals(CLAIM_OVERRIDE_STATES)),
    },
    STRICT,
  ),
  t.Object(
    {
      kind: t.Literal("note"),
      note: t.String({ maxLength: VERIFICATION_LIMITS.NOTE_MAX }),
    },
    STRICT,
  ),
  t.Object({ kind: t.Literal("reopen") }, STRICT),
  t.Object(
    {
      kind: t.Literal("record-conflict"),
      resolution: t.Nullable(
        t.Union([
          t.Object(
            { kind: t.Literal("governed"), factEntityId: tSafeId("entity") },
            STRICT,
          ),
          t.Object({ kind: t.Literal("escalated") }, STRICT),
        ]),
      ),
    },
    STRICT,
  ),
]);

const bodySchema = t.Object({
  runId: tSafeId("legalListVerificationRun"),
  claimId: tSafeId("legalListClaim"),
  event: eventSchema,
});

const config = {
  description:
    "Record one reviewer action on a claim of a list verification and return " +
    "the claim's review after it. `status` marks the claim reviewed or " +
    "disputed (null clears it); `override` annotates the verdict with the " +
    "reviewer's own state, beside the tool's, never replacing it; `note` sets " +
    "the review note; `reopen` reclassifies a set-aside claim as checkable; " +
    "`record-conflict` resolves a claim withheld between two records by " +
    "naming the governing fact or escalating it. Reopening and resolving a " +
    "conflict withdraw an earlier status and override.",
  permissions: { entity: ["update"] },
  mcp: { type: "capability", reason: "document_processing" },
  body: bodySchema,
} satisfies WorkspaceHandlerConfig;

const REJECTION_MESSAGES = {
  "too-many-actions": `A claim holds at most ${String(VERIFICATION_LIMITS.REVIEW_EVENTS_PER_CLAIM_MAX)} review actions.`,
  "override-on-record-conflict":
    "A claim withheld between two records is resolved with `record-conflict`, not overridden.",
  "reopen-checkable-claim":
    "Only a set-aside (not verifiable) claim can be reopened.",
  "already-reopened": "This claim has already been reopened.",
  "no-record-conflict": "This claim is not withheld between two records.",
  "governing-fact-not-in-conflict":
    "The governing fact must be one of the two records in conflict.",
} as const satisfies Record<
  ClaimReviewEventRejection | "too-many-actions",
  string
>;

const createClaimReview = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, user, body, recordAuditEvent }) {
    const { runId, claimId } = body;
    const payload =
      body.event.kind === "status"
        ? { ...body.event, origin: "single" as const }
        : body.event;

    const result = yield* Result.await(
      safeDb(async (tx) => {
        // Locking the claim serializes reviewers on it, so the fold the event
        // is validated against is the one it will be appended to.
        const claim = (
          await tx
            .select({
              state: legalListClaims.state,
              recordConflict: legalListClaims.recordConflict,
            })
            .from(legalListClaims)
            .where(
              and(
                eq(legalListClaims.id, claimId),
                eq(legalListClaims.runId, runId),
                eq(legalListClaims.workspaceId, workspaceId),
              ),
            )
            .limit(1)
            .for("update")
        ).at(0);
        if (claim === undefined) {
          return { type: "not-found" } as const;
        }

        const before = await readClaimReviews({
          tx,
          workspaceId,
          runId,
          claimIds: [claimId],
        });
        const record = before.get(claimId);
        if (
          (record?.eventCount ?? 0) >=
          VERIFICATION_LIMITS.REVIEW_EVENTS_PER_CLAIM_MAX
        ) {
          return { type: "rejected", rejection: "too-many-actions" } as const;
        }
        const rejection = rejectReviewEvent(
          claim,
          record?.review ?? EMPTY_CLAIM_REVIEW,
          payload,
        );
        if (rejection !== null) {
          return { type: "rejected", rejection } as const;
        }

        const eventId = createSafeId<"legalListClaimReviewEvent">();
        await tx.insert(legalListClaimReviewEvents).values({
          id: eventId,
          workspaceId,
          runId,
          claimId,
          kind: payload.kind,
          payload,
          actorId: user.id,
        });
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.REVIEW,
          resourceType: AUDIT_RESOURCE_TYPE.LEGAL_LIST_VERIFICATION,
          resourceId: runId,
          // The note itself stays in the event row, which lives and dies with
          // the matter; the audit log keeps only what kind of action it was.
          metadata: {
            claimId,
            eventId,
            kind: payload.kind,
            ...(payload.kind === "note" && { noteLength: payload.note.length }),
          },
        });

        const after = await readClaimReviews({
          tx,
          workspaceId,
          runId,
          claimIds: [claimId],
        });
        const review =
          after.get(claimId)?.review ??
          panic("A claim with a new event has no review");
        return { type: "recorded", review } as const;
      }),
    );

    switch (result.type) {
      case "not-found": {
        return Result.err(
          new HandlerError({ status: 404, message: "Claim not found" }),
        );
      }
      case "rejected": {
        return Result.err(
          new HandlerError({
            status: 409,
            message: REJECTION_MESSAGES[result.rejection],
          }),
        );
      }
      case "recorded": {
        return Result.ok({
          claimId,
          review: serializeClaimReview(result.review),
        });
      }
      default: {
        result satisfies never;
        return panic(`Unhandled outcome: ${String(result)}`);
      }
    }
  },
);

export default createClaimReview;
