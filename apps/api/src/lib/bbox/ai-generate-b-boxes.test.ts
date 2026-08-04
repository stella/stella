import { Result } from "better-result";
import { describe, expect, mock, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { WorkflowIntegrationError } from "@/api/lib/errors/tagged-errors";

const generateObjectMock = mock(async () => ({ boxes: [] as unknown[] }));
const captureErrorMock = mock((_error: unknown) => undefined);

void mock.module("@/api/lib/tanstack-ai-generate", () => ({
  generateTanStackObjectForRole: generateObjectMock,
}));

void mock.module("@/api/lib/analytics/tanstack-ai", () => ({
  createTanStackAIAnalyticsCallbacks: () => ({
    middleware: {},
    captureError: captureErrorMock,
  }),
}));

const { generateBBoxData } = await import("./ai-generate-b-boxes");

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
  });

describe("generateBBoxData", () => {
  test("reports a page with no matching content as an empty page", async () => {
    generateObjectMock.mockResolvedValueOnce({ boxes: [] });

    const result = await generate();

    expect(Result.isOk(result)).toBe(true);
    expect(Result.isOk(result) && result.value).toEqual([]);
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
});
