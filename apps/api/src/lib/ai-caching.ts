/**
 * Call-site helpers for prompt caching.
 *
 * The middleware in `ai-models.ts` enforces the org-wide policy at
 * the SDK boundary. This module gives call sites a typed way to
 * place explicit cache breakpoints on user-content parts (e.g. the
 * final document content before a per-batch question) without
 * writing provider-specific literals in handler code.
 *
 * The helper is provider-aware via the `CachingDecision`. When the
 * decision is `enabled: false`, the helper is a no-op — the
 * middleware also strips any leftover markers, so the wire payload
 * stays clean either way.
 */

import type { FilePart, TextPart } from "ai";

import type { CachingDecision } from "@/api/lib/ai-models";

type CacheablePart = FilePart | TextPart;

/**
 * Wrap a content part with provider-specific cache markers so the
 * material *up to and including this part* becomes the cache
 * breakpoint. Only meaningful for Anthropic today; the middleware
 * still strips on OFF for all providers, so the call site does not
 * need to branch.
 */
export const markCacheBreakpoint = <P extends CacheablePart>(
  part: P,
  { decision }: { decision: CachingDecision },
): P => {
  if (!decision.enabled) {
    return part;
  }
  const existing = part.providerOptions ?? {};
  const existingAnthropic = existing["anthropic"] ?? {};
  return {
    ...part,
    providerOptions: {
      ...existing,
      anthropic: {
        ...existingAnthropic,
        cacheControl: { type: "ephemeral" },
      },
    },
  };
};
