import type { DocumentPart, TextPart } from "@tanstack/ai";
import type {
  AnthropicDocumentMetadata,
  AnthropicSystemPromptMetadata,
  AnthropicTextMetadata,
} from "@tanstack/ai-anthropic";

import type { CachingDecision } from "@/api/lib/ai-config";

type TanStackCacheControl = NonNullable<
  AnthropicSystemPromptMetadata["cache_control"]
>;

export const tanStackCacheControl = (
  decision: CachingDecision,
): TanStackCacheControl | undefined => {
  if (!decision.enabled) {
    return undefined;
  }
  return { type: "ephemeral", ttl: decision.ttl };
};

export function markTanStackCacheBreakpoint(
  part: TextPart<AnthropicTextMetadata>,
  options: { decision: CachingDecision },
): TextPart<AnthropicTextMetadata>;
export function markTanStackCacheBreakpoint(
  part: DocumentPart<AnthropicDocumentMetadata>,
  options: { decision: CachingDecision },
): DocumentPart<AnthropicDocumentMetadata>;
export function markTanStackCacheBreakpoint(
  part:
    | TextPart<AnthropicTextMetadata>
    | DocumentPart<AnthropicDocumentMetadata>,
  options: { decision: CachingDecision },
): TextPart<AnthropicTextMetadata> | DocumentPart<AnthropicDocumentMetadata>;
export function markTanStackCacheBreakpoint(
  part:
    | TextPart<AnthropicTextMetadata>
    | DocumentPart<AnthropicDocumentMetadata>,
  { decision }: { decision: CachingDecision },
): TextPart<AnthropicTextMetadata> | DocumentPart<AnthropicDocumentMetadata> {
  const cacheControl = tanStackCacheControl(decision);
  if (!cacheControl) {
    return part;
  }
  return {
    ...part,
    metadata: {
      ...part.metadata,
      cache_control: cacheControl,
    },
  };
}
