/**
 * LLM-based citation polarity classifier.
 *
 * Used as a fallback when no regex rule matches. Classifies
 * the polarity of a citation based on the surrounding text
 * context. Extracts the key phrase that determined polarity
 * for potential rule generation.
 */

import { resolveCaching } from "@/api/lib/ai-config";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import { NO_ORGANIZATION_MODEL_DISPATCH } from "@/api/lib/rate-limit/model-dispatch-admission";
import type { DecisionGenerationOptions } from "@/api/lib/workflow/decisions/decide";

import { CLASSIFIABLE_POLARITIES } from "./consts";
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

/** Normal corpus generation context consumed by the typed decision owner. */
export const polarityGeneration = ({
  context,
  citationText,
  language,
  abortSignal,
}: {
  context: string;
  citationText: string;
  language: string;
  abortSignal?: AbortSignal | undefined;
}) =>
  ({
    dataClass: "public_corpus",
    task: "classify",
    userId: null,
    serviceTier: "flex",
    orgAIConfig: null,
    organizationId: null,
    admission: NO_ORGANIZATION_MODEL_DISPATCH,
    tenantWorkspaceIds: [],
    analytics: createTanStackAIAnalyticsCallbacks({
      dataClass: "public_corpus",
      feature: "case-law.polarity",
      modelTask: "classify",
      modelTier: NO_ORGANIZATION_MODEL_DISPATCH.modelTier,
      properties: { language },
      traceId: Bun.randomUUIDv7(),
    }),
    caching: resolveCaching({
      promptCachingEnabled: true,
      task: "classify",
      scopeKey: `polarity:${language}`,
    }),
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Language: ${language}\nCitation reference: ${citationText}\nSurrounding text:\n${context}`,
      },
    ],
    evidenceInstruction:
      "Extract the specific phrase (2-5 words, at most 100 characters) from the excerpt that most strongly indicates polarity; use null when no phrase supports it.",
    abortSignal,
    deadlineMs: 15_000,
  }) satisfies Extract<
    DecisionGenerationOptions,
    { dataClass: "public_corpus" }
  >;
