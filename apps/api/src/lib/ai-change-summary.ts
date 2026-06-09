/**
 * AI summary of the changes between two document versions. Shared by
 * the template Studio history and the entity (.docx file) version
 * panel; both resolve version content server-side and pass only the
 * computed diff text here. Uses the same structured-output plumbing
 * as `suggest-template-fields` (streamText + Output.object).
 */

import { Output, streamText } from "ai";
import * as v from "valibot";

import { getModelForRole } from "@/api/lib/ai-models";
import type { OrgAIConfig } from "@/api/lib/ai-models";
import { strictOutputSchema } from "@/api/lib/ai-output-schema";
import type { SafeId } from "@/api/lib/branded-types";

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
};

/** Throws on model failure; callers wrap with Result.tryPromise. */
export const summarizeVersionDiff = async ({
  diffText,
  orgAIConfig,
  organizationId,
}: SummarizeVersionDiffOptions): Promise<string> => {
  const result = streamText({
    abortSignal: AbortSignal.timeout(SUMMARY_TIMEOUT_MS),
    messages: [
      {
        role: "user",
        content: `Diff between the previous and the new version ("+ " added, "- " removed, "@@" unchanged lines elided):\n\n${diffText}`,
      },
    ],
    model: getModelForRole("fast", orgAIConfig, {
      promptCachingEnabled: false,
      scopeKey: organizationId,
      organizationId,
      serviceTier: "standard",
    }),
    output: Output.object({
      schema: strictOutputSchema(changeSummarySchema),
    }),
    system: SYSTEM_PROMPT,
  });

  const { summary } = await result.output;
  return summary;
};
