import { panic, Result } from "better-result";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";

import { env } from "@/api/env";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { decideMany } from "@/api/lib/workflow/decisions/decide";
import {
  hasInstanceDecisionModel,
  probeDecisionModel,
  resolveDecisionModel,
} from "@/api/lib/workflow/decisions/decision-model";
import { noul } from "@/api/lib/workflow/decisions/system-one";
import {
  installRecordingAnalytics,
  installRecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";

const original = {
  requirePersonalKey: env.REQUIRE_PERSONAL_AI_KEY,
  apiKey: env.TYPESAFE_API_KEY,
  model: env.TYPESAFE_MODEL,
};
const questions = { eligible: noul("Is the applicant eligible?") };
const organization = {
  providers: [],
  overrideModels: {
    fast: { provider: "openai", modelId: "test-model" },
    chat: { provider: "openai", modelId: "test-model" },
    reasoning: { provider: "openai", modelId: "test-model" },
    pdf: { provider: "openai", modelId: "test-model" },
  },
  decision: {
    provider: "typesafe",
    apiKey: "test-organization-key",
    modelId: "jev-test",
  },
} as const satisfies OrgAIConfig;

const createRequestSpy = () =>
  spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async () =>
        new Response(
          JSON.stringify({
            model: "jev-test",
            answers: { eligible: { type: "noul", noul: 0.99 } },
            usage: { input_tokens: 10, output_tokens: 1 },
          }),
          { headers: { "content-type": "application/json" } },
        ),
      { preconnect: globalThis.fetch.preconnect },
    ),
  );

let fetch: ReturnType<typeof createRequestSpy>;

const setup = () => ({
  analytics: installRecordingAnalytics(),
  logger: installRecordingLogger(),
  fetch,
});

beforeAll(() => {
  fetch = createRequestSpy();
});

afterAll(() => {
  fetch.mockRestore();
});

let runtime: ReturnType<typeof setup>;

beforeEach(() => {
  fetch.mockClear();
  env.REQUIRE_PERSONAL_AI_KEY = false;
  env.TYPESAFE_API_KEY = "test-instance-key";
  env.TYPESAFE_MODEL = "jev-test";
  runtime = setup();
});

afterEach(() => {
  runtime.analytics.restore();
  runtime.logger.restore();
  env.REQUIRE_PERSONAL_AI_KEY = original.requirePersonalKey;
  env.TYPESAFE_API_KEY = original.apiKey;
  env.TYPESAFE_MODEL = original.model;
});

describe("decision model request policy", () => {
  test("reports capability according to the required data class", () => {
    expect(hasInstanceDecisionModel("customer")).toBe(false);
    expect(resolveDecisionModel(null, "customer")).toBeNull();
    expect(hasInstanceDecisionModel("public_corpus")).toBe(true);
    expect(resolveDecisionModel(null, "public_corpus")?.keySource).toBe(
      "instance",
    );
  });

  test("keeps unavailable decisions empty without telemetry", async () => {
    const result = await decideMany({
      id: "test.request-policy",
      orgAIConfig: null,
      dataClass: "customer",
      state: "eligible",
      questions,
    });
    expect(result).toEqual({
      decisions: {
        eligible: {
          state: "undecided",
          reason: "no-backend",
          confidence: null,
        },
      },
      model: null,
    });
    expect(runtime.analytics.exceptions()).toHaveLength(0);
    expect(runtime.logger.records).toHaveLength(0);
    expect(runtime.fetch).not.toHaveBeenCalled();
  });

  test("keeps public-corpus instance requests unchanged", async () => {
    const client = resolveDecisionModel(null, "public_corpus");
    if (client === null) {
      panic("Expected a configured decision model");
    }
    const asked = await client.ask({ state: "eligible", questions });
    expect(Result.isOk(asked)).toBe(true);
    expect(runtime.fetch).toHaveBeenCalledTimes(1);
    const call = runtime.fetch.mock.calls.at(0);
    expect(call?.at(0)).toBe("https://api.typesafe.ai/v1/systemone");
    expect(call?.at(1)).toMatchObject({
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-instance-key",
      },
      body: JSON.stringify({ state: "eligible", model: "jev-test", questions }),
    });
  });

  test.each(["unconfigured", "personal-key-required"] as const)(
    "keeps %s instance resolution empty",
    (configuration) => {
      if (configuration === "unconfigured") {
        env.TYPESAFE_API_KEY = undefined;
      } else {
        env.REQUIRE_PERSONAL_AI_KEY = true;
      }
      for (const dataClass of ["customer", "public_corpus"] as const) {
        expect(hasInstanceDecisionModel(dataClass)).toBe(false);
        expect(resolveDecisionModel(null, dataClass)).toBeNull();
      }
    },
  );

  test.each(["customer", "public_corpus"] as const)(
    "keeps %s organization requests unchanged",
    async (dataClass) => {
      env.REQUIRE_PERSONAL_AI_KEY = true;
      const client = resolveDecisionModel(organization, dataClass);
      if (client === null) {
        panic("Expected an organization decision model");
      }
      expect(client.keySource).toBe("byok");
      const asked = await client.ask({ state: "eligible", questions });
      expect(Result.isOk(asked)).toBe(true);
      expect(runtime.fetch).toHaveBeenCalledTimes(1);
      const call = runtime.fetch.mock.calls.at(0);
      expect(call?.at(0)).toBe("https://api.typesafe.ai/v1/systemone");
      expect(call?.at(1)).toMatchObject({
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-organization-key",
        },
        body: JSON.stringify({
          state: "eligible",
          model: "jev-test",
          questions,
        }),
      });
    },
  );
});

describe("OpenAI decision credentials", () => {
  test.each(["customer", "public_corpus"] as const)(
    "missing reused credentials fall back for %s and report one config defect",
    async (dataClass) => {
      const config = {
        ...organization,
        providers: [{ provider: "anthropic", apiKey: "other-key" }],
        decision: {
          provider: "openai",
          modelId: "gpt-6-luna",
          region: "eu",
        },
      } as const satisfies OrgAIConfig;
      expect(resolveDecisionModel(config, dataClass)).toBeNull();
      const result = await decideMany({
        id: "test.missing-decision-key",
        orgAIConfig: config,
        dataClass,
        state: "eligible",
        questions,
      });
      expect(result).toEqual({
        decisions: {
          eligible: {
            state: "undecided",
            reason: "no-backend",
            confidence: null,
          },
        },
        model: null,
      });
      expect(runtime.analytics.exceptions()).toHaveLength(1);
      expect(runtime.analytics.exceptions().at(0)?.properties).toMatchObject({
        "error.class": "ConfigurationError",
        source: "resolveDecisionModel",
        "failure.grade": "defect",
      });
      expect(runtime.fetch).not.toHaveBeenCalled();
    },
  );

  test.each([undefined, "separate-key"])(
    "uses the org OpenAI key unless overridden (%s)",
    async (override) => {
      runtime.fetch.mockImplementation(
        Object.assign(
          async () =>
            Response.json({
              model: "gpt-6-luna",
              answers: [
                { type: "predicate", name: "eligible", probability: 0.99 },
              ],
              usage: { input_tokens: 42, output_tokens: 0 },
            }),
          { preconnect: globalThis.fetch.preconnect },
        ),
      );
      const client = resolveDecisionModel(
        {
          ...organization,
          providers: [
            { provider: "anthropic", apiKey: "other-key" },
            { provider: "openai", apiKey: "generative-key" },
          ],
          decision: {
            provider: "openai",
            apiKey: override,
            modelId: "gpt-6-luna",
            region: "eu",
          },
        },
        "customer",
      );
      if (client === null) {
        panic("Expected org decision client");
      }
      const result = await client.ask({ state: "eligible", questions });
      expect(Result.isOk(result)).toBe(true);
      expect(client).toMatchObject({
        provider: "openai",
        region: "eu",
        keySource: "byok",
      });
      const request = runtime.fetch.mock.calls.at(-1)?.[1];
      expect(request?.headers).toMatchObject({
        authorization: `Bearer ${override ?? "generative-key"}`,
      });
    },
  );

  test.each([200, 401, 403, 400, 500])(
    "probes candidates over an injected fetch for HTTP %s",
    async (status) => {
      const { createOpenAIDecisionsClient } =
        await import("./openai-decisions");
      let calls = 0;
      const result = await probeDecisionModel({
        config: {
          provider: "openai",
          apiKey: "candidate-key",
          modelId: "gpt-6-luna",
          region: "eu",
        },
        timeoutMs: 1000,
        createClient: (config) =>
          createOpenAIDecisionsClient({
            apiKey: config.apiKey,
            fetcher: async (_url, init) => {
              calls += 1;
              expect(init?.headers).toMatchObject({
                authorization: "Bearer candidate-key",
              });
              return status === 200
                ? Response.json({
                    model: "gpt-6-luna",
                    answers: [
                      { type: "predicate", name: "probe", probability: 1 },
                    ],
                    usage: { input_tokens: 2, output_tokens: 0 },
                  })
                : new Response("failure", { status });
            },
          }),
      });
      expect(calls).toBe(1);
      expect(result).toEqual(
        status === 200
          ? { valid: true }
          : {
              valid: false,
              error:
                status === 401 || status === 403
                  ? "The decision model rejected the API key"
                  : `OpenAI Decisions responded with HTTP ${String(status)}`,
            },
      );
    },
  );
});
