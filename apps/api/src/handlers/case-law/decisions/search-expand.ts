import { Result } from "better-result";
import * as v from "valibot";

import {
  PUBLIC_CASE_LAW_COUNTRIES,
  type PublicCaseLawCountry,
  publicCaseLawCountry,
} from "@stll/api-contract/case-law-launch-readiness";
import {
  isWholeEntryIdentifier,
  parseDecisionQuery,
} from "@stll/api-contract/decision-query-intent";
import { decisionReporterGrammarForJurisdiction } from "@stll/api-contract/us-reporter-citation";
import { Temporal } from "@stll/time";

import type { SafeDb } from "@/api/db/safe-db";
import { envBase } from "@/api/env-base";
import { type OrgAIConfig, resolveCaching } from "@/api/lib/ai-config";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import {
  ACCOUNT_ACCESS,
  configuredModelAdmission,
  createSafeRootHandler,
} from "@/api/lib/api-handlers";
import type {
  HandlerConfig,
  SafeHandlerGenerator,
} from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import type { ManagedAIResidency } from "@/api/lib/chat/ai-data-policy";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { decisionDocketGrammarForCountry } from "@/api/lib/legal-search/adapter-manifest";
import {
  type CorpusQueryToken,
  formatCorpusQueryTokens,
  partitionCorpusFunctionWords,
  tokenizeCorpusFreeText,
} from "@/api/lib/legal-search/corpus-query";
import {
  LEGAL_ALTERNATIVES_LIMITS,
  type LegalAlternatives,
  normalizeLegalAlternatives,
} from "@/api/lib/legal-search/legal-alternatives";
import { corpusMorphologyLanguage } from "@/api/lib/legal-search/morphology/corpus-language";
import {
  functionWordKey,
  functionWordsFor,
} from "@/api/lib/legal-search/morphology/function-words";
import {
  readPublicLawCountry,
  tPublicLawCountry,
} from "@/api/lib/legal-search/public-law-country";
import type { PublicCountryUnavailableAnswer } from "@/api/lib/legal-search/public-law-country";
import { LIMITS } from "@/api/lib/limits";
import type { ModelDispatchAdmission } from "@/api/lib/rate-limit/model-dispatch-admission";
import { generateTanStackObjectForTask } from "@/api/lib/tanstack-ai-generate";
import { requireTanStackAIAvailableForTask } from "@/api/lib/tanstack-ai-models";

/**
 * How long a search waits for alternatives. Past this the reader gets the
 * search they typed, which is a search, rather than a slow one. It covers a
 * short structured answer from a fast model on every offered provider: a
 * deadline under that never sees an answer, yet still spends the usage.
 * `maxOutputTokens` sizes the reply only; reasoning is reserved on top of it.
 * Read by the structured-output request settings test.
 *
 * @public
 */
export const EXPANSION_REQUEST = {
  maxOutputTokens: 200,
  deadlineMs: 4000,
} as const;

/** How long one answer is reused for the same query, language and org. */
const EXPANSION_CACHE_TTL_MS = 60 * 60_000;
const EXPANSION_CACHE_MAX_ENTRIES = 2000;

/** Read by the structured-output role contract test. @public */
export const EXPANSION_SYSTEM = `You propose legal-vocabulary alternatives for a case-law search.

The search runs over court decisions of one jurisdiction and requires every word of the query. For each word that is an everyday or colloquial term, give the words the statutes and courts of that jurisdiction use for the same concept, in corpusLanguage (or in the query's language when corpusLanguage is null).

Rules:
- Only exact equivalents of the same concept. No broader, narrower or related terms, no antonyms.
- Base form only; inflection is handled by the search.
- Skip words that are already the legal term, and function words.
- At most ${String(LEGAL_ALTERNATIVES_LIMITS.perTerm)} alternatives per word, one to ${String(LEGAL_ALTERNATIVES_LIMITS.words)} words each. Return an empty list when nothing applies.

Example (CZE, cs): "vrácení kauce" gives {"alternatives":[{"term":"kauce","alternatives":["jistota"]}]}`;

/**
 * The shape only, not the bounds. A model that returns one alternative too
 * many must not lose the valid ones beside it: `normalizeLegalAlternatives`
 * enforces every bound, dropping what exceeds it, and `maxOutputTokens` caps
 * what can arrive at all.
 */
/** Read by the structured-output role contract test. @public */
export const expansionOutputSchema = v.strictObject({
  alternatives: v.array(
    v.strictObject({
      term: v.string(),
      alternatives: v.array(v.string()),
    }),
  ),
});

type CachedExpansion = { alternatives: LegalAlternatives; expiresAt: number };

/**
 * Answers per organization, language and query. Scoped to the organization
 * because the model ran under its AI configuration and was metered to it;
 * kept in process because a reader's query is theirs, and a replica that
 * misses simply asks again. Oldest entries go first once the map is full.
 */
const expansionCache = new Map<string, CachedExpansion>();

const readCachedExpansion = (key: string): LegalAlternatives | null => {
  const cached = expansionCache.get(key);
  if (cached === undefined) {
    return null;
  }
  if (cached.expiresAt <= Temporal.Now.instant().epochMilliseconds) {
    expansionCache.delete(key);
    return null;
  }
  return cached.alternatives;
};

const cacheExpansion = (key: string, alternatives: LegalAlternatives) => {
  if (expansionCache.size >= EXPANSION_CACHE_MAX_ENTRIES) {
    const oldest = expansionCache.keys().next();
    if (oldest.done !== true) {
      expansionCache.delete(oldest.value);
    }
  }
  expansionCache.set(key, {
    alternatives,
    expiresAt:
      Temporal.Now.instant().epochMilliseconds + EXPANSION_CACHE_TTL_MS,
  });
};

/**
 * What an answer is. `expanded` and `none` are settled and may be reused;
 * `degraded` is a model call that failed or timed out, which the caller
 * searches without and asks again later.
 */
type ExpansionOutcome = "degraded" | "expanded" | "none";

type ExpansionAnswer = {
  alternatives: LegalAlternatives;
  outcome: ExpansionOutcome;
};

const NO_ALTERNATIVES: ExpansionAnswer = { alternatives: [], outcome: "none" };
const DEGRADED: ExpansionAnswer = { alternatives: [], outcome: "degraded" };

const settledAnswer = (alternatives: LegalAlternatives): ExpansionAnswer => ({
  alternatives,
  outcome: alternatives.length === 0 ? "none" : "expanded",
});

/**
 * The model call behind a search expansion: asks the organization's model for
 * alternatives to the query's required words and settles its answer. Apart
 * from the handler's admission and cache so a test runs exactly this request
 * against a recorded provider answer.
 *
 * @public
 */
export const proposeLegalAlternatives = async ({
  abortSignal,
  admission,
  country,
  managedAIResidency,
  orgAIConfig,
  organizationId,
  promptCachingEnabled,
  query,
  required,
  safeDb,
  userId,
}: {
  abortSignal: AbortSignal;
  admission: ModelDispatchAdmission;
  country: PublicCaseLawCountry;
  managedAIResidency: ManagedAIResidency;
  orgAIConfig: OrgAIConfig | null;
  organizationId: SafeId<"organization">;
  promptCachingEnabled: boolean;
  query: string;
  required: readonly CorpusQueryToken[];
  safeDb: SafeDb;
  userId: SafeId<"user">;
}): Promise<ExpansionAnswer> => {
  const corpusLanguage = corpusMorphologyLanguage(country);
  const analytics = createTanStackAIAnalyticsCallbacks({
    dataClass: "customer",
    usageMetering: {
      actionType: "chat",
      organizationId,
      safeDb,
      serviceTier: "standard",
      userId,
      workspaceId: null,
    },
    feature: "case-law.search.expand",
    modelTask: "search-expand",
    orgAIConfig,
    modelTier: admission.modelTier,
    properties: { organization_id: organizationId, jurisdiction: country },
    traceId: Bun.randomUUIDv7(),
  });
  const generated = await Result.tryPromise({
    try: async () =>
      await generateTanStackObjectForTask({
        userId,
        dataClass: "customer",
        admission,
        task: "search-expand",
        serviceTier: "standard",
        orgAIConfig,
        managedAIResidency,
        organizationId,
        tenantWorkspaceIds: [],
        analytics,
        caching: resolveCaching({
          promptCachingEnabled,
          task: "search-expand",
          scopeKey: null,
        }),
        system: EXPANSION_SYSTEM,
        prompt: JSON.stringify({
          jurisdiction: country,
          corpusLanguage,
          query: formatCorpusQueryTokens(required),
        }),
        outputSchema: expansionOutputSchema,
        ...EXPANSION_REQUEST,
        abortSignal,
      }),
    catch: (error: unknown) => error,
  });
  // A timeout or a failed call degrades to the search as typed, and is
  // reported.
  if (generated.isErr()) {
    analytics.captureError(generated.error);
    return DEGRADED;
  }
  return settledAnswer(
    normalizeLegalAlternatives(generated.value.alternatives, {
      functionWords: functionWordsFor(corpusLanguage),
      query,
    }),
  );
};

const config = {
  contract: "patch",
  actionAdmission: { type: "handler", actionKind: "case-law.search-expand" },
  description:
    "Propose legal-vocabulary alternatives for a case-law search's words: " +
    "the terms the jurisdiction's statutes and courts use for an everyday " +
    "word, in the corpus language. The answer is passed to the case-law " +
    "search as `alternatives`, which ORs them beside each word. Empty when " +
    "the organization has no AI available, the query is an identifier, the " +
    "deployment searches without the corpus index, or the model does not " +
    "answer in time (`outcome: degraded`, worth asking again). Consumes AI " +
    "usage.",
  // The grant AI chat carries: one AI spend, withheld from roles that may
  // not start a chat.
  permissions: { chat: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "search_ui" },
  body: v.object({
    query: v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(LIMITS.searchQueryMaxLength),
    ),
    country: tPublicLawCountry,
  }),
  requiresUsage: { actionType: "chat", modelTask: "search-expand" },
} satisfies HandlerConfig;

const expandCaseLawSearch = createSafeRootHandler(
  config,
  async function* ({
    modelAdmission,
    body,
    orgAIConfig,
    managedAIResidency,
    orgAIConfigStatus,
    promptCachingEnabled,
    request,
    safeDb,
    session,
    user,
  }): SafeHandlerGenerator<ExpansionAnswer | PublicCountryUnavailableAnswer> {
    if (orgAIConfigStatus === ORG_AI_CONFIG_STATUS.unreadable) {
      return Result.ok(NO_ALTERNATIVES);
    }

    const countryRead = readPublicLawCountry(body.country, {
      domain: "caseLaw",
      admitted: PUBLIC_CASE_LAW_COUNTRIES,
      surface: "search",
    });
    if (countryRead.kind === "unavailable") {
      return Result.ok(countryRead.answer);
    }
    if (countryRead.kind === "unreadable") {
      return yield* Result.err(
        new HandlerError({ status: 400, message: countryRead.message }),
      );
    }
    const country = publicCaseLawCountry(countryRead.country);
    if (country === null) {
      return yield* Result.err(
        new HandlerError({ status: 404, message: "Not Found" }),
      );
    }

    // Only the corpus-index search reads alternatives; the Postgres search
    // requires the words as typed, so asking the model there would spend
    // usage on an answer no query uses.
    if (envBase.LEGAL_SEARCH_PROVIDER !== "corpus-index") {
      return Result.ok(NO_ALTERNATIVES);
    }

    // An entry that is an identifier is matched as written, so there is
    // nothing to expand; words around an embedded one are still text.
    const intent = parseDecisionQuery(body.query, {
      grammar: decisionDocketGrammarForCountry(country),
      reporters: decisionReporterGrammarForJurisdiction(country),
    });
    if (isWholeEntryIdentifier(intent)) {
      return Result.ok(NO_ALTERNATIVES);
    }

    // No AI for this organization means no expansion, not a failed search.
    const available = requireTanStackAIAvailableForTask({
      dataClass: "customer",
      configStatus: orgAIConfigStatus,
      orgConfig: orgAIConfig,
      task: "search-expand",
    });
    if (available.isErr()) {
      return Result.ok(NO_ALTERNATIVES);
    }

    const functionWords = functionWordsFor(corpusMorphologyLanguage(country));
    const { required } = partitionCorpusFunctionWords(
      tokenizeCorpusFreeText(body.query),
      functionWords,
    );
    if (!required.some((token) => token.type === "term")) {
      return Result.ok(NO_ALTERNATIVES);
    }

    const organizationId = session.activeOrganizationId;
    const cacheKey = [
      organizationId,
      country,
      functionWordKey(formatCorpusQueryTokens(required)),
    ].join("\u0000");
    const cached = readCachedExpansion(cacheKey);
    if (cached !== null) {
      return Result.ok(settledAnswer(cached));
    }

    const answer = await proposeLegalAlternatives({
      abortSignal: request.signal,
      admission: configuredModelAdmission({ modelAdmission }),
      country,
      managedAIResidency,
      orgAIConfig,
      organizationId,
      promptCachingEnabled,
      query: body.query,
      required,
      safeDb,
      userId: user.id,
    });
    // A degraded answer is not cached, so the next search asks again.
    if (answer.outcome !== "degraded") {
      cacheExpansion(cacheKey, answer.alternatives);
    }
    return Result.ok(answer);
  },
);

export default expandCaseLawSearch;
