import * as v from "valibot";

import { resolveCaching } from "@/api/lib/ai-config";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import type { BilingualAIContext } from "@/api/lib/bilingual/ai";
import { generateTanStackObjectForRole } from "@/api/lib/tanstack-ai-generate";

const TRANSLATION_ROLE = "chat" as const;
const SERVICE_TIER = "standard" as const;
const CALL_TIMEOUT_MS = 90_000;

const translationSchema = v.object({
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
  sourceLang: string;
  targetLang: string;
  context: BilingualAIContext;
};

/** Translate text while treating run markers as an immutable formatting API. */
export const translateTaggedSegments = async ({
  segments,
  preceding,
  sourceLang,
  targetLang,
  context,
}: TranslateTaggedSegmentsOptions): Promise<Map<string, string>> => {
  const analytics = createTanStackAIAnalyticsCallbacks({
    feature: "document_translation.translate",
    modelRole: TRANSLATION_ROLE,
    orgAIConfig: context.orgAIConfig,
    properties: {
      organization_id: context.organizationId,
      workspace_id: context.workspaceId,
    },
    traceId: Bun.randomUUIDv7(),
    usageMetering: context.usageMetering,
  });
  const output = await generateTanStackObjectForRole({
    role: TRANSLATION_ROLE,
    orgAIConfig: context.orgAIConfig,
    organizationId: context.organizationId,
    analytics,
    caching: resolveCaching({
      promptCachingEnabled: context.promptCachingEnabled,
      role: TRANSLATION_ROLE,
      scopeKey: context.scopeKey,
    }),
    serviceTier: SERVICE_TIER,
    tenantWorkspaceIds: [context.workspaceId],
    system: TRANSLATION_SYSTEM,
    systemPromptOrigin: "embeds-untrusted",
    prompt: `Source language: ${sourceLang}. Target language: ${targetLang}.

Preceding segments (context only, do not return):
${preceding.map((segment) => `${segment.id}: ${segment.taggedText}`).join("\n") || "(start of document)"}

Segments to translate:
${segments.map((segment) => `${segment.id}: ${segment.taggedText}`).join("\n")}`,
    abortSignal: AbortSignal.any([
      context.abortSignal,
      AbortSignal.timeout(CALL_TIMEOUT_MS),
    ]),
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
