import { panic, Result } from "better-result";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { env } from "@/api/env";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { decideMany } from "@/api/lib/workflow/decisions/decide";
import {
  hasInstanceDecisionModel,
  resolveDecisionModel,
} from "@/api/lib/workflow/decisions/decision-model";
import { noul, SystemOneError } from "@/api/lib/workflow/decisions/system-one";
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
  test("reports unavailable instance capability with a configured model", () => {
    expect(hasInstanceDecisionModel()).toBe(false);
    expect(resolveDecisionModel(null)?.keySource).toBe("instance");
  });

  test("returns a typed failure for an unavailable managed model", async () => {
    const client = resolveDecisionModel(null);
    if (client === null) {
      panic("Expected a configured decision model");
    }
    const asked = await client.ask({ state: "eligible", questions });
    expect(Result.isError(asked)).toBe(true);
    if (Result.isError(asked)) {
      expect(asked.error).toBeInstanceOf(SystemOneError);
      expect(asked.error).toMatchObject({
        kind: "invalid_request",
        status: 503,
      });
      expect(asked.error.message).toContain("Managed AI is not available");
      expect(asked.error.cause).toBeInstanceOf(HandlerError);
    }
    expect(runtime.fetch).not.toHaveBeenCalled();
  });

  test("records configured request failures as failed decisions", async () => {
    const result = await decideMany({
      id: "test.request-policy",
      orgAIConfig: null,
      state: "eligible",
      questions,
    });
    expect(result).toEqual({
      decisions: {
        eligible: { state: "undecided", reason: "failed", confidence: null },
      },
      model: null,
    });
    expect(runtime.analytics.exceptions()).toHaveLength(1);
    expect(runtime.fetch).not.toHaveBeenCalled();
  });

  test.each(["unconfigured", "personal-key-required"] as const)(
    "keeps %s instance resolution empty",
    (configuration) => {
      if (configuration === "unconfigured") {
        env.TYPESAFE_API_KEY = undefined;
      } else {
        env.REQUIRE_PERSONAL_AI_KEY = true;
      }
      expect(hasInstanceDecisionModel()).toBe(false);
      expect(resolveDecisionModel(null)).toBeNull();
    },
  );

  test("keeps organization decision requests unchanged", async () => {
    env.REQUIRE_PERSONAL_AI_KEY = true;
    const client = resolveDecisionModel(organization);
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
      body: JSON.stringify({ state: "eligible", model: "jev-test", questions }),
    });
  });
});
