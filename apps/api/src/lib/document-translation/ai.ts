import * as v from "valibot";

import { resolveCaching } from "@/api/lib/ai-config";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import {
  type BilingualAIContext,
  translationLanguageInstruction,
  type TranslationLanguages,
} from "@/api/lib/bilingual/ai";
import { generateTanStackObjectForTask } from "@/api/lib/tanstack-ai-generate";

const TRANSLATION_TASK = "chat";
const SERVICE_TIER = "standard" as const;
const CALL_TIMEOUT_MS = 90_000;

/** Read by the structured-output role contract test. @public */
export const translationSchema = v.object({
  items: v.array(
    v.object({
      id: v.string(),
      text: v.string(),
    }),
  ),
});

const TRANSLATION_SYSTEM = `Translate legal-document segments faithfully and completely into the requested target language. Preserve formal legal register, defined-term capitalisation, numbers, dates, amounts, currencies, article references, and party names.

Each segment contains formatting boundary markers such as [[stella-translation:...]] and [[/stella-translation:...]]. These are immutable control data:
- reproduce every marker exactly once, byte for byte, in the same order;
- translate only the text enclosed by each marker pair;
- do not add text outside markers;
- do not move words between marker pairs, even when that is stylistically preferable.

Return exactly one item for every supplied segment id. Do not add explanations.`;

export type TaggedTranslationSegment = {
  id: string;
  taggedText: string;
};

type TranslateTaggedSegmentsOptions = {
  segments: readonly TaggedTranslationSegment[];
  preceding: readonly TaggedTranslationSegment[];
  languages: TranslationLanguages;
  context: BilingualAIContext;
};

/** Translate text while treating run markers as an immutable formatting API. */
export const translateTaggedSegments = async ({
  segments,
  preceding,
  languages,
  context,
}: TranslateTaggedSegmentsOptions): Promise<Map<string, string>> => {
  const analytics = createTanStackAIAnalyticsCallbacks({
    dataClass: "customer",
    feature: "document_translation.translate",
    modelTask: TRANSLATION_TASK,
    orgAIConfig: context.orgAIConfig,
    modelTier: context.admission.modelTier,
    properties: {
      organization_id: context.organizationId,
      workspace_id: context.workspaceId,
    },
    traceId: Bun.randomUUIDv7(),
    usageMetering: context.usageMetering,
  });
  const output = await generateTanStackObjectForTask({
    dataClass: "customer",
    task: TRANSLATION_TASK,
    orgAIConfig: context.orgAIConfig,
    managedAIResidency: context.managedAIResidency,
    organizationId: context.organizationId,
    admission: context.admission,
    userId: context.admission.userId,
    analytics,
    caching: resolveCaching({
      promptCachingEnabled: context.promptCachingEnabled,
      task: TRANSLATION_TASK,
      scopeKey: context.scopeKey,
    }),
    serviceTier: SERVICE_TIER,
    tenantWorkspaceIds: [context.workspaceId],
    system: TRANSLATION_SYSTEM,
    systemPromptOrigin: "embeds-untrusted",
    prompt: `${translationLanguageInstruction(languages)}

Preceding segments (context only, do not return):
${preceding.map((segment) => `${segment.id}: ${segment.taggedText}`).join("\n") || "(start of document)"}

Segments to translate:
${segments.map((segment) => `${segment.id}: ${segment.taggedText}`).join("\n")}`,
    abortSignal: context.abortSignal,
    deadlineMs: CALL_TIMEOUT_MS,
    outputSchema: translationSchema,
  });

  const known = new Set(segments.map((segment) => segment.id));
  const translated = new Map<string, string>();
  for (const item of output.items) {
    if (known.has(item.id) && item.text !== "" && !translated.has(item.id)) {
      translated.set(item.id, item.text);
    }
  }
  return translated;
};
