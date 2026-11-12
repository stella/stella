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
import type { SafeId } from "@/api/lib/branded-types";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIST_VERIFICATION_FEATURE_ID } from "@/api/lib/feature-access/registry";
import {
  CLAIM_OVERRIDE_STATES,
  CLAIM_REVIEW_REASON_RULE,
  CLAIM_REVIEW_STATUSES,
  VERIFICATION_LIMITS,
} from "@/api/lib/lists/verification/contract";
import type { ClaimReviewEventPayload } from "@/api/lib/lists/verification/contract";
import {
  governingSuggestionOfClaim,
  readClaimForReview,
  readClaimReviews,
  readRunFactStandings,
  serializeClaimReview,
} from "@/api/lib/lists/verification/read-run";
import type { ClaimReviewEventRejection } from "@/api/lib/lists/verification/review-fold";
import {
  EMPTY_CLAIM_REVIEW,
  rejectReviewEvent,
} from "@/api/lib/lists/verification/review-fold";

// `v.picklist` over the const tuples keeps the literal unions in the
// inferred body type, which the web client reads its types from.

const reasonSchema = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(VERIFICATION_LIMITS.NOTE_MAX),
);

/** The reason entry each kind's rule asks for. */
const REASON_ENTRIES = {
  required: { reason: reasonSchema },
  optional: { reason: v.exactOptional(reasonSchema) },
  none: {},
} as const;

/** Events are stored as sent and never rewritten, so a key the schema does
 *  not name is refused rather than kept. */
export const claimReviewEventSchema = v.union([
  v.strictObject({
    kind: v.literal("status"),
    status: v.nullable(v.picklist(CLAIM_REVIEW_STATUSES)),
    ...REASON_ENTRIES[CLAIM_REVIEW_REASON_RULE.status],
  }),
  v.strictObject({
    kind: v.literal("override"),
    state: v.nullable(v.picklist(CLAIM_OVERRIDE_STATES)),
    ...REASON_ENTRIES[CLAIM_REVIEW_REASON_RULE.override],
  }),
  v.strictObject({
    kind: v.literal("note"),
    note: v.pipe(v.string(), v.maxLength(VERIFICATION_LIMITS.NOTE_MAX)),
    ...REASON_ENTRIES[CLAIM_REVIEW_REASON_RULE.note],
  }),
  v.strictObject({
    kind: v.literal("reopen"),
    ...REASON_ENTRIES[CLAIM_REVIEW_REASON_RULE.reopen],
  }),
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
    ...REASON_ENTRIES[CLAIM_REVIEW_REASON_RULE["record-conflict"]],
  }),
]);

const bodySchema = v.object({
  runId: resourceIdSchema("legalListVerificationRun"),
  claimId: resourceIdSchema("legalListClaim"),
  event: claimReviewEventSchema,
});

const config = {
  contract: "patch",
  idempotency: { type: "replay" },
  featureAccess: { featureId: LIST_VERIFICATION_FEATURE_ID, type: "required" },
  description:
    "Record one reviewer action on a claim of a list verification and return " +
    "the claim's review after it. `status` marks the claim reviewed, " +
    "disputed, or needs-evidence (open until the record can answer it; " +
    "null clears it); `override` annotates the verdict with the " +
    "reviewer's own state, beside the tool's, never replacing it; `note` sets " +
    "the review note; `reopen` reclassifies a set-aside claim as checkable; " +
    "`record-conflict` resolves a claim withheld between two records by " +
    "naming the governing fact or escalating it; the event also keeps which " +
    "record was suggested to govern then (a document's record over a " +
    "witness's account; see suggestedGoverningFactId in " +
    "lists.verifications.get). `override`, `reopen` and `record-conflict` " +
    "change the verdict and require `reason` (the reviewer's words, kept in " +
    "the claim's history); `status` takes an optional `reason`. Reopening " +
    "and resolving a conflict withdraw an earlier status and override.",
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

/**
 * The event as stored: what the reviewer sent, plus what the server knew at
 * that moment. A record-conflict event keeps the record that was suggested
 * to govern, so history can tell a confirmed suggestion from another choice.
 */
const storedPayload = (
  event: v.InferOutput<typeof claimReviewEventSchema>,
  suggestedFactEntityId: SafeId<"entity"> | null,
): ClaimReviewEventPayload => {
  switch (event.kind) {
    case "status": {
      return { ...event, origin: "single" };
    }
    case "record-conflict": {
      return {
        kind: event.kind,
        resolution: event.resolution,
        reason: event.reason,
        suggestedFactEntityId,
      };
    }
    case "override":
    case "note":
    case "reopen": {
      return event;
    }
    default: {
      event satisfies never;
      return panic(`Unhandled review event: ${String(event)}`);
    }
  }
};

const createClaimReview = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, user, body, recordAuditEvent }) {
    const { runId, claimId } = body;

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
        // Read only for a record-conflict event; a claim without a conflict
        // is refused below, before anything is stored.
        const suggestedFactEntityId =
          body.event.kind === "record-conflict" && claim.recordConflict !== null
            ? governingSuggestionOfClaim(
                claim,
                (await readRunFactStandings({ tx, workspaceId, runId })) ??
                  panic("A claim's run has no evidence"),
              )
            : null;
        const payload = storedPayload(body.event, suggestedFactEntityId);

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
          // The note and the reason stay in the event row, which lives and
          // dies with the matter; the audit log keeps only what kind of
          // action it was.
          metadata: {
            claimId,
            eventId,
            kind: payload.kind,
            ...(payload.kind === "note" && { noteLength: payload.note.length }),
            ...(payload.reason !== undefined && {
              reasonLength: payload.reason.length,
            }),
          },
        });

        const after = await readClaimReviews({
          tx,
          workspaceId,
          runId,
          claimIds: [claimId],
        });
        const review =
          after.get(claimId) ?? panic("A claim with a new event has no review");
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
