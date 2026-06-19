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

/**
 * In-band marker separating the cacheable system prefix from the
 * dynamic, per-request system tail in the chat system prompt. The
 * caching middleware in `ai-models.ts` consumes it before the payload
 * reaches any provider: for Anthropic it splits the system into two
 * consecutive system blocks (the stable prefix carries the cache
 * breakpoint, the volatile tail — user name, current date, matter /
 * active-file context — stays unmarked); for every other provider and
 * whenever caching is off it is stripped, leaving a single system
 * string byte-identical to a plain concatenation.
 *
 * Uses a private-use codepoint plus a literal tag so it cannot collide
 * with real prompt text, and is visibly traceable if it ever leaks.
 */
export const SYSTEM_CACHE_BOUNDARY = "__stella_system_cache_boundary__";

type SystemCacheParts = {
  cacheablePrefix: string;
  dynamicTail: string;
};

/**
 * Join the cacheable system prefix and the dynamic system tail with
 * the cache boundary marker. An empty (or whitespace-only) tail yields
 * just the prefix with no marker, matching the previous
 * plain-concatenation behaviour.
 */
export const composeSystemWithCacheBoundary = ({
  cacheablePrefix,
  dynamicTail,
}: SystemCacheParts): string => {
  // Whitespace-only tails (e.g. a global chat with no user context or
  // installed skills) carry no content; treat them as empty so the
  // split never emits a blank second system block.
  if (dynamicTail.trim().length === 0) {
    return cacheablePrefix;
  }
  const separator = dynamicTail.startsWith("\n") ? "" : "\n\n";
  return `${cacheablePrefix}${SYSTEM_CACHE_BOUNDARY}${separator}${dynamicTail}`;
};

/**
 * Split a composed system string back into its prefix and tail. When
 * the marker is absent the whole string is the prefix and the tail is
 * empty.
 */
export const splitSystemCacheBoundary = (system: string): SystemCacheParts => {
  const index = system.indexOf(SYSTEM_CACHE_BOUNDARY);
  if (index === -1) {
    return { cacheablePrefix: system, dynamicTail: "" };
  }
  return {
    cacheablePrefix: system.slice(0, index),
    dynamicTail: system.slice(index + SYSTEM_CACHE_BOUNDARY.length),
  };
};

/**
 * Remove the boundary marker, yielding the plain concatenation
 * (`cacheablePrefix` + separator + `dynamicTail`).
 */
export const stripSystemCacheBoundary = (system: string): string =>
  system.includes(SYSTEM_CACHE_BOUNDARY)
    ? system.split(SYSTEM_CACHE_BOUNDARY).join("")
    : system;
