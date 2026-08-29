import { Result } from "better-result";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { SERVER_ANALYTICS_EVENTS } from "@/api/lib/analytics/types";
import { toSafeId } from "@/api/lib/branded-types";
import { WorkflowIntegrationError } from "@/api/lib/errors/tagged-errors";
import type { generateTanStackObjectForRole } from "@/api/lib/tanstack-ai-generate";
import {
  installRecordingAnalytics,
  installRecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";
import type {
  RecordingAnalytics,
  RecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";

import { generateBBoxData } from "./ai-generate-b-boxes";

const generateObjectMock = mock(async () => ({ boxes: [] as unknown[] }));
// SAFETY: This suite only dispatches the bbox schema and configures outputs
// matching that schema; Bun's mock type cannot express the generic schema tie.
const generateObjectForTest =
  generateObjectMock as typeof generateTanStackObjectForRole;

const generate = async () =>
  await generateBBoxData({
    pdfData: new Uint8Array([1, 2, 3]),
    prompt: "Which court decided this?",
    fieldContent: "Nejvyšší soud",
    justificationText: "The decision names the deciding court.",
    abortSignal: AbortSignal.timeout(1000),
    justificationId: "justification_test",
    organizationId: toSafeId<"organization">("org_test"),
    pageNumber: 1,
    workspaceId: toSafeId<"workspace">("ws_test"),
    orgAIConfig: null,
    promptCachingEnabled: false,
    generateObjectForRole: generateObjectForTest,
  });

describe("generateBBoxData", () => {
  let analytics: RecordingAnalytics;
  let logs: RecordingLogger;

  beforeEach(() => {
    analytics = installRecordingAnalytics();
    logs = installRecordingLogger();
  });

  afterEach(() => {
    analytics.restore();
    logs.restore();
  });

  test("reports a page with no matching content as an empty page", async () => {
    generateObjectMock.mockResolvedValueOnce({ boxes: [] });

    const result = await generate();

    expect(Result.isOk(result)).toBe(true);
    expect(Result.isOk(result) && result.value).toEqual([]);
    expect(analytics.exceptions()).toEqual([]);
  });

  test("carries the provider failure on the error's cause", async () => {
    const providerFailure = new Error("provider rejected the request");
    generateObjectMock.mockRejectedValueOnce(providerFailure);

    const result = await generate();

    expect(Result.isError(result)).toBe(true);
    expect(
      Result.isError(result) && WorkflowIntegrationError.is(result.error),
    ).toBe(true);
    expect(Result.isError(result) && result.error.cause).toBe(providerFailure);
  });

  test("reports the provider failure as a bbox generation failure", async () => {
    generateObjectMock.mockRejectedValueOnce(
      new Error("provider rejected the request"),
    );

    await generate();

    expect(
      analytics.events
        .filter(
          (event) => event.event === SERVER_ANALYTICS_EVENTS.aiGenerationFailed,
        )
        .map((event) => event.properties),
    ).toMatchObject([{ failure_reason: "provider", feature: "bbox.generate" }]);
    expect(
      analytics.exceptions().map((event) => event.properties),
    ).toMatchObject([{ "error.class": "Error", feature: "bbox.generate" }]);
  });
});
