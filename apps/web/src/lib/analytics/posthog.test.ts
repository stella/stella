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
  person_profiles: string;
  rageclick: boolean;
};

let initOptions: PostHogInitOptions | null = null;
let distinctId = "anonymous";
let identified = false;

const captureMock = mock((_event: string, _properties?: unknown) => undefined);
const captureExceptionMock = mock((_error: unknown) => undefined);
const identifyMock = mock(
  (id: string, _properties?: Record<string, unknown>) => {
    distinctId = id;
    identified = true;
  },
);
const initMock = mock((_key: string, options: PostHogInitOptions) => {
  initOptions = options;
  return posthogMock;
});
const registerMock = mock((_properties: Record<string, unknown>) => undefined);
const getDistinctIdMock = mock(() => distinctId);
const isIdentifiedMock = mock(() => identified);
const resetMock = mock(() => {
  distinctId = "anonymous_after_reset";
  identified = false;
});

const posthogMock = {
  capture: captureMock,
  captureException: captureExceptionMock,
  get_distinct_id: getDistinctIdMock,
  identify: identifyMock,
  init: initMock,
  _isIdentified: isIdentifiedMock,
  register: registerMock,
  reset: resetMock,
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
    distinctId = "anonymous";
    identified = false;
    initOptions = null;
    captureMock.mockClear();
    captureExceptionMock.mockClear();
    getDistinctIdMock.mockClear();
    isIdentifiedMock.mockClear();
    identifyMock.mockClear();
    initMock.mockClear();
    registerMock.mockClear();
    resetMock.mockClear();
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
      person_profiles: "identified_only",
      rageclick: false,
    });
  });

  test("drops browser events outside the telemetry allowlist", () => {
    createPostHogAnalytics("phc_test", "https://posthog.test");

    expect(
      initOptions?.before_send({
        event: WEB_ANALYTICS_EVENTS.identify,
      }),
    ).toEqual({ event: WEB_ANALYTICS_EVENTS.identify });
    expect(
      initOptions?.before_send({
        event: WEB_ANALYTICS_EVENTS.pageViewed,
      }),
    ).toEqual({ event: WEB_ANALYTICS_EVENTS.pageViewed });
    expect(initOptions?.before_send({ event: "$autocapture" })).toBeNull();
    expect(initOptions?.before_send({ event: "$pageview" })).toBeNull();
    expect(initOptions?.before_send({ event: "$heatmap" })).toBeNull();
  });

  test("captures sanitized page view payloads", () => {
    const { analytics } = createPostHogAnalytics(
      "phc_test",
      "https://posthog.test",
    );

    analytics.capturePageViewed({
      href: "/cases?tab=active",
      path: "/cases",
    });

    expect(captureMock).toHaveBeenCalledWith(WEB_ANALYTICS_EVENTS.pageViewed, {
      href: "/cases?tab=active",
      path: "/cases",
    });
  });

  test("identifies users with optional person properties", () => {
    const { analytics } = createPostHogAnalytics(
      "phc_test",
      "https://posthog.test",
    );

    analytics.identifyUser({
      id: "user_123",
      email: "user@example.com",
      name: "Ada Lovelace",
    });

    expect(identifyMock).toHaveBeenCalledWith("user_123", {
      email: "user@example.com",
      name: "Ada Lovelace",
    });
  });

  test("passes missing identity properties through as undefined", () => {
    const { analytics } = createPostHogAnalytics(
      "phc_test",
      "https://posthog.test",
    );

    analytics.identifyUser({ id: "user_123" });

    expect(identifyMock).toHaveBeenCalledWith("user_123", {
      email: undefined,
      name: undefined,
    });
  });

  test("identifies the same user only once per browser app session", () => {
    const { analytics } = createPostHogAnalytics(
      "phc_test",
      "https://posthog.test",
    );

    analytics.identifyUser({ id: "user_123", email: "first@example.com" });
    analytics.identifyUser({ id: "user_123", email: "second@example.com" });

    expect(identifyMock).toHaveBeenCalledTimes(1);
    expect(resetMock).not.toHaveBeenCalled();
  });

  test("resets before identifying a different user", () => {
    const { analytics } = createPostHogAnalytics(
      "phc_test",
      "https://posthog.test",
    );

    analytics.identifyUser({ id: "user_123" });
    analytics.identifyUser({ id: "user_456" });

    expect(resetMock).toHaveBeenCalledTimes(1);
    expect(identifyMock).toHaveBeenNthCalledWith(2, "user_456", {
      email: undefined,
      name: undefined,
    });
  });

  test("reset can be limited to identified sessions", () => {
    const { analytics } = createPostHogAnalytics(
      "phc_test",
      "https://posthog.test",
    );

    analytics.reset({ onlyIfIdentified: true });

    expect(resetMock).not.toHaveBeenCalled();

    analytics.identifyUser({ id: "user_123" });
    analytics.reset({ onlyIfIdentified: true });

    expect(resetMock).toHaveBeenCalledTimes(1);
  });

  test("reset clears anonymous sessions by default", () => {
    const { analytics } = createPostHogAnalytics(
      "phc_test",
      "https://posthog.test",
    );

    analytics.reset();

    expect(resetMock).toHaveBeenCalledTimes(1);
  });

  test("reset clears the in-memory identity guard", () => {
    const { analytics } = createPostHogAnalytics(
      "phc_test",
      "https://posthog.test",
    );

    analytics.identifyUser({ id: "user_123" });
    analytics.reset();
    analytics.identifyUser({ id: "user_123" });

    expect(resetMock).toHaveBeenCalledTimes(1);
    expect(identifyMock).toHaveBeenCalledTimes(2);
  });
});
