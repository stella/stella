/**
 * Gateway-side rate limit for `invoke_capability`. Most capabilities are keyed
 * per (organization, capability id); outbound skill-source capabilities consume
 * the REST routes' shared client-IP budget instead.
 *
 * The generic invoke path bypasses the per-route rate-limit middleware some REST
 * routes install (e.g. `document-translations.runs.create`, `entities.upload`), so it needs its
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

import { panic } from "better-result";

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

type InvokeRateLimitPolicy =
  | { budget: "capability"; limit: InvokeRateLimit }
  | { budget: "skill-source"; limit: InvokeRateLimit };

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

const DEFAULT_INVOKE_RATE_LIMIT_POLICY = {
  budget: "capability",
  limit: DEFAULT_INVOKE_RATE_LIMIT,
} as const satisfies InvokeRateLimitPolicy;

/**
 * Stricter per-capability budgets that mirror the explicit rate-limit
 * middleware the capability's REST route installs (see
 * `apps/api/src/handlers/entities/routes.ts`). Values track `API_RATE_LIMITS`
 * so the generic path and the REST route stay in lockstep. A capability absent
 * here uses `DEFAULT_INVOKE_RATE_LIMIT`.
 */
const INVOKE_RATE_LIMIT_POLICY_BY_CAPABILITY: Readonly<
  Record<string, InvokeRateLimitPolicy>
> = {
  // A translation run ships a document to the provider and spends the org's
  // paid character quota; a bilingual layout shares the same conversion budget
  // (REST: translate limiter on both routes).
  "document-translations.runs.create": {
    budget: "capability",
    limit: {
      windowMs: API_RATE_LIMITS.translate.duration,
      max: API_RATE_LIMITS.translate.max,
    },
  },
  "entities.bilingual.create": {
    budget: "capability",
    limit: {
      windowMs: API_RATE_LIMITS.translate.duration,
      max: API_RATE_LIMITS.translate.max,
    },
  },
  // entities.upload / upload-version: the REST upload limiter (separate budget).
  "entities.upload": {
    budget: "capability",
    limit: {
      windowMs: API_RATE_LIMITS.upload.duration,
      max: API_RATE_LIMITS.upload.max,
    },
  },
  "entities.upload-version": {
    budget: "capability",
    limit: {
      windowMs: API_RATE_LIMITS.upload.duration,
      max: API_RATE_LIMITS.upload.max,
    },
  },
  // Skill discovery/import fetches third-party URLs. Their REST routes share
  // the dedicated source-fetch budget; generic capability invocation must not
  // fall back to the looser default budget and amplify outbound traffic.
  "skills.discover": {
    budget: "skill-source",
    limit: {
      windowMs: API_RATE_LIMITS.skillSource.duration,
      max: API_RATE_LIMITS.skillSource.max,
    },
  },
  "skills.import": {
    budget: "skill-source",
    limit: {
      windowMs: API_RATE_LIMITS.skillSource.duration,
      max: API_RATE_LIMITS.skillSource.max,
    },
  },
  "skills.import-url": {
    budget: "skill-source",
    limit: {
      windowMs: API_RATE_LIMITS.skillSource.duration,
      max: API_RATE_LIMITS.skillSource.max,
    },
  },
};

const resolveInvokeRateLimitPolicy = (
  capabilityId: string,
): InvokeRateLimitPolicy =>
  INVOKE_RATE_LIMIT_POLICY_BY_CAPABILITY[capabilityId] ??
  DEFAULT_INVOKE_RATE_LIMIT_POLICY;

export const resolveInvokeRateLimit = (capabilityId: string): InvokeRateLimit =>
  resolveInvokeRateLimitPolicy(capabilityId).limit;

/** Process-wide limiter instance; its own guards so it never shares counters. */
const invokeCapabilityGuards = createFeedbackIntakeGuards();

export type InvokeRateLimitResult = { ok: boolean; retryAfterSeconds: number };

/**
 * Consume one unit of the applicable invoke budget. Skill-source capabilities
 * share the REST client-IP counter; all others use the (user, organization,
 * capability) counter. The user belongs in the key: without it one caller's
 * traffic exhausts the window for every other member of the org, which turns a
 * per-caller cost cap into a shared outage. `ok: false` once the window is
 * exhausted; `retryAfterSeconds` lets the caller render a retry hint.
 * Dependencies are injectable for tests.
 */
export const consumeInvokeCapabilityRateLimit = async ({
  capabilityId,
  clientIp = null,
  organizationId,
  userId,
  guards = invokeCapabilityGuards,
  consumeSkillSource = consumeSkillSourceRateLimit,
}: {
  capabilityId: string;
  clientIp?: string | null;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  guards?: FeedbackIntakeGuards;
  consumeSkillSource?: (input: {
    clientIp: string | null;
  }) => Promise<SkillSourceRateLimitResult>;
}): Promise<InvokeRateLimitResult> => {
  const policy = resolveInvokeRateLimitPolicy(capabilityId);
  switch (policy.budget) {
    case "skill-source":
      return await consumeSkillSource({ clientIp });
    case "capability": {
      const { limit } = policy;
      const ok = await guards.consumeCounter({
        bucket: INVOKE_CAPABILITY_BUCKET,
        key: `${organizationId}:${userId}:${capabilityId}`,
        windowMs: limit.windowMs,
        max: limit.max,
      });
      return { ok, retryAfterSeconds: Math.ceil(limit.windowMs / 1000) };
    }
    default:
      policy satisfies never;
      return panic(`Unhandled policy: ${String(policy)}`);
  }
};
