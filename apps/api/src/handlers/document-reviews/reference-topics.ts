import { Result } from "better-result";
import * as v from "valibot";

import { mergeProposedReviewTopics } from "@/api/handlers/document-reviews/review-topics";
import type { DocumentReviewTopic } from "@/api/handlers/document-reviews/schemas";
import type { AIRequestServiceTier, OrgAIConfig } from "@/api/lib/ai-config";
import { resolveCaching } from "@/api/lib/ai-config";
import {
  createTanStackAIAnalyticsCallbacks,
  type AIUsageMetering,
} from "@/api/lib/analytics/tanstack-ai";
import type { SafeId } from "@/api/lib/branded-types";
import {
  REVIEW_PARTIES_MAX,
  REVIEW_PARTY_NAME_MAX_LENGTH,
  REVIEW_PARTY_ROLE_MAX_LENGTH,
} from "@/api/lib/document-review/contract";
import type { ReviewParty } from "@/api/lib/document-review/contract";
import {
  buildReviewDocumentParts,
  reviewDocumentsScopeKey,
} from "@/api/lib/document-review/review-document-messages";
import { WorkflowIntegrationError } from "@/api/lib/errors/tagged-errors";
import { generateTanStackObjectForRole } from "@/api/lib/tanstack-ai-generate";
import type { PreparedDocxFile } from "@/api/lib/workflow/generate-batch";

const ROLE = "pdf" as const;
const TIMEOUT_MS = 120_000;

const proposedTopicSchema = v.strictObject({
  title: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
  context: v.pipe(v.string(), v.maxLength(2000)),
});

const proposedPartySchema = v.strictObject({
  role: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1),
    v.maxLength(REVIEW_PARTY_ROLE_MAX_LENGTH),
  ),
  name: v.nullable(
    v.pipe(v.string(), v.trim(), v.maxLength(REVIEW_PARTY_NAME_MAX_LENGTH)),
  ),
});

const proposedTopicsSchema = v.strictObject({
  // Cardinality is normalized by mergeProposedReviewTopics. Providers do not
  // reliably honor JSON Schema array limits, so excess suggestions stay recoverable.
  topics: v.array(proposedTopicSchema),
  // The target's parties, so the lawyer can say which one they act for.
  parties: v.array(proposedPartySchema),
});

const SYSTEM_PROMPT = `You help a lawyer define the issues for a structured comparison of one target legal document (F0) and one or more reference documents.

Propose a concise, non-overlapping list of material legal or commercial topics that the supplied documents make useful to compare. References are examples, not policy or proof of market practice. Do not make findings, score the target, or propose wording yet. Do not repeat any seeded topic. context is a short explanation of what the later comparison should examine.

Also list the parties to the target document only: role is the defined term the target uses for that side (for example Purchaser, Seller, Landlord, Licensee, Borrower), name is the party's legal name when the target states it, otherwise null. One entry per side; omit guarantors, agents and notaries unless they are principal parties.`;

/** What the proposal pass hands back: the plan to confirm and the sides the
 *  lawyer can act for. */
export type ReviewTopicProposal = {
  topics: DocumentReviewTopic[];
  parties: ReviewParty[];
};

type ProposeReferenceTopicsArgs = {
  target: PreparedDocxFile;
  references: readonly PreparedDocxFile[];
  seededTopics: readonly DocumentReviewTopic[];
  targetEntityVersionId: SafeId<"entityVersion">;
  referenceEntityVersionIds: readonly SafeId<"entityVersion">[];
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  orgAIConfig: OrgAIConfig | null;
  promptCachingEnabled: boolean;
  serviceTier: AIRequestServiceTier;
  usageMetering: AIUsageMetering;
  abortSignal: AbortSignal;
};

export const proposeReferenceTopics = async ({
  target,
  references,
  seededTopics,
  targetEntityVersionId,
  referenceEntityVersionIds,
  organizationId,
  workspaceId,
  orgAIConfig,
  promptCachingEnabled,
  serviceTier,
  usageMetering,
  abortSignal,
}: ProposeReferenceTopicsArgs): Promise<
  Result<ReviewTopicProposal, WorkflowIntegrationError>
> => {
  const caching = resolveCaching({
    promptCachingEnabled,
    role: ROLE,
    scopeKey: reviewDocumentsScopeKey(
      targetEntityVersionId,
      referenceEntityVersionIds,
    ),
  });
  const aiAnalytics = createTanStackAIAnalyticsCallbacks({
    feature: "document-review.topics",
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
  const seeded = seededTopics
    .map(
      (topic) => `- ${topic.title}: ${topic.context || "(no extra context)"}`,
    )
    .join("\n");

  return await Result.tryPromise({
    try: async () => {
      const output = await generateTanStackObjectForRole({
        role: ROLE,
        orgAIConfig,
        organizationId,
        analytics: aiAnalytics,
        caching,
        serviceTier,
        tenantWorkspaceIds: [workspaceId],
        system: SYSTEM_PROMPT,
        // Documents first (the shared, cached region), the seeded topics last.
        messages: [
          {
            role: "user",
            content: [
              ...buildReviewDocumentParts({ target, references, caching }),
              {
                type: "text",
                content: `Seeded topics (do not repeat):\n${seeded || "(none)"}`,
              },
            ],
          },
        ],
        abortSignal: AbortSignal.any([
          abortSignal,
          AbortSignal.timeout(TIMEOUT_MS),
        ]),
        outputSchema: proposedTopicsSchema,
      });
      return {
        topics: mergeProposedReviewTopics(seededTopics, output.topics),
        parties: output.parties.slice(0, REVIEW_PARTIES_MAX),
      };
    },
    catch: (cause) => {
      aiAnalytics.captureError(cause);
      return new WorkflowIntegrationError({
        message: "Review topic proposal failed",
        cause,
      });
    },
  });
};
