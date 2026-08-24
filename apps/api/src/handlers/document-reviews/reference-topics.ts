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
import type { ReviewPerspective } from "@/api/lib/document-review/contract";
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

const proposedTopicsSchema = v.strictObject({
  // Cardinality is normalized by mergeProposedReviewTopics. Providers do not
  // reliably honor JSON Schema array limits, so excess suggestions stay recoverable.
  topics: v.array(proposedTopicSchema),
});

const SYSTEM_PROMPT = `You help a lawyer define the issues for a structured comparison of one target legal document and one or more reference documents.

Propose a concise, non-overlapping list of material legal or commercial topics that the supplied documents make useful to compare. When the input names the side the lawyer acts for, favour the topics where that side's position differs between the documents. References are examples, not policy or proof of market practice. Do not make findings, score the target, or propose wording yet. Do not repeat any seeded topic. context is a short explanation of what the later comparison should examine.`;

const PERSPECTIVE_LINE = {
  buyer: "The lawyer acts for the buyer.",
  seller: "The lawyer acts for the seller.",
  neutral: "No side is named.",
} as const satisfies Record<ReviewPerspective, string>;

type ProposeReferenceTopicsArgs = {
  target: PreparedDocxFile;
  references: readonly PreparedDocxFile[];
  seededTopics: readonly DocumentReviewTopic[];
  perspective: ReviewPerspective;
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
  perspective,
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
  Result<DocumentReviewTopic[], WorkflowIntegrationError>
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
                content: `${PERSPECTIVE_LINE[perspective]}\n\nSeeded topics (do not repeat):\n${seeded || "(none)"}`,
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
      return mergeProposedReviewTopics(seededTopics, output.topics);
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
