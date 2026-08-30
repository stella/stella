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

import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import {
  suggestTemplateFields,
  suggestTemplateFieldsOrEmpty,
} from "@/api/lib/templates/suggest-template-fields";

const FAILURE = new Error("provider unavailable");

const { createTanStackAIAnalyticsCallbacks } =
  await import("@/api/lib/analytics/tanstack-ai");

const organizationId = toSafeId<"organization">("org_test");

describe("suggestTemplateFields", () => {
  test("rejects (does not swallow to []) when the model call fails", async () => {
    // A no-op analytics sink: this test only pins that the helper itself
    // propagates the failure. Callers (suggest-fields.ts, prepare.ts,
    // template-tools.ts) are responsible for calling captureError.
    const aiAnalytics = createTanStackAIAnalyticsCallbacks({
      analytics: {
        capture: () => undefined,
        flush: async () => undefined,
        identifyOrganizationGroup: () => undefined,
      },
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
      generateObjectForRole: async () => {
        throw FAILURE;
      },
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
        identifyOrganizationGroup: () => undefined,
      },
      feature: "templates.test",
      traceId: "trace_test",
    });

    const suggestions = await suggestTemplateFieldsOrEmpty({
      documentText: "Granted by ROKA NIERUCHOMOŚCI Sp. z o.o.",
      orgAIConfig: null,
      organizationId,
      aiAnalytics,
      generateObjectForRole: async () => {
        throw FAILURE;
      },
    });

    expect(suggestions).toEqual([]);
    // One standard $ai_generation failure record plus one internal failed
    // event; the point pinned here is that the failure was captured rather
    // than thrown.
    expect(captured).toHaveLength(2);
  });
});
