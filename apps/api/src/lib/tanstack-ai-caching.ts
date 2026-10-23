import type { DocumentPart, TextPart } from "@tanstack/ai";
import type {
  AnthropicDocumentMetadata,
  AnthropicSystemPromptMetadata,
  AnthropicTextMetadata,
} from "@tanstack/ai-anthropic";
import { panic } from "better-result";

import type { TanStackAIProvider } from "@stll/ai-catalog";

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

/**
 * How each shipped adapter's provider caches a prompt, and what Stella sets for
 * it. A new adapter fails typecheck here until it states its mechanism, and a
 * provider with none carries the written reason (`waiver`).
 *
 * - `breakpoints`: the provider caches up to a `cache_control` marker. Stella
 *   marks the end of the system prompt's static and organization layers and
 *   sets the request-level marker, which lands on the last block of every
 *   request, so history and each tool-loop iteration read the request before
 *   them. Three of the four markers a request may carry.
 * - `breakpoints-for-models`: the same, for the models the prefixes name; the
 *   provider's other models cache as `otherwise` says.
 * - `implicit-prefix`: the provider caches the longest prefix recent requests
 *   shared, with no marker. Stella keeps the stable layers first and sends the
 *   prompt as one string, as before.
 * - `none`: nothing is sent.
 */
export type ProviderPromptCaching =
  | { mechanism: "breakpoints"; source: string }
  | {
      mechanism: "breakpoints-for-models";
      modelPrefixes: readonly string[];
      otherwise: "implicit-prefix";
      source: string;
    }
  | { mechanism: "implicit-prefix"; source: string }
  | { mechanism: "none"; waiver: string };

export const PROVIDER_PROMPT_CACHING = {
  anthropic: {
    mechanism: "breakpoints",
    source:
      "Messages API prompt caching: block `cache_control` markers and the request-level marker.",
  },
  openrouter: {
    mechanism: "breakpoints-for-models",
    modelPrefixes: ["anthropic/"],
    otherwise: "implicit-prefix",
    source:
      "OpenRouter prompt caching: Anthropic models take `cache_control` on content blocks and at the request level; other providers cache implicitly.",
  },
  openai: {
    mechanism: "implicit-prefix",
    source:
      "Responses API prompt caching: automatic over the shared prefix, routed by `prompt_cache_key`.",
  },
  google: {
    mechanism: "implicit-prefix",
    source:
      "Gemini implicit caching: automatic over the shared prefix; explicit cached contents are a separate resource stella does not create.",
  },
  bedrock: {
    mechanism: "none",
    waiver:
      "Bedrock Converse caches only at `cachePoint` blocks, and the Bedrock adapter has no option that sends one. Supporting it is an upstream adapter change, not something stella can set at its boundary.",
  },
  mistral: {
    mechanism: "none",
    waiver:
      "The Mistral adapter exposes no prompt-cache setting, so there is nothing stella can set at its boundary.",
  },
} as const satisfies Record<TanStackAIProvider, ProviderPromptCaching>;

/** Whether requests to `modelId` on `provider` carry cache markers. */
export const promptCachingUsesBreakpoints = ({
  modelId,
  provider,
}: {
  modelId: string;
  provider: TanStackAIProvider;
}): boolean => {
  const caching: ProviderPromptCaching = PROVIDER_PROMPT_CACHING[provider];
  switch (caching.mechanism) {
    case "breakpoints":
      return true;
    case "breakpoints-for-models":
      return caching.modelPrefixes.some((prefix) => modelId.startsWith(prefix));
    case "implicit-prefix":
    case "none":
      return false;
    default: {
      caching satisfies never;
      return panic(`Unhandled caching mechanism: ${String(caching)}`);
    }
  }
};

/**
 * A system prompt as three consecutive slices whose concatenation is the whole
 * prompt: what every organization shares, what one organization's users share,
 * and what is per user or per turn. A provider that caches at markers gets one
 * after each of the first two; every other provider gets the concatenation, the
 * same string as an unlayered prompt.
 */
export type LayeredSystemPrompt = {
  readonly organization: string;
  readonly static: string;
  readonly turn: string;
};

export const joinLayeredSystemPrompt = (prompt: LayeredSystemPrompt): string =>
  `${prompt.static}${prompt.organization}${prompt.turn}`;

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

  if (part.type === "text") {
    return {
      ...part,
      metadata: {
        ...part.metadata,
        cache_control: cacheControl,
      },
    };
  }

  return {
    ...part,
    metadata: {
      ...part.metadata,
      cache_control: cacheControl,
    },
  };
}
