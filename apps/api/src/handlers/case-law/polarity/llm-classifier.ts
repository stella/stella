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

/**
 * What each polarity means, one entry per value the classifier may return.
 *
 * Total over `ClassifiablePolarity` by construction, so a new polarity cannot
 * be added to the canonical list without the model being told what it means.
 * The examples are drawn from the same phrases the seed rules key on, because
 * the two tiers label the same corpus and used to disagree: the regex tier has
 * always called "srov." supportive, while this prompt called it neutral.
 */
const POLARITY_GUIDANCE = {
  positive: `The court follows, agrees with, applies, or builds on the
  cited decision, and says so. Phrases like "v souladu s", "odkazuje na",
  "jak konstatoval", "following", "in line with", "as held in".`,
  supportive: `The court relies on the cited decision without stating
  agreement outright: a comparison or see-also pointer offered in support
  of what it is saying. Phrases like "srov.", "viz", "obdobně",
  "přiměřeně", "porov.", "pozri", "cf.", "see also".`,
  neutral: `The court names the cited decision without endorsing or
  rejecting it, most often as part of the procedural record. Phrases like
  "proti rozsudku", "vedené u", "veden pod". This is also the answer when
  the excerpt does not settle the question.`,
  negative: `The court distinguishes, overrules, departs from, or
  criticizes the cited decision. Phrases like "na rozdíl od",
  "překonán", "zrušen", "odlišuje se", "overruled", "distinguished".`,
} as const satisfies Record<ClassifiablePolarity, string>;

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
