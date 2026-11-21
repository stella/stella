import { Result } from "better-result";
import * as v from "valibot";

import { AI_FAILURE_CODES } from "@stll/api-contract";
import {
  PUBLIC_CASE_LAW_COUNTRIES,
  publicCaseLawCountry,
} from "@stll/api-contract/case-law-launch-readiness";

import {
  CASE_LAW_SEARCH_REFINE_SYSTEM,
  caseLawRefineOutputSchema,
  isIncompleteCaseLawRefineGeneration,
  normalizeCaseLawRefinedQuery,
} from "@/api/handlers/case-law/decisions/search-refine-query";
import { resolveCaching } from "@/api/lib/ai-config";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { storedAIConfigUnreadableError } from "@/api/lib/ai-config-response";
import { aiHandlerError } from "@/api/lib/ai-error";
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
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { corpusMorphologyLanguage } from "@/api/lib/legal-search/morphology/corpus-language";
import { functionWordsFor } from "@/api/lib/legal-search/morphology/function-words";
import {
  readPublicLawCountry,
  tPublicLawCountry,
} from "@/api/lib/legal-search/public-law-country";
import type { PublicCountryUnavailableAnswer } from "@/api/lib/legal-search/public-law-country";
import { LIMITS } from "@/api/lib/limits";
import { generateTanStackObjectForTask } from "@/api/lib/tanstack-ai-generate";
import { requireTanStackAIAvailableForTask } from "@/api/lib/tanstack-ai-models";

const CASE_LAW_REFINE_MAX_ATTEMPTS = 3;
const CASE_LAW_REFINE_TIMEOUT_MS = 20_000;
const REFINE_FAILED_MESSAGE = "Failed to improve search query";

const config = {
  contract: "patch",
  actionAdmission: { type: "handler", actionKind: "case-law.search-refine" },
  description:
    "Rewrite a case-law search into the words court decisions of the " +
    "jurisdiction use, in the corpus language: statutory terms for everyday " +
    "ones, question words dropped. Returns plain words the case-law search " +
    "requires, never boolean syntax. Stores nothing. Consumes AI usage.",
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
    locale: v.optional(v.pipe(v.string(), v.maxLength(16))),
  }),
  requiresUsage: { actionType: "chat", modelTask: "search-expand" },
} satisfies HandlerConfig;

const refineCaseLawSearch = createSafeRootHandler(
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
  }): SafeHandlerGenerator<{ query: string } | PublicCountryUnavailableAnswer> {
    if (orgAIConfigStatus === ORG_AI_CONFIG_STATUS.unreadable) {
      return Result.err(storedAIConfigUnreadableError());
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

    yield* requireTanStackAIAvailableForTask({
      dataClass: "customer",
      configStatus: orgAIConfigStatus,
      orgConfig: orgAIConfig,
      task: "search-expand",
    });

    // The language the search stems and drops function words in, so the
    // model writes, and the check below counts, the words that search will
    // require. Null for a jurisdiction publishing in several languages (the
    // EU index), where the model keeps the reader's language.
    const corpusLanguage = corpusMorphologyLanguage(country);
    const functionWords = functionWordsFor(corpusLanguage);
    const organizationId = session.activeOrganizationId;
    const analytics = createTanStackAIAnalyticsCallbacks({
      dataClass: "customer",
      usageMetering: {
        actionType: "chat",
        organizationId,
        safeDb,
        serviceTier: "standard",
        userId: user.id,
        workspaceId: null,
      },
      feature: "case-law.search.refine",
      modelTask: "search-expand",
      orgAIConfig,
      modelTier: configuredModelAdmission({ modelAdmission }).modelTier,
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
          await generateTanStackObjectForTask({
            userId: user.id,
            dataClass: "customer",
            admission: configuredModelAdmission({ modelAdmission }),
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
            system: CASE_LAW_SEARCH_REFINE_SYSTEM,
            prompt,
            outputSchema: caseLawRefineOutputSchema,
            maxOutputTokens: 120,
            abortSignal: request.signal,
            deadlineMs: CASE_LAW_REFINE_TIMEOUT_MS,
          }),
        catch: (error: unknown) => {
          analytics.captureError(error);
          return error;
        },
      });
      if (generated.isErr()) {
        if (
          attempt < CASE_LAW_REFINE_MAX_ATTEMPTS &&
          isIncompleteCaseLawRefineGeneration(generated.error)
        ) {
          continue;
        }
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
      new HandlerError({
        code: AI_FAILURE_CODES.output_invalid,
        status: 502,
        message: REFINE_FAILED_MESSAGE,
      }),
    );
  },
);

export default refineCaseLawSearch;
