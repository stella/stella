/**
 * Turning a reference document into positions.
 *
 * One position is ONE reviewable term, typed by the kind of term it is: a
 * quantity, a list, a protection that exists or does not, or a standard of
 * wording. That type is what grading answers with, so a clause-level position
 * ("the warranty framework") is not a position at all — it is several, and it
 * is what produces whole-block rewrites downstream.
 *
 * A pass proposes at most `REVIEW_PROPOSAL_CAP` of them, spent heaviest first:
 * a reviewer confirms this list by hand, and past that length it stops being
 * read. Comparable terms the cap left out are reported as skipped, so the
 * shorter list is a stated choice rather than a silent truncation.
 *
 * Every proposed passage is verified against the parsed blocks before it is
 * returned: a position may only quote text the reference actually contains,
 * because that quoted text is what the run — and any playbook saved out of it
 * — will grade against. What the pass deliberately did not turn into a
 * position comes back as `skipped`, so the reviewer sees the size of what was
 * left out instead of assuming the checklist is exhaustive.
 *
 * Two ways out, one prompt and one normalizer behind them
 * (`reference-position-normalizer.ts`): `proposeReferencePositions` answers
 * once with the whole plan, and `streamReferenceProposal` reports each piece
 * as the model closes it. A checklist of forty terms takes minutes to write;
 * the streaming path is what stops the reviewer watching a spinner for all of
 * them.
 */

import type { ModelMessage } from "@tanstack/ai";
import { Result } from "better-result";

import {
  createPartialProposalReader,
  createProposalNormalizer,
  DEAL_SPECIFIC_VALUE_SKIP_REASON,
  LOWER_WEIGHT_SKIP_REASON,
  normalizeProposal,
  proposedPositionsSchema,
  REVIEW_PROPOSAL_CAP,
  STRUCTURAL_SKIP_REASON,
} from "@/api/handlers/document-reviews/reference-position-normalizer";
import type {
  ReferenceSource,
  ReviewPositionProposal,
  ReviewProposalEvent,
} from "@/api/handlers/document-reviews/reference-position-normalizer";
import type { AIRequestServiceTier, OrgAIConfig } from "@/api/lib/ai-config";
import { resolveCaching } from "@/api/lib/ai-config";
import {
  createTanStackAIAnalyticsCallbacks,
  type AIUsageMetering,
} from "@/api/lib/analytics/tanstack-ai";
import type { SafeId } from "@/api/lib/branded-types";
import { perspectivePartyPhrase } from "@/api/lib/document-review/contract";
import type { ReviewPerspective } from "@/api/lib/document-review/contract";
import {
  buildReviewDocumentParts,
  reviewDocumentsScopeKey,
} from "@/api/lib/document-review/review-document-messages";
import { WorkflowIntegrationError } from "@/api/lib/errors/tagged-errors";
import {
  generateTanStackObjectForRole,
  streamTanStackObjectForRole,
} from "@/api/lib/tanstack-ai-generate";
import type { PreparedDocxFile } from "@/api/lib/workflow/generate-batch";
import type { Position } from "@/api/lib/workflow/playbook-positions";

const ROLE = "pdf" as const;

/** The batch path holds a request open with nothing to show, so it fails
 *  before a reviewer gives up on it. */
const TIMEOUT_MS = 120_000;

/** The streaming path reports every position as it lands, so a long checklist
 *  is progress rather than a stall; the ceiling is what a stuck provider hits,
 *  not what a slow answer hits. */
const STREAM_TIMEOUT_MS = 300_000;

const SYSTEM_PROMPT = `You turn reference legal documents into a review checklist for a new target document (F0). References are examples, not policy and not proof of market practice.

The user message names the side the review takes. Write every position from that side.

One position is ONE reviewable term, never a clause, a section or a framework. Split anything larger into its terms. termKind says which shape it is:
- parameter: one stated quantity — a time bar, a liability cap, de minimis, a basket, a notice period, an interest rate, a period measured between two events. The issue names the term and what it applies to: "Time-bar: leakage claims", "Cap: title warranties".
- enumeration: one list-shaped definition or set of heads — Leakage limbs, Permitted Leakage items, warranty categories, the components of Losses. One position per list, and quote the block of every limb.
- presence: a defined term or protection that should exist — a "Losses" definition, a W&I policy, a MAC condition, a gross-up, a locked-box mechanism.
- language: a standard of wording with no parameter behind it — the "Fairly Disclosed" standard, a knowledge qualifier, sandbagging.

termKind is an engine field. Never name it, or any other field name, in issue, purpose or guidance: a lawyer reads those, not the engine.

issue is a short noun phrase naming the term.
purpose is ONE sentence, at most 240 characters, on the legal and economic function the term performs in this kind of deal, from the side the review takes and what it does to the other side: "Caps the seller's exposure for warranty claims; drives the buyer's recovery ceiling."
guidance is one line saying what the later comparison should examine — name the comparable attribute (the value, the limbs, whether it is present, or the wording) and the reference's stance on it — and why the severity is what it is.
severity is blocker only for money, liability-cap and time-bar terms; everything else is high, medium or low.

A value that belongs to one deal is not comparable and is never a position: calendar dates (the locked-box date, signing, closing, the long-stop date), the purchase price and any component of it, share counts and the size of a particular holding, party names, addresses, account details, and any "[●]" blank. Where a comparable term sits behind such a value, propose that term instead:
- the length between two dates rather than either date — "Locked-box period length (locked-box date to closing)", a parameter measured in months;
- whether the mechanism exists at all — "Locked-box mechanism present", a presence term;
- the rate or formula applied to the price rather than the price — "Ticking interest on the purchase price", a parameter.
Where no comparable term sits behind it, put it in skipped with the reason exactly "${DEAL_SPECIFIC_VALUE_SKIP_REASON}".

passages are the reference blocks that state the term. Cite only exact block IDs supplied in the input, only from reference documents, never from F0. Fewest that carry the term, up to twelve; for an enumeration, every limb. A term you cannot quote is not a position.

Put in skipped, and do not propose, anything else deal-specific or structural: signing and closing sequence, the difference between a preliminary and a final agreement, party names and addresses, schedule and annex lists, and execution mechanics. subject names it. reason is exactly "${STRUCTURAL_SKIP_REASON}" where the two documents are simply built differently, exactly "${DEAL_SPECIFIC_VALUE_SKIP_REASON}" where the subject is one deal's own value, and otherwise a few words on why it is not comparable.

Do not judge the target, score it, or propose wording. Do not repeat a position the reviewer already has.

parties lists the target's sides only: role is the defined term the target uses (Purchaser, Seller, Landlord, Licensee), name is the legal name when the target states it, otherwise null. Omit guarantors, agents and notaries unless they are principal parties.

Order positions by commercial weight, heaviest first: money and liability terms (the caps, the baskets, the de minimis, the indemnities), then the time bars, then whether a protection is present at all, then standards of wording. Within one of those tiers, the more severe first.

Propose at most ${String(REVIEW_PROPOSAL_CAP)} positions and stop there, even where the reference states more. A reviewer reads and confirms this list before it grades anything, and a longer one is accepted whole rather than read. Where the reference states further comparable terms that are simply lighter than the ones you proposed, put each in skipped with the reason exactly "${LOWER_WEIGHT_SKIP_REASON}", so the reviewer sees what a longer checklist would have added.

Output parties first, then positions in that order, then skipped. Finish each position completely before starting the next.`;

/** The side the review takes, stated where the model reads it: after the
 *  documents (the cached region) and before the checklist it is asked for. */
const perspectiveLine = (perspective: ReviewPerspective): string => {
  switch (perspective.type) {
    case "party":
      return `Side the review takes: ${perspectivePartyPhrase(perspective)}. Write purpose and guidance from that side.`;
    case "neutral":
      return "Side the review takes: none. Write purpose and guidance without taking a side, naming what the term does to each side instead.";
    default:
      perspective satisfies never;
      return "";
  }
};

type ProposalRequestArgs = {
  target: PreparedDocxFile;
  references: readonly ReferenceSource[];
  seededPositions: readonly Position[];
  perspective: ReviewPerspective;
  targetEntityVersionId: SafeId<"entityVersion">;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  orgAIConfig: OrgAIConfig | null;
  promptCachingEnabled: boolean;
  serviceTier: AIRequestServiceTier;
  usageMetering: AIUsageMetering;
  abortSignal: AbortSignal;
  timeoutMs: number;
};

/** Everything both paths send. One prompt, one schema, one cache scope: the
 *  streaming call and the batch call differ only in how the answer comes
 *  back. */
const buildProposalRequest = ({
  target,
  references,
  seededPositions,
  perspective,
  targetEntityVersionId,
  organizationId,
  workspaceId,
  orgAIConfig,
  promptCachingEnabled,
  serviceTier,
  usageMetering,
  abortSignal,
  timeoutMs,
}: ProposalRequestArgs) => {
  const caching = resolveCaching({
    promptCachingEnabled,
    role: ROLE,
    scopeKey: reviewDocumentsScopeKey(
      targetEntityVersionId,
      references.map((reference) => reference.entityVersionId),
    ),
  });
  const analytics = createTanStackAIAnalyticsCallbacks({
    feature: "document-review.positions",
    modelRole: ROLE,
    orgAIConfig,
    properties: {
      file_count: references.length + 1,
      organization_id: organizationId,
      workspace_id: workspaceId,
    },
    traceId: Bun.randomUUIDv7(),
    usageMetering,
  });
  const seeded = seededPositions
    .map((position) => `- ${position.issue}`)
    .join("\n");

  // Documents first (the shared, cached region), then everything that varies
  // per call. Annotated rather than inferred: this is the provider's message
  // contract, and a part shape that stops matching it must fail here and not
  // at the call site.
  const messages: ModelMessage[] = [
    {
      role: "user",
      content: [
        ...buildReviewDocumentParts({
          target,
          references: references.map((reference) => reference.file),
          caching,
        }),
        { type: "text", content: perspectiveLine(perspective) },
        {
          type: "text",
          content: `Positions the reviewer already has (do not repeat):\n${seeded || "(none)"}`,
        },
      ],
    },
  ];

  return {
    analytics,
    options: {
      role: ROLE,
      orgAIConfig,
      organizationId,
      analytics,
      caching,
      serviceTier,
      tenantWorkspaceIds: [workspaceId],
      system: SYSTEM_PROMPT,
      messages,
      abortSignal: AbortSignal.any([
        abortSignal,
        AbortSignal.timeout(timeoutMs),
      ]),
      outputSchema: proposedPositionsSchema,
    },
  };
};

export type ProposeReferencePositionsArgs = Omit<
  ProposalRequestArgs,
  "timeoutMs"
> & {
  positionsMax: number;
};

export const proposeReferencePositions = async ({
  positionsMax,
  ...request
}: ProposeReferencePositionsArgs): Promise<
  Result<ReviewPositionProposal, WorkflowIntegrationError>
> => {
  const { analytics, options } = buildProposalRequest({
    ...request,
    timeoutMs: TIMEOUT_MS,
  });

  return await Result.tryPromise({
    try: async () =>
      normalizeProposal({
        output: await generateTanStackObjectForRole(options),
        seededPositions: request.seededPositions,
        sources: request.references,
        positionsMax,
        newSourceId: Bun.randomUUIDv7,
      }),
    catch: (cause) => {
      analytics.captureError(cause);
      return new WorkflowIntegrationError({
        message: "Review position proposal failed",
        cause,
      });
    },
  });
};

// ── Streaming ─────────────────────────────────────────

/** The proposal as it arrives, plus the terminal count so a client knows the
 *  list is whole rather than truncated by a dropped connection. */
export type ReviewProposalStreamEvent =
  | ReviewProposalEvent
  | { type: "done"; positionCount: number; skippedCount: number };

export type StreamReferenceProposalArgs = ProposeReferencePositionsArgs;

/**
 * The same proposal, reported as the model writes it. Throws on a failed or
 * truncated stream, so the caller decides what the reviewer sees; every event
 * it did yield before that stays valid.
 *
 * @yields the target's sides, then each verified position and each skipped
 * term as the model closes it, then one `done` carrying the totals.
 */
export const streamReferenceProposal = async function* ({
  positionsMax,
  ...request
}: StreamReferenceProposalArgs): AsyncGenerator<ReviewProposalStreamEvent> {
  const { analytics, options } = buildProposalRequest({
    ...request,
    timeoutMs: STREAM_TIMEOUT_MS,
  });
  const normalizer = createProposalNormalizer({
    seededPositions: request.seededPositions,
    sources: request.references,
    positionsMax,
    newSourceId: Bun.randomUUIDv7,
  });
  const read = createPartialProposalReader(normalizer);
  const counts = { positions: 0, skipped: 0 };

  const count = (event: ReviewProposalEvent): void => {
    switch (event.type) {
      case "position":
        counts.positions += 1;
        break;
      case "skipped":
        counts.skipped += 1;
        break;
      case "parties":
        break;
      default:
        event satisfies never;
    }
  };

  try {
    for await (const chunk of streamTanStackObjectForRole(options)) {
      switch (chunk.type) {
        case "delta":
          break;
        case "partial":
          for (const event of read(chunk.partial, false)) {
            count(event);
            yield event;
          }
          break;
        case "complete":
          for (const event of read(chunk.object, true)) {
            count(event);
            yield event;
          }
          break;
        default:
          chunk satisfies never;
      }
    }
  } catch (error) {
    analytics.captureError(error);
    throw new WorkflowIntegrationError({
      message: "Review position proposal stream failed",
      cause: error,
    });
  }

  yield {
    type: "done",
    positionCount: counts.positions,
    skippedCount: counts.skipped,
  };
};
