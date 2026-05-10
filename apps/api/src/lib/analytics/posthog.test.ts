import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { ServerAnalyticsCaptureParams } from "@/api/lib/analytics/types";
import { SERVER_ANALYTICS_EVENTS } from "@/api/lib/analytics/types";

const clientCaptureMock = mock((_event: unknown) => undefined);
const clientFlushMock = mock(async () => undefined);

class MockPostHog {
  capture = clientCaptureMock;
  flush = clientFlushMock;
}

void mock.module("posthog-node", () => ({
  PostHog: MockPostHog,
}));

const { createPostHogAnalytics } = await import("./posthog");

describe("PostHog server analytics adapter", () => {
  beforeEach(() => {
    clientCaptureMock.mockClear();
    clientFlushMock.mockClear();
  });

  test("captures only explicitly allowed server telemetry events", () => {
    const analytics = createPostHogAnalytics(
      "phc_test",
      "https://posthog.test",
    );

    const exceptionListEntry = {
      mechanism: { handled: true, synthetic: false, type: "generic" },
      type: "HandlerError",
      value: "",
    } as const;

    analytics.capture({
      distinctId: "user_123",
      event: SERVER_ANALYTICS_EVENTS.exception,
      properties: {
        $exception_level: "error",
        $exception_list: [exceptionListEntry],
        $exception_type: "HandlerError",
        organization_id: "org_123",
      },
    });

    // eslint-disable-next-line typescript/no-unsafe-type-assertion -- Deliberately bypasses the public type to exercise the runtime guard.
    analytics.capture({
      distinctId: "user_123",
      event: "$autocapture",
      properties: { clicked: "secret-button" },
    } as unknown as ServerAnalyticsCaptureParams);

    expect(clientCaptureMock).toHaveBeenCalledTimes(1);
    expect(clientCaptureMock).toHaveBeenCalledWith({
      _originatedFromCaptureException: true,
      distinctId: "user_123",
      event: SERVER_ANALYTICS_EVENTS.exception,
      properties: {
        $exception_level: "error",
        $exception_list: [exceptionListEntry],
        $exception_type: "HandlerError",
        app_commit: "dev",
        app_version: "dev",
        organization_id: "org_123",
      },
    });
  });
});
