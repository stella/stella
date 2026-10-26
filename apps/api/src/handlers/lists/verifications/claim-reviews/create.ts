/**
 * Record one reviewer action on a verification claim. Each action is its own
 * append-only event, so the claim's review is always the fold of who did what
 * and when; this handler never rewrites an earlier event.
 */

import { panic, Result } from "better-result";
import * as v from "valibot";

import { legalListClaimReviewEvents } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIST_VERIFICATION_FEATURE_ID } from "@/api/lib/feature-access/registry";
import {
  CLAIM_OVERRIDE_STATES,
  CLAIM_REVIEW_STATUSES,
  VERIFICATION_LIMITS,
} from "@/api/lib/lists/verification/contract";
import {
  readClaimForReview,
  readClaimReviews,
  serializeClaimReview,
} from "@/api/lib/lists/verification/read-run";
import type { ClaimReviewEventRejection } from "@/api/lib/lists/verification/review-fold";
import {
  EMPTY_CLAIM_REVIEW,
  rejectReviewEvent,
} from "@/api/lib/lists/verification/review-fold";

// `v.picklist` over the const tuples keeps the literal unions in the
// inferred body type, which the web client reads its types from.

/** Events are stored as sent and never rewritten, so a key the schema does
 *  not name is refused rather than kept. */
const eventSchema = v.union([
  v.strictObject({
    kind: v.literal("status"),
    status: v.nullable(v.picklist(CLAIM_REVIEW_STATUSES)),
  }),
  v.strictObject({
    kind: v.literal("override"),
    state: v.nullable(v.picklist(CLAIM_OVERRIDE_STATES)),
  }),
  v.strictObject({
    kind: v.literal("note"),
    note: v.pipe(v.string(), v.maxLength(VERIFICATION_LIMITS.NOTE_MAX)),
  }),
  v.strictObject({ kind: v.literal("reopen") }),
  v.strictObject({
    kind: v.literal("record-conflict"),
    resolution: v.nullable(
      v.union([
        v.strictObject({
          kind: v.literal("governed"),
          factEntityId: resourceIdSchema("entity"),
        }),
        v.strictObject({ kind: v.literal("escalated") }),
      ]),
    ),
  }),
]);

const bodySchema = v.object({
  runId: resourceIdSchema("legalListVerificationRun"),
  claimId: resourceIdSchema("legalListClaim"),
  event: eventSchema,
});

const config = {
  contract: "patch",
  featureAccess: { featureId: LIST_VERIFICATION_FEATURE_ID, type: "required" },
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
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    reason: "document_processing",
    consumesServices: false,
  },
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
        const claim = await readClaimForReview({
          tx,
          workspaceId,
          runId,
          claimId,
        });
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
