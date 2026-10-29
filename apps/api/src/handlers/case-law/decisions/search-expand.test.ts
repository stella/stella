import { panic, Result } from "better-result";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { getModelDefaultReasoningEffort } from "@stll/ai-catalog";
import { publicCaseLawCountry } from "@stll/api-contract/case-law-launch-readiness";

import type { SafeDb } from "@/api/db/safe-db";
import { env } from "@/api/env";
import { proposeLegalAlternatives } from "@/api/handlers/case-law/decisions/search-expand";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import {
  partitionCorpusFunctionWords,
  tokenizeCorpusFreeText,
} from "@/api/lib/legal-search/corpus-query";
import { corpusMorphologyLanguage } from "@/api/lib/legal-search/morphology/corpus-language";
import { functionWordsFor } from "@/api/lib/legal-search/morphology/function-words";
import { isRecord } from "@/api/lib/type-guards";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { testModelAdmission } from "@/api/tests/helpers/model-dispatch-admission";
import {
  recordedScenarioBody,
  streamCarrying,
} from "@/api/tests/helpers/provider-wire-answer";
import { loadProviderWireCassettes } from "@/api/tests/helpers/provider-wire-cassette";
import { createTestFetch } from "@/api/tests/helpers/test-fetch";
import { createTestState } from "@/api/tests/helpers/test-state";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const testFetchState = createTestFetch();

// The expansion's own model call, with the organization's real model
// resolution, request options, adapter and answer parsing; only `fetch` is
// answered, from each provider's recorded stream. The stand-in provider keeps
// the one rule a short structured reply depends on: a model that reasons
// spends its reasoning inside the request's output ceiling, and a ceiling
// that reasoning fills ends the run at `length` with no answer at all.

const cassettes = loadProviderWireCassettes();
const realFetch = globalThis.fetch;

/** Tokens a model that reasons spends before its first answer token. */
const REASONING_SPEND = 600;
/** Tokens the recorded answer below takes. */
const ANSWER_TOKENS = 30;
const ANSWER = JSON.stringify({
  alternatives: [{ term: "kauce", alternatives: ["jistota"] }],
});

type Provider = "google" | "openrouter";

type ProviderRequest = {
  body: Record<string, unknown>;
  modelId: string;
  provider: Provider;
};

const sent: ProviderRequest[] = [];
const provider: { forceReasoningOnly: boolean; latencyMs: number } = {
  forceReasoningOnly: false,
  latencyMs: 0,
};

const objectField = (
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> => {
  const value = record[key];
  return isRecord(value) ? value : {};
};

/** A model left without a reasoning setting reasons at its published default. */
const reasonsByDefault = (modelId: string) =>
  (getModelDefaultReasoningEffort(modelId) ?? "none") !== "none";

/** The ceiling and the reasoning a request asks for, read off the wire. */
const readRequest = ({ body, modelId, provider: name }: ProviderRequest) => {
  if (name === "google") {
    const generation = objectField(body, "generationConfig");
    const thinking = objectField(generation, "thinkingConfig");
    const budget = thinking["thinkingBudget"];
    return {
      ceiling: generation["maxOutputTokens"],
      reasons:
        thinking["thinkingLevel"] !== undefined ||
        (budget === undefined ? reasonsByDefault(modelId) : budget !== 0),
    };
  }
  const effort = objectField(body, "reasoning")["effort"];
  return {
    ceiling: body["max_completion_tokens"],
    reasons:
      effort === undefined ? reasonsByDefault(modelId) : effort !== "none",
  };
};

const answerFor = (request: ProviderRequest) => {
  const { ceiling, reasons } = readRequest(request);
  const needed = (reasons ? REASONING_SPEND : 0) + ANSWER_TOKENS;
  if (
    provider.forceReasoningOnly ||
    (typeof ceiling === "number" && ceiling < needed)
  ) {
    return request.provider === "google"
      ? recordedScenarioBody(cassettes, "google", "length", "reasoning-only")
      : recordedScenarioBody(cassettes, "openrouter", "length", "empty-text");
  }
  const { body, headers } = recordedScenarioBody(
    cassettes,
    request.provider,
    "text",
  );
  return { body: streamCarrying(body, ANSWER), headers };
};

/** Which provider a request went to, and the model it names. */
const providerRequestOf = (
  url: URL,
  body: Record<string, unknown>,
): ProviderRequest => {
  if (url.hostname === "generativelanguage.googleapis.com") {
    const modelId =
      /\/models\/([^/:]+):/u.exec(url.pathname)?.[1] ??
      panic(`No model in ${url.pathname}`);
    return { body, modelId, provider: "google" };
  }
  if (url.hostname === "openrouter.ai") {
    const modelId = body["model"];
    if (typeof modelId !== "string") {
      return panic("An OpenRouter request names no model");
    }
    return { body, modelId, provider: "openrouter" };
  }
  return panic(`An unexpected request left the test: ${url.href}`);
};

const answeringFetch: typeof globalThis.fetch = Object.assign(
  async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const request =
      input instanceof Request
        ? new Request(input, init)
        : new Request(String(input), init);
    const parsed: unknown = await request.json();
    const providerRequest = providerRequestOf(
      new URL(request.url),
      isRecord(parsed) ? parsed : {},
    );
    sent.push(providerRequest);
    if (provider.latencyMs > 0) {
      await Bun.sleep(provider.latencyMs);
    }
    const { body, headers } = answerFor(providerRequest);
    return new Response(body, { status: 200, headers });
  },
  { preconnect: realFetch.preconnect },
);

const testState = createTestState({ file: import.meta.path, config: env });

testState.beforeAll(() => {
  testState.setConfig("USE_MOCK_AI", false);
});

beforeEach(() => {
  testFetchState.set(answeringFetch);
});

afterEach(() => {
  testFetchState.restore();
});

/** Usage is recorded through the request's database scope; none here. */
const recordingSafeDb = asTestRaw<SafeDb>(async () =>
  Result.ok({ status: "recorded" }),
);

const COUNTRY = publicCaseLawCountry("CZE") ?? panic("CZE is public");
const QUERY = "vrácení kauce";

const expand = async (orgAIConfig: OrgAIConfig) => {
  const organizationId = mintAuthProviderId<"organization">();
  const { required } = partitionCorpusFunctionWords(
    tokenizeCorpusFreeText(QUERY),
    functionWordsFor(corpusMorphologyLanguage(COUNTRY)),
  );
  sent.length = 0;
  return await proposeLegalAlternatives({
    abortSignal: new AbortController().signal,
    admission: testModelAdmission(organizationId, "case-law.search-expand"),
    country: COUNTRY,
    managedAIResidency: "eu",
    orgAIConfig,
    organizationId,
    promptCachingEnabled: false,
    query: QUERY,
    required,
    safeDb: recordingSafeDb,
    userId: mintAuthProviderId<"user">(),
  });
};

const orgConfig = (name: Provider, fastModelId?: string): OrgAIConfig => ({
  providers: [{ provider: name, apiKey: "search-expand-test-key" }],
  overrideModels:
    fastModelId === undefined
      ? null
      : { fast: { provider: name, modelId: fastModelId } },
  decision: null,
});

const EXPANDED = {
  alternatives: [{ term: "kauce", alternatives: ["jistota"] }],
  outcome: "expanded",
} satisfies Awaited<ReturnType<typeof proposeLegalAlternatives>>;

const onlyRequest = () => {
  expect(sent).toHaveLength(1);
  return readRequest(sent.at(0) ?? panic("No provider request was sent"));
};

describe("case-law search expansion through the provider wire", () => {
  test.each(["google", "openrouter"] as const)(
    "%s answers with the task's default model",
    async (name) => {
      const answer = await expand(orgConfig(name));
      onlyRequest();
      expect(answer).toEqual(EXPANDED);
    },
  );

  test.each([
    ["google", "gemini-3.8-flash"],
    ["openrouter", "openai/gpt-6-luna"],
  ] as const)(
    "%s answers with an organization's own fast model (%s)",
    async (name, fastModelId) => {
      const answer = await expand(orgConfig(name, fastModelId));
      onlyRequest();
      expect(answer).toEqual(EXPANDED);
    },
  );

  test("a model that cannot stop reasoning still has room for the reply", async () => {
    // Gemini Flash reasons at its lowest level at the least, so the request
    // has to carry the reply's allowance above that reasoning.
    const answer = await expand(orgConfig("google"));
    const request = onlyRequest();
    expect(request.reasons).toBe(true);
    expect(request.ceiling).toBeGreaterThanOrEqual(
      REASONING_SPEND + ANSWER_TOKENS,
    );
    expect(answer).toEqual(EXPANDED);
  });

  test("an answer slower than a second and a half still arrives", async () => {
    provider.latencyMs = 2000;
    try {
      const answer = await expand(orgConfig("google"));
      expect(answer).toEqual(EXPANDED);
    } finally {
      provider.latencyMs = 0;
    }
  });

  test.each(["google", "openrouter"] as const)(
    "%s spending the whole ceiling on reasoning degrades the search",
    async (name) => {
      // The stand-in's failure is a real one: the run ends at `length` with
      // no reply, which the search reads as degraded, not as no expansion.
      provider.forceReasoningOnly = true;
      try {
        const answer = await expand(orgConfig(name));
        expect(answer).toEqual({ alternatives: [], outcome: "degraded" });
      } finally {
        provider.forceReasoningOnly = false;
      }
    },
  );
});
