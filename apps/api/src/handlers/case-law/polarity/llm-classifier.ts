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

import { MODEL_READING_GUIDANCE } from "./model-readings";

const SYSTEM_PROMPT = `You are a legal citation polarity classifier.

Given a text excerpt from a court decision that contains a citation
reference, choose one reading of the citing court's use of the cited decision.
A form reading describes citation typography or a reference marker rather
than the court's treatment, and has neutral polarity.

Classifications:
${Object.entries(MODEL_READING_GUIDANCE)
  .map(([reading, guidance]) => `- "${reading}": ${guidance}`)
  .join("\n")}

Extract the specific phrase or marker (at most 100 characters) that most
strongly supports the chosen reading. For form, extract the form marker,
not a treatment cue. This phrase will be used to generate regex rules
for future classification.

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
    role: "fast",
    serviceTier: "flex",
    orgAIConfig: null,
    organizationId: null,
    admission: NO_ORGANIZATION_MODEL_DISPATCH,
    tenantWorkspaceIds: [],
    analytics: createTanStackAIAnalyticsCallbacks({
      dataClass: "public_corpus",
      feature: "case-law.polarity",
      modelRole: "fast",
      modelTier: NO_ORGANIZATION_MODEL_DISPATCH.modelTier,
      properties: { language },
      traceId: Bun.randomUUIDv7(),
    }),
    caching: resolveCaching({
      promptCachingEnabled: true,
      role: "fast",
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
      "Extract the specific phrase (at most 100 characters) from the excerpt supporting the chosen reading: a treatment cue for stance, or a citation form marker for form. Use null when no phrase supports it.",
    abortSignal,
    deadlineMs: 15_000,
  }) satisfies Extract<
    DecisionGenerationOptions,
    { dataClass: "public_corpus" }
  >;
