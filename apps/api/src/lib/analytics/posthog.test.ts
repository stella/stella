import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { ServerAnalyticsCaptureParams } from "@/api/lib/analytics/types";
import { SERVER_ANALYTICS_EVENTS } from "@/api/lib/analytics/types";
import { toSafeId } from "@/api/lib/branded-types";

const clientCaptureMock = mock((_event: unknown) => undefined);
const clientGroupIdentifyMock = mock((_params: unknown) => undefined);
const clientFlushMock = mock(async () => undefined);

class MockPostHog {
  capture = clientCaptureMock;
  groupIdentify = clientGroupIdentifyMock;
  flush = clientFlushMock;
}

void mock.module("posthog-node", () => ({
  PostHog: MockPostHog,
}));

const { createPostHogAnalytics } = await import("./posthog");

describe("PostHog server analytics adapter", () => {
  beforeEach(() => {
    clientCaptureMock.mockClear();
    clientGroupIdentifyMock.mockClear();
    clientFlushMock.mockClear();
  });

  test("upserts the organization group under the shared group type", () => {
    const analytics = createPostHogAnalytics(
      "phc_test",
      "https://posthog.test",
    );
    const organizationId = toSafeId<"organization">(
      "3f6e0a7e-9f6f-4a53-9a3e-2b8f6f0c9d41",
    );

    analytics.identifyOrganizationGroup({
      organizationId,
      properties: { name: "Acme Legal" },
    });

    // `organization` must equal the browser adapter's group type; the id is
    // the group key so client and server events land on one profile.
    expect(clientGroupIdentifyMock).toHaveBeenCalledWith({
      groupType: "organization",
      groupKey: organizationId,
      properties: { name: "Acme Legal" },
    });
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
