/**
 * Detecting a target document's parties on their own, ahead of any position
 * proposal. The review launcher shows "We act for" on its first screen, before
 * a reviewer has picked references or run a proposal pass, so this reads only
 * the target document and answers with nothing else.
 *
 * `normalizeParties` here is a standalone copy of the reference proposal
 * pass's normalizer (`handlers/document-reviews/reference-positions.ts`),
 * kept in this shared module so both call sites can converge on it later
 * without either editing the other while both are in flight.
 */

import { Result } from "better-result";
import * as v from "valibot";

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
const TIMEOUT_MS = 60_000;

// Bumped whenever `SYSTEM_PROMPT` or `proposedPartySchema` changes shape, so
// a row cached under an earlier prompt is recomputed instead of read as
// today's answer. Stored alongside the cached row
// (see `handlers/document-reviews/parties.ts`).
export const REVIEW_PARTIES_PROMPT_VERSION = 1;

// No transforms here: the schema is handed to the provider as JSON Schema,
// which cannot express them. Whitespace is normalized in `normalizeParties`.
const proposedPartySchema = v.strictObject({
  role: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(REVIEW_PARTY_ROLE_MAX_LENGTH),
  ),
  name: v.nullable(
    v.pipe(v.string(), v.maxLength(REVIEW_PARTY_NAME_MAX_LENGTH)),
  ),
});

type ProposedParty = v.InferOutput<typeof proposedPartySchema>;

/** Trims the model's text and drops entries left without a role. */
export const normalizeParties = (
  parties: readonly ProposedParty[],
): ReviewParty[] => {
  const normalized: ReviewParty[] = [];
  for (const party of parties.slice(0, REVIEW_PARTIES_MAX)) {
    const role = party.role.trim();
    if (role.length === 0) {
      continue;
    }
    const name = party.name?.trim() ?? "";
    normalized.push({ role, name: name.length === 0 ? null : name });
  }
  return normalized;
};

const proposedPartiesSchema = v.strictObject({
  parties: v.array(proposedPartySchema),
});

const SYSTEM_PROMPT = `You read one legal document and list its parties, as the document itself names them. Do not judge, summarize, or compare the document.

parties lists the document's sides only: role is the defined term the document uses (Purchaser, Seller, Landlord, Licensee), name is the legal name when the document states it, otherwise null. Omit guarantors, agents and notaries unless they are principal parties.`;

export type DetectReviewPartiesArgs = {
  target: PreparedDocxFile;
  targetEntityVersionId: SafeId<"entityVersion">;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  orgAIConfig: OrgAIConfig | null;
  promptCachingEnabled: boolean;
  serviceTier: AIRequestServiceTier;
  usageMetering: AIUsageMetering;
  abortSignal: AbortSignal;
};

/** Reads one document and answers with its parties. No references, no
 *  comparison, no positions: this is the launcher's first-screen call. */
export const detectReviewParties = async ({
  target,
  targetEntityVersionId,
  organizationId,
  workspaceId,
  orgAIConfig,
  promptCachingEnabled,
  serviceTier,
  usageMetering,
  abortSignal,
}: DetectReviewPartiesArgs): Promise<
  Result<ReviewParty[], WorkflowIntegrationError>
> => {
  const caching = resolveCaching({
    promptCachingEnabled,
    role: ROLE,
    scopeKey: reviewDocumentsScopeKey(targetEntityVersionId, []),
  });
  const aiAnalytics = createTanStackAIAnalyticsCallbacks({
    feature: "document-review.parties",
    modelRole: ROLE,
    orgAIConfig,
    properties: {
      file_count: 1,
      organization_id: organizationId,
      workspace_id: workspaceId,
    },
    traceId: Bun.randomUUIDv7(),
    usageMetering,
  });

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
        messages: [
          {
            role: "user",
            content: buildReviewDocumentParts({
              target,
              references: [],
              caching,
            }),
          },
        ],
        abortSignal: AbortSignal.any([
          abortSignal,
          AbortSignal.timeout(TIMEOUT_MS),
        ]),
        outputSchema: proposedPartiesSchema,
      });
      return normalizeParties(output.parties);
    },
    catch: (cause) => {
      aiAnalytics.captureError(cause);
      return new WorkflowIntegrationError({
        message: "Review party detection failed",
        cause,
      });
    },
  });
};
