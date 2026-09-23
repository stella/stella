import { Result } from "better-result";
import { t } from "elysia";

import {
  PUBLIC_CASE_LAW_COUNTRIES,
  publicCaseLawCountry,
} from "@stll/api-contract/case-law-launch-readiness";

import {
  CASE_LAW_SEARCH_REFINE_SYSTEM,
  caseLawRefineOutputSchema,
  normalizeCaseLawRefinedQuery,
} from "@/api/handlers/case-law/decisions/search-refine-query";
import { resolveCaching } from "@/api/lib/ai-config";
import { aiHandlerError } from "@/api/lib/ai-error";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { corpusMorphologyLanguage } from "@/api/lib/legal-search/morphology/corpus-language";
import { functionWordsFor } from "@/api/lib/legal-search/morphology/function-words";
import {
  readPublicLawCountry,
  tPublicLawCountry,
} from "@/api/lib/legal-search/public-law-country";
import { LIMITS } from "@/api/lib/limits";
import { generateTanStackObjectForRole } from "@/api/lib/tanstack-ai-generate";
import { requireTanStackAIAvailableForRole } from "@/api/lib/tanstack-ai-models";

const CASE_LAW_REFINE_MAX_ATTEMPTS = 3;
const CASE_LAW_REFINE_TIMEOUT_MS = 20_000;
const REFINE_FAILED_MESSAGE = "Failed to improve search query";

const config = {
  description:
    "Rewrite a case-law search into the words court decisions of the " +
    "jurisdiction use, in the corpus language: statutory terms for everyday " +
    "ones, question words dropped. Returns plain words the case-law search " +
    "requires, never boolean syntax. Stores nothing. Consumes AI usage.",
  // The grant AI chat carries: one AI spend, withheld from roles that may
  // not start a chat.
  permissions: { chat: ["create"] },
  mcp: { type: "internal", reason: "search_ui" },
  body: t.Object({
    query: t.String({ minLength: 1, maxLength: LIMITS.searchQueryMaxLength }),
    country: tPublicLawCountry,
    locale: t.Optional(t.String({ maxLength: 16 })),
  }),
  requiresUsage: { actionType: "chat", modelRole: "fast" },
} satisfies HandlerConfig;

const refineCaseLawSearch = createSafeRootHandler(
  config,
  async function* ({
    body,
    orgAIConfig,
    orgAIConfigStatus,
    promptCachingEnabled,
    request,
    safeDb,
    session,
    user,
  }) {
    const countryRead = readPublicLawCountry(body.country, {
      admitted: PUBLIC_CASE_LAW_COUNTRIES,
    });
    if (countryRead.kind === "unreadable") {
      return Result.err(
        new HandlerError({ status: 400, message: countryRead.message }),
      );
    }
    const country = publicCaseLawCountry(countryRead.country);
    if (country === null) {
      return Result.err(
        new HandlerError({ status: 404, message: "Not Found" }),
      );
    }

    yield* requireTanStackAIAvailableForRole({
      configStatus: orgAIConfigStatus,
      orgConfig: orgAIConfig,
      role: "fast",
    });

    // The language the search stems and drops function words in, so the
    // model writes, and the check below counts, the words that search will
    // require. Null for a jurisdiction publishing in several languages (the
    // EU index), where the model keeps the reader's language.
    const corpusLanguage = corpusMorphologyLanguage(country);
    const functionWords = functionWordsFor(corpusLanguage);
    const organizationId = session.activeOrganizationId;
    const analytics = createTanStackAIAnalyticsCallbacks({
      usageMetering: {
        actionType: "chat",
        organizationId,
        safeDb,
        serviceTier: "standard",
        userId: user.id,
        workspaceId: null,
      },
      feature: "case-law.search.refine",
      modelRole: "fast",
      orgAIConfig,
      properties: { organization_id: organizationId, jurisdiction: country },
      traceId: Bun.randomUUIDv7(),
    });

    let lastValidationError: string | null = null;
    for (
      let attempt = 1;
      attempt <= CASE_LAW_REFINE_MAX_ATTEMPTS;
      attempt += 1
    ) {
      // Sequential by construction: the next attempt's prompt carries this
      // attempt's rejection.
      const prompt = JSON.stringify({
        attempt,
        jurisdiction: country,
        corpusLanguage,
        locale: body.locale ?? null,
        query: body.query,
        previousValidationError: lastValidationError,
      });
      const generated = await Result.tryPromise({
        try: async () =>
          await generateTanStackObjectForRole({
            role: "fast",
            serviceTier: "standard",
            orgAIConfig,
            organizationId,
            // Public law: no matter's data reaches the model.
            tenantWorkspaceIds: [],
            analytics,
            caching: resolveCaching({
              promptCachingEnabled,
              role: "fast",
              scopeKey: null,
            }),
            system: CASE_LAW_SEARCH_REFINE_SYSTEM,
            prompt,
            outputSchema: caseLawRefineOutputSchema,
            maxOutputTokens: 120,
            abortSignal: AbortSignal.any([
              request.signal,
              AbortSignal.timeout(CASE_LAW_REFINE_TIMEOUT_MS),
            ]),
          }),
        catch: (error: unknown) => {
          analytics.captureError(error);
          return error;
        },
      });
      if (generated.isErr()) {
        return Result.err(
          aiHandlerError(generated.error, {
            status: 502,
            message: REFINE_FAILED_MESSAGE,
          }),
        );
      }

      const normalized = normalizeCaseLawRefinedQuery(
        generated.value.query,
        functionWords,
      );
      if (normalized.isOk()) {
        return Result.ok({ query: normalized.value });
      }
      lastValidationError = normalized.error;
    }

    return Result.err(
      new HandlerError({ status: 502, message: REFINE_FAILED_MESSAGE }),
    );
  },
);

export default refineCaseLawSearch;
