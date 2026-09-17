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

import { CLASSIFIABLE_POLARITIES } from "./consts";
import type { ClassifiablePolarity } from "./consts";
import { POLARITY_GUIDANCE } from "./guidance";

const SYSTEM_PROMPT = `You are a legal citation polarity classifier.

Given a text excerpt from a court decision that contains a citation
reference, classify the relationship between the citing decision and
the cited decision.

Classifications:
${CLASSIFIABLE_POLARITIES.map(
  (polarity) => `- "${polarity}": ${POLARITY_GUIDANCE[polarity]}`,
).join("\n")}

Extract the specific phrase (2-5 words) from the text that most
strongly indicates the polarity. This phrase will be used to generate
regex rules for future classification.

Report confidence honestly. A high-confidence answer can be promoted into
a regex rule that labels later citations without you, so an uncertain one
must say so rather than round itself up.`;

const classificationSchema = v.strictObject({
  polarity: v.picklist(CLASSIFIABLE_POLARITIES),
  keyPhrase: v.pipe(v.string(), v.minLength(2), v.maxLength(100)),
  confidence: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
});

type ClassificationResult = {
  polarity: ClassifiablePolarity;
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
        serviceTier: "flex",
        orgAIConfig: null,
        organizationId: null,
        // Public case-law corpus: no tenant workspace scope to guard against.
        tenantWorkspaceIds: [],
        analytics: aiAnalytics,
        caching: resolveCaching({
          promptCachingEnabled: true,
          role: "fast",
          scopeKey: `polarity:${language}`,
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
