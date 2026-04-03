/**
 * LLM-based citation polarity classifier.
 *
 * Used as a fallback when no regex rule matches. Classifies
 * the polarity of a citation based on the surrounding text
 * context. Extracts the key phrase that determined polarity
 * for potential rule generation.
 */

import type { GoogleGenerativeAIProviderOptions } from "@ai-sdk/google";
import { valibotSchema } from "@ai-sdk/valibot";
import { generateText, Output } from "ai";
import { Result } from "better-result";
import * as v from "valibot";

import { getModelForRole } from "@/api/lib/ai-models";
import { WorkflowIntegrationError } from "@/api/lib/errors/tagged-errors";

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

/**
 * Classify a citation's polarity using an LLM.
 *
 * @param context - Text surrounding the citation (2-3 sentences)
 * @param citationText - The citation reference itself
 * @param language - ISO language code (e.g. "cs", "sk", "de")
 */
export const classifyWithLLM = async (
  context: string,
  citationText: string,
  language: string,
  abortSignal?: AbortSignal,
): Promise<Result<ClassificationResult, WorkflowIntegrationError>> =>
  await Result.tryPromise({
    try: async () => {
      const result = await generateText({
        model: getModelForRole("fast"),
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
        output: Output.object({
          schema: valibotSchema(classificationSchema),
        }),
        providerOptions: {
          google: {
            thinkingConfig: {
              thinkingLevel: "minimal",
              includeThoughts: false,
            },
          } satisfies GoogleGenerativeAIProviderOptions,
        },
        abortSignal: abortSignal
          ? AbortSignal.any([abortSignal, AbortSignal.timeout(15_000)])
          : AbortSignal.timeout(15_000),
      });

      return {
        // SAFETY: Valibot picklist at line 45 restricts to
        // valid Polarity subset ("positive" | "neutral" | "negative").
        // The picklist subset is assignable to Polarity without cast
        polarity: result.output.polarity,
        keyPhrase: result.output.keyPhrase,
        confidence: result.output.confidence,
      };
    },
    catch: (error) =>
      new WorkflowIntegrationError({
        message: "Citation polarity LLM classification failed",
        cause: error,
      }),
  });
