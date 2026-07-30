/**
 * Gateway-side rate limit for `invoke_capability`. Most capabilities are keyed
 * per (organization, capability id); outbound skill-source capabilities consume
 * the REST routes' shared client-IP budget instead.
 *
 * The generic invoke path bypasses the per-route rate-limit middleware some REST
 * routes install (e.g. `entities.translate`, `entities.upload`), so it needs its
 * own budget or an agent could drive backend cost through the long tail. It
 * reuses the same fixed-window counter the public feedback intake and the MCP
 * `send_feedback` tool ride on (`FeedbackIntakeGuards.consumeCounter`,
 * Redis-backed with an in-memory fallback), under a distinct bucket, rather than
 * hand-rolling a limiter.
 *
 * A generous default applies to every capability; a small override table mirrors
 * the explicit limits capability endpoints carry on their REST routes so the
 * generic path is never looser than the route it stands in for.
 */

import {
  createFeedbackIntakeGuards,
  type FeedbackIntakeGuards,
} from "@/api/handlers/feedback/intake-guards";
import {
  consumeSkillSourceRateLimit,
  type SkillSourceRateLimitResult,
} from "@/api/handlers/skills/source-rate-limit";
import type { SafeId } from "@/api/lib/branded-types";
import { API_RATE_LIMITS } from "@/api/lib/limits";

/** Counter bucket, distinct from the feedback intake's per-IP/per-org buckets. */
const INVOKE_CAPABILITY_BUCKET = "mcp:invoke_capability";

export type InvokeRateLimit = { windowMs: number; max: number };

/**
 * Default per-(organization, capability) invoke budget: 60 invocations per
 * minute. Generous enough for legitimate batch automation over a single
 * capability while still bounding a runaway loop; a capability whose REST route
 * carries a tighter explicit limit overrides this below.
 */
export const DEFAULT_INVOKE_RATE_LIMIT: InvokeRateLimit = {
  windowMs: 60_000,
  max: 60,
};

/**
 * Stricter per-capability budgets that mirror the explicit rate-limit
 * middleware the capability's REST route installs (see
 * `apps/api/src/handlers/entities/routes.ts`). Values track `API_RATE_LIMITS`
 * so the generic path and the REST route stay in lockstep. A capability absent
 * here uses `DEFAULT_INVOKE_RATE_LIMIT`.
 */
export const INVOKE_RATE_LIMIT_OVERRIDES: Record<string, InvokeRateLimit> = {
  // entities.translate: ships a full document to the external provider and
  // consumes the org's paid character quota (REST: translate limiter).
  "entities.translate": {
    windowMs: API_RATE_LIMITS.translate.duration,
    max: API_RATE_LIMITS.translate.max,
  },
  // entities.upload / upload-version: the REST upload limiter (separate budget).
  "entities.upload": {
    windowMs: API_RATE_LIMITS.upload.duration,
    max: API_RATE_LIMITS.upload.max,
  },
  "entities.upload-version": {
    windowMs: API_RATE_LIMITS.upload.duration,
    max: API_RATE_LIMITS.upload.max,
  },
  // Skill discovery/import fetches third-party URLs. Their REST routes share
  // the dedicated source-fetch budget; generic capability invocation must not
  // fall back to the looser default budget and amplify outbound traffic.
  "skills.discover": {
    windowMs: API_RATE_LIMITS.skillSource.duration,
    max: API_RATE_LIMITS.skillSource.max,
  },
  "skills.import": {
    windowMs: API_RATE_LIMITS.skillSource.duration,
    max: API_RATE_LIMITS.skillSource.max,
  },
  "skills.import-url": {
    windowMs: API_RATE_LIMITS.skillSource.duration,
    max: API_RATE_LIMITS.skillSource.max,
  },
};

/** Capabilities whose REST routes consume one shared client-IP budget. */
const SKILL_SOURCE_CAPABILITY_IDS = new Set([
  "skills.discover",
  "skills.import",
  "skills.import-url",
]);

export const resolveInvokeRateLimit = (capabilityId: string): InvokeRateLimit =>
  INVOKE_RATE_LIMIT_OVERRIDES[capabilityId] ?? DEFAULT_INVOKE_RATE_LIMIT;

/** Process-wide limiter instance; its own guards so it never shares counters. */
const invokeCapabilityGuards = createFeedbackIntakeGuards();

export type InvokeRateLimitResult = { ok: boolean; retryAfterSeconds: number };

/**
 * Consume one unit of the applicable invoke budget. Skill-source capabilities
 * share the REST client-IP counter; all others use the (organization,
 * capability) counter. `ok: false` once the window is exhausted;
 * `retryAfterSeconds` lets the caller render a retry hint. Dependencies are
 * injectable for tests.
 */
export const consumeInvokeCapabilityRateLimit = async ({
  capabilityId,
  clientIp = null,
  organizationId,
  guards = invokeCapabilityGuards,
  consumeSkillSource = consumeSkillSourceRateLimit,
}: {
  capabilityId: string;
  clientIp?: string | null;
  organizationId: SafeId<"organization">;
  guards?: FeedbackIntakeGuards;
  consumeSkillSource?: (input: {
    clientIp: string | null;
  }) => Promise<SkillSourceRateLimitResult>;
}): Promise<InvokeRateLimitResult> => {
  if (SKILL_SOURCE_CAPABILITY_IDS.has(capabilityId)) {
    return await consumeSkillSource({ clientIp });
  }
  const limit = resolveInvokeRateLimit(capabilityId);
  const ok = await guards.consumeCounter({
    bucket: INVOKE_CAPABILITY_BUCKET,
    key: `${organizationId}:${capabilityId}`,
    windowMs: limit.windowMs,
    max: limit.max,
  });
  return { ok, retryAfterSeconds: Math.ceil(limit.windowMs / 1000) };
};
