import { panic, Result } from "better-result";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { env } from "@/api/env";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { decideMany } from "@/api/lib/workflow/decisions/decide";
import {
  hasInstanceDecisionModel,
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

const setup = () => ({
  analytics: installRecordingAnalytics(),
  logger: installRecordingLogger(),
  fetch: spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        model: "jev-test",
        answers: { eligible: { type: "noul", noul: 0.99 } },
        usage: { input_tokens: 10, output_tokens: 1 },
      }),
      { headers: { "content-type": "application/json" } },
    ),
  ),
});

let runtime: ReturnType<typeof setup>;

beforeEach(() => {
  env.REQUIRE_PERSONAL_AI_KEY = false;
  env.TYPESAFE_API_KEY = "test-instance-key";
  env.TYPESAFE_MODEL = "jev-test";
  runtime = setup();
});

afterEach(() => {
  runtime.fetch.mockRestore();
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
