/**
 * Pins the failure path of `suggestTemplateFields`: a model-call failure
 * (BYOK misconfiguration, provider outage, timeout) must reject instead of
 * being swallowed into an empty list, so callers can distinguish "the model
 * found nothing" from "the call failed" (see the module doc comment on
 * suggest-template-fields.ts). Split into its own file — mock.module must run
 * before the module under test is first imported anywhere in this file's
 * module graph, and suggest-template-fields.test.ts already imports it
 * statically for the schema tests.
 */

import * as realTanStackAI from "@tanstack/ai";
import { afterAll, describe, expect, mock, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import * as realTanStackAIModels from "@/api/lib/tanstack-ai-models";

const FAILURE = new Error("provider unavailable");

const chat = (): Promise<never> => Promise.reject(FAILURE);

const testModel = {
  adapter: {},
  keySource: "instance",
  modelId: "test-model",
  modelOptions: {},
  provider: "openai",
};

void mock.module("@tanstack/ai", () => ({
  ...realTanStackAI,
  chat,
}));

void mock.module("@/api/lib/tanstack-ai-models", () => ({
  ...realTanStackAIModels,
  getTanStackTextModelForRole: () => testModel,
}));

const { suggestTemplateFields, suggestTemplateFieldsOrEmpty } =
  await import("./suggest-template-fields");
const { createTanStackAIAnalyticsCallbacks } =
  await import("@/api/lib/analytics/tanstack-ai");

afterAll(() => {
  mock.restore();
});

const organizationId = toSafeId<"organization">("org_test");

describe("suggestTemplateFields", () => {
  test("rejects (does not swallow to []) when the model call fails", async () => {
    // A no-op analytics sink: this test only pins that the helper itself
    // propagates the failure. Callers (suggest-fields.ts, prepare.ts,
    // template-tools.ts) are responsible for calling captureError.
    const aiAnalytics = createTanStackAIAnalyticsCallbacks({
      analytics: { capture: () => undefined, flush: async () => undefined },
      feature: "templates.test",
      traceId: "trace_test",
    });

    // .rejects.toThrow trips type-aware lint (bun-types declares it void) and
    // can report a spurious unhandled-rejection warning; capture explicitly.
    const rejection: unknown = await suggestTemplateFields({
      documentText: "Granted by ROKA NIERUCHOMOŚCI Sp. z o.o.",
      orgAIConfig: null,
      organizationId,
      aiAnalytics,
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toBe(FAILURE);
  });
});

describe("suggestTemplateFieldsOrEmpty", () => {
  test("degrades to [] and captures the failure instead of rejecting", async () => {
    const captured: unknown[] = [];
    const aiAnalytics = createTanStackAIAnalyticsCallbacks({
      analytics: {
        capture: (params) => {
          captured.push(params);
        },
        flush: async () => undefined,
      },
      feature: "templates.test",
      traceId: "trace_test",
    });

    const suggestions = await suggestTemplateFieldsOrEmpty({
      documentText: "Granted by ROKA NIERUCHOMOŚCI Sp. z o.o.",
      orgAIConfig: null,
      organizationId,
      aiAnalytics,
    });

    expect(suggestions).toEqual([]);
    expect(captured).toHaveLength(1);
  });
});
