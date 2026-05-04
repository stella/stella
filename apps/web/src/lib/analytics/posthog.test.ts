import { beforeEach, describe, expect, mock, test } from "bun:test";

import { WEB_ANALYTICS_EVENTS } from "@/lib/analytics/types";

type CapturedBrowserEvent = {
  event: string;
  properties?: Record<string, unknown>;
};

type PostHogInitOptions = {
  advanced_disable_decide: boolean;
  advanced_disable_feature_flags: boolean;
  advanced_disable_flags: boolean;
  autocapture: boolean;
  before_send: (
    event: CapturedBrowserEvent | null,
  ) => CapturedBrowserEvent | null;
  capture_dead_clicks: boolean;
  capture_heatmaps: boolean;
  capture_pageview: boolean;
  capture_performance: boolean;
  disable_persistence: boolean;
  disable_session_recording: boolean;
  mask_all_text: boolean;
  mask_personal_data_properties: boolean;
  opt_out_capturing_by_default: boolean;
  rageclick: boolean;
};

let initOptions: PostHogInitOptions | null = null;

const captureMock = mock((_event: string, _properties?: unknown) => undefined);
const captureExceptionMock = mock((_error: unknown) => undefined);
const initMock = mock((_key: string, options: PostHogInitOptions) => {
  initOptions = options;
  return posthogMock;
});
const registerMock = mock((_properties: Record<string, unknown>) => undefined);

const posthogMock = {
  capture: captureMock,
  captureException: captureExceptionMock,
  init: initMock,
  register: registerMock,
};

Object.defineProperty(globalThis, "__APP_VERSION__", {
  configurable: true,
  value: "test",
});

void mock.module("@/env", () => ({
  env: {
    VITE_POSTHOG_LOCAL_DEBUG: true,
  },
}));

void mock.module("posthog-js", () => ({
  posthog: posthogMock,
}));

const { createPostHogAnalytics } = await import("./posthog");

describe("PostHog browser analytics adapter", () => {
  beforeEach(() => {
    initOptions = null;
    captureMock.mockClear();
    captureExceptionMock.mockClear();
    initMock.mockClear();
    registerMock.mockClear();
  });

  test("structurally disables interaction tracking features", () => {
    createPostHogAnalytics("phc_test", "https://posthog.test");

    expect(initOptions).toMatchObject({
      advanced_disable_decide: true,
      advanced_disable_feature_flags: true,
      advanced_disable_flags: true,
      autocapture: false,
      capture_dead_clicks: false,
      capture_heatmaps: false,
      capture_pageview: false,
      capture_performance: false,
      disable_persistence: true,
      disable_session_recording: true,
      mask_all_text: true,
      mask_personal_data_properties: true,
      rageclick: false,
    });
  });

  test("drops browser events outside the telemetry allowlist", () => {
    createPostHogAnalytics("phc_test", "https://posthog.test");

    expect(
      initOptions?.before_send({
        event: WEB_ANALYTICS_EVENTS.pageViewed,
      }),
    ).toEqual({ event: WEB_ANALYTICS_EVENTS.pageViewed });
    expect(initOptions?.before_send({ event: "$autocapture" })).toBeNull();
    expect(initOptions?.before_send({ event: "$pageview" })).toBeNull();
    expect(initOptions?.before_send({ event: "$heatmap" })).toBeNull();
  });

  test("captures only sanitized page telemetry payloads", () => {
    const { analytics } = createPostHogAnalytics(
      "phc_test",
      "https://posthog.test",
    );

    analytics.capturePageViewed({ routeId: "/cases/$caseId" });
    analytics.capturePagePerformance({
      loadBucket: "500_1000",
      routeId: "/cases/$caseId",
    });

    expect(captureMock).toHaveBeenCalledWith(WEB_ANALYTICS_EVENTS.pageViewed, {
      route_id: "/cases/$caseId",
    });
    expect(captureMock).toHaveBeenCalledWith(
      WEB_ANALYTICS_EVENTS.pagePerformance,
      {
        load_bucket: "500_1000",
        route_id: "/cases/$caseId",
      },
    );
  });
});
