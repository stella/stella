/**
 * LLM-based citation polarity classifier.
 *
 * Used as a fallback when no regex rule matches. Classifies
 * the polarity of a citation based on the surrounding text
 * context. Extracts the key phrase that determined polarity
 * for potential rule generation.
 */

import { Result } from "better-result";
import * as v from "valibot";

import { resolveCaching } from "@/api/lib/ai-config";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import { WorkflowIntegrationError } from "@/api/lib/errors/tagged-errors";
import { generateTanStackObjectForRole } from "@/api/lib/tanstack-ai-generate";

import type { Polarity } from "./consts";

const SYSTEM_PROMPT = `You are a legal citation polarity classifier.

Given a text excerpt from a court decision that contains a citation
reference, classify the relationship between the citing decision and
the cited decision.

Classifications:
- "positive": The court follows, agrees with, applies, or builds on
  the cited decision. Phrases like "v souladu s", "odkazuje na",
  "jak konstatoval", "following", "in line with", "as held in".
- "neutral": The court merely references or mentions the cited
  decision without endorsing or rejecting it. Phrases like "srov.",
  "viz", "cf.", "see", "compare".
- "negative": The court distinguishes, overrules, departs from, or
  criticizes the cited decision. Phrases like "na rozdíl od",
  "překonán", "zrušen", "odlišuje se", "overruled", "distinguished".

Extract the specific phrase (2-5 words) from the text that most
strongly indicates the polarity. This phrase will be used to generate
regex rules for future classification.

If the context is ambiguous, classify as "neutral".`;

const classificationSchema = v.strictObject({
  polarity: v.picklist(["positive", "neutral", "negative"]),
  keyPhrase: v.pipe(v.string(), v.minLength(2), v.maxLength(100)),
  confidence: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
});

type ClassificationResult = {
  polarity: Polarity;
  keyPhrase: string;
  confidence: number;
};

type ClassifyWithLLMOptions = {
  /** Text surrounding the citation (2-3 sentences). */
  context: string;
  /** The citation reference itself. */
  citationText: string;
  /** ISO language code (e.g. "cs", "sk", "de"). */
  language: string;
  abortSignal?: AbortSignal | undefined;
};

/** Classify a citation's polarity using an LLM. */
export const classifyWithLLM = async ({
  context,
  citationText,
  language,
  abortSignal,
}: ClassifyWithLLMOptions): Promise<
  Result<ClassificationResult, WorkflowIntegrationError>
> => {
  const aiAnalytics = createTanStackAIAnalyticsCallbacks({
    feature: "case-law.polarity",
    modelRole: "fast",
    properties: {
      language,
    },
    traceId: Bun.randomUUIDv7(),
  });

  return await Result.tryPromise({
    try: async () => {
      const output = await generateTanStackObjectForRole({
        role: "fast",
        orgAIConfig: null,
        organizationId: null,
        analytics: aiAnalytics,
        caching: resolveCaching({
          promptCachingEnabled: false,
          role: "fast",
          scopeKey: null,
        }),
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: `Language: ${language}
Citation reference: ${citationText}
Surrounding text:
${context}`,
          },
        ],
        outputSchema: classificationSchema,
        abortSignal: abortSignal
          ? AbortSignal.any([abortSignal, AbortSignal.timeout(15_000)])
          : AbortSignal.timeout(15_000),
      });

      return {
        // SAFETY: Valibot picklist at line 45 restricts to
        // valid Polarity subset ("positive" | "neutral" | "negative").
        // The picklist subset is assignable to Polarity without cast
        polarity: output.polarity,
        keyPhrase: output.keyPhrase,
        confidence: output.confidence,
      };
    },
    catch: (error) => {
      aiAnalytics.captureError(error);

      return new WorkflowIntegrationError({
        message: "Citation polarity LLM classification failed",
        cause: error,
      });
    },
  });
};
