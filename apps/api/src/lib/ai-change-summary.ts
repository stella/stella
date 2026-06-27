/**
 * AI summary of the changes between two document versions. Shared by
 * the template Studio history and the entity (.docx file) version
 * panel; both resolve version content server-side and pass only the
 * computed diff text here. Uses the same structured-output plumbing
 * as `suggest-template-fields` (generateTanStackObjectForRole).
 */

import * as v from "valibot";

import type { OrgAIConfig } from "@/api/lib/ai-config";
import { resolveCaching } from "@/api/lib/ai-config";
import type { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import type { SafeId } from "@/api/lib/branded-types";
import { generateTanStackObjectForRole } from "@/api/lib/tanstack-ai-generate";

const SUMMARY_TIMEOUT_MS = 30_000;

// strictObject (not object): OpenAI strict structured output rejects
// schema objects without `additionalProperties: false`.
const changeSummarySchema = v.strictObject({
  summary: v.string(),
});

const SYSTEM_PROMPT =
  "You summarize the difference between two versions of a legal document. " +
  "Write 1-3 short sentences describing what changed, in the document's own " +
  "language. Describe only what the diff shows; never invent details.";

type SummarizeVersionDiffOptions = {
  diffText: string;
  orgAIConfig: OrgAIConfig | null;
  organizationId: SafeId<"organization">;
  aiAnalytics: ReturnType<typeof createTanStackAIAnalyticsCallbacks>;
};

/** Throws on model failure; callers wrap with Result.tryPromise. */
export const summarizeVersionDiff = async ({
  diffText,
  orgAIConfig,
  organizationId,
  aiAnalytics,
}: SummarizeVersionDiffOptions): Promise<string> => {
  const { summary } = await generateTanStackObjectForRole({
    role: "fast",
    orgAIConfig,
    organizationId,
    analytics: aiAnalytics,
    caching: resolveCaching({
      promptCachingEnabled: false,
      role: "fast",
      scopeKey: organizationId,
    }),
    system: SYSTEM_PROMPT,
    prompt: `Diff between the previous and the new version ("+ " added, "- " removed, "@@" unchanged lines elided):\n\n${diffText}`,
    outputSchema: changeSummarySchema,
    serviceTier: "standard",
    abortSignal: AbortSignal.timeout(SUMMARY_TIMEOUT_MS),
  });

  return summary;
};
