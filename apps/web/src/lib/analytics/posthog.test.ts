import { beforeEach, describe, expect, mock, test } from "bun:test";

import { INGESTION_REQUIRED_KEYS } from "@/lib/analytics/posthog-ingestion";
import { WEB_ANALYTICS_EVENTS } from "@/lib/analytics/types";

type CapturedBrowserEvent = {
  event: string;
  properties?: Record<string, unknown>;
};

type PostHogInitOptions = {
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
const captureExceptionMock = mock(
  (_error: unknown, _properties?: Record<string, unknown>) => undefined,
);
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
Object.defineProperty(globalThis, "__APP_COMMIT_SHA__", {
  configurable: true,
  value: "abc123",
});

void mock.module("posthog-js", () => ({
  posthog: posthogMock,
}));

const { createPostHogAnalytics } = await import("./posthog");
const { sanitizeRouteErrorLifecycleEvent } =
  await import("./posthog-route-error");

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

  test("drops known browser-noise exceptions", () => {
    createPostHogAnalytics("phc_test", "https://posthog.test");

    const noise = [
      "ResizeObserver loop completed with undelivered notifications.",
      "Script error.",
      "undefined",
      "Non-Error promise rejection captured with value: undefined",
    ];
    for (const value of noise) {
      expect(
        initOptions?.before_send({
          event: WEB_ANALYTICS_EVENTS.exception,
          properties: { $exception_list: [{ type: "Error", value }] },
        }),
      ).toBeNull();
    }
  });

  test("keeps actionable rejection types without their raw value", () => {
    createPostHogAnalytics("phc_test", "https://posthog.test");

    const event = {
      event: WEB_ANALYTICS_EVENTS.exception,
      properties: {
        $exception_list: [
          {
            type: "UnhandledRejection",
            value:
              "Non-Error promise rejection captured with value: API_TIMEOUT",
          },
        ],
      },
    };
    expect(initOptions?.before_send(event)).toEqual({
      event: WEB_ANALYTICS_EVENTS.exception,
      properties: {
        $exception_list: [{ type: "UnhandledRejection", value: "" }],
        $exception_type: "UnhandledRejection",
      },
    });
  });

  test("keeps real exception types and frames without messages", () => {
    createPostHogAnalytics("phc_test", "https://posthog.test");

    const event = {
      event: WEB_ANALYTICS_EVENTS.exception,
      properties: {
        $exception_list: [
          {
            type: "TypeError",
            value: "Cannot read properties of undefined (reading 'foo')",
            stacktrace: { frames: [{ filename: "app.js", lineno: 42 }] },
          },
        ],
      },
    };
    expect(initOptions?.before_send(event)).toEqual({
      event: WEB_ANALYTICS_EVENTS.exception,
      properties: {
        $exception_list: [
          {
            type: "TypeError",
            value: "",
            stacktrace: {
              type: "raw",
              frames: [{ filename: "app.js", lineno: 42 }],
            },
          },
        ],
        $exception_type: "TypeError",
      },
    });
  });

  test("keeps only structural stack frame fields", () => {
    createPostHogAnalytics("phc_test", "https://posthog.test");

    const sanitized = initOptions?.before_send({
      event: WEB_ANALYTICS_EVENTS.exception,
      properties: {
        $exception_list: [
          {
            type: "TypeError",
            value: "Client Smith v Example failed",
            stacktrace: {
              type: "raw",
              frames: [
                {
                  platform: "web:javascript",
                  filename:
                    "https://my.stll.app/assets/app.js?token=private-token",
                  function: "renderMatter",
                  in_app: true,
                  lineno: 42,
                  colno: 7,
                  context_line: "const title = matter.clientName;",
                  vars: { clientName: "Smith" },
                },
              ],
            },
          },
        ],
      },
    });

    expect(sanitized?.properties?.["$exception_list"]).toEqual([
      {
        type: "TypeError",
        value: "",
        stacktrace: {
          type: "raw",
          frames: [
            {
              platform: "web:javascript",
              filename: "https://my.stll.app/assets/app.js",
              function: "renderMatter",
              in_app: true,
              lineno: 42,
              colno: 7,
            },
          ],
        },
      },
    ]);
  });

  test("captureError ignores null and undefined", () => {
    const { analytics } = createPostHogAnalytics(
      "phc_test",
      "https://posthog.test",
    );
    analytics.captureError(null);
    analytics.captureError(undefined);
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  test("captureError sends the error type and a message-free stack", () => {
    const { analytics } = createPostHogAnalytics(
      "phc_test",
      "https://posthog.test",
    );
    analytics.captureError(
      new TypeError("Privileged document name and server payload"),
    );

    const captured = captureExceptionMock.mock.calls.at(-1)?.[0];
    expect(captured).toBeInstanceOf(Error);
    expect(captured).toMatchObject({ name: "TypeError", message: "" });
    if (!(captured instanceof Error)) {
      throw new TypeError("Expected a redacted Error");
    }
    expect(captured.stack).toStartWith("TypeError:\n");
    expect(captured.stack).not.toContain("Privileged document name");
    expect(captured.stack).toContain("    at ");
  });

  test("captureError survives a cyclic cause chain", () => {
    const { analytics } = createPostHogAnalytics(
      "phc_test",
      "https://posthog.test",
    );
    const first = new Error("Privileged first");
    const second = new Error("Privileged second", { cause: first });
    first.cause = second;
    analytics.captureError(second);
    expect(captureExceptionMock.mock.calls.at(-1)?.[0]).toBeInstanceOf(Error);
  });

  test("drops frame function names that are not symbol-shaped", () => {
    createPostHogAnalytics("phc_test", "https://posthog.test");
    const sanitized = initOptions?.before_send({
      event: WEB_ANALYTICS_EVENTS.exception,
      properties: {
        $exception_list: [
          {
            type: "TypeError",
            value: "boom",
            stacktrace: {
              frames: [
                { filename: "app.js", function: "Client Smith", lineno: 1 },
                { filename: "app.js", function: "renderMatter", lineno: 2 },
              ],
            },
          },
        ],
      },
    });

    expect(sanitized?.properties?.["$exception_list"]).toEqual([
      {
        type: "TypeError",
        value: "",
        stacktrace: {
          type: "raw",
          frames: [
            { filename: "app.js", lineno: 1 },
            { filename: "app.js", function: "renderMatter", lineno: 2 },
          ],
        },
      },
    ]);
  });

  test("captureError keeps the stack of the deepest cause", () => {
    const { analytics } = createPostHogAnalytics(
      "phc_test",
      "https://posthog.test",
    );
    const original = new RangeError("Privileged original message");
    const wrapper = new Error("Privileged wrapper message", {
      cause: original,
    });
    wrapper.name = "ClientTelemetryError";
    // Distinguishable stacks: the wrapper's own stack must not win.
    wrapper.stack = "Error: Privileged wrapper message\n    at boundary";
    original.stack =
      "RangeError: Privileged original message\n    at failureSite";
    analytics.captureError(wrapper);

    const captured = captureExceptionMock.mock.calls.at(-1)?.[0];
    if (!(captured instanceof Error)) {
      throw new TypeError("Expected a redacted Error");
    }
    expect(captured.name).toBe("ClientTelemetryError");
    expect(captured.stack).toBe("ClientTelemetryError:\n    at failureSite");
  });

  test("captureError attaches the telemetry area slug and nothing free-form", () => {
    const { analytics } = createPostHogAnalytics(
      "phc_test",
      "https://posthog.test",
    );
    const boundaryError = new Error("Privileged message");
    Object.assign(boundaryError, { area: "pdf-viewer" });
    analytics.captureError(boundaryError);
    expect(captureExceptionMock.mock.calls.at(-1)?.[1]).toEqual({
      area: "pdf-viewer",
    });

    const freeFormError = new Error("Privileged message");
    Object.assign(freeFormError, { area: "Client Smith v Example" });
    analytics.captureError(freeFormError);
    expect(captureExceptionMock.mock.calls.at(-1)?.[1]).toEqual({});
  });

  test("sanitizer keeps only slug-shaped area properties", () => {
    createPostHogAnalytics("phc_test", "https://posthog.test");

    const sanitizedSlug = initOptions?.before_send({
      event: WEB_ANALYTICS_EVENTS.exception,
      properties: {
        area: "pdf-viewer",
        $exception_list: [{ type: "Error", value: "boom" }],
      },
    });
    expect(sanitizedSlug?.properties?.["area"]).toBe("pdf-viewer");

    const sanitizedFreeForm = initOptions?.before_send({
      event: WEB_ANALYTICS_EVENTS.exception,
      properties: {
        area: "Client Smith v Example",
        $exception_list: [{ type: "Error", value: "boom" }],
      },
    });
    expect(sanitizedFreeForm?.properties).not.toContainKey("area");
  });

  test("captureError correlates a recovery reference without error details", () => {
    const { analytics } = createPostHogAnalytics(
      "phc_test",
      "https://posthog.test",
    );
    analytics.captureError(new TypeError("Privileged document name"), {
      type: "recovery",
      reference: "ERR-DEAD-BEEF-1234",
    });

    expect(captureExceptionMock.mock.calls.at(-1)?.[1]).toEqual({
      error_reference: "ERR-DEAD-BEEF-1234",
    });
  });

  test("captures and sanitizes route crash lifecycle properties", async () => {
    const { analytics } = createPostHogAnalytics(
      "phc_test",
      "https://posthog.test",
    );
    await analytics.captureRouteErrorLifecycle({
      errorFingerprint: "ERRFP-1234ABCD",
      incidentReference: "ERR-DEAD-BEEF-1234",
      inspectorState: "open",
      recovery: "retry-route",
      reference: "ERR-DEAD-BEEF-1234",
      routeTemplate: "/law/$country/cases/$court/$slug",
      status: "recurred",
    });
    expect(captureMock).toHaveBeenCalledWith(
      WEB_ANALYTICS_EVENTS.routeErrorRecovery,
      {
        error_reference: "ERR-DEAD-BEEF-1234",
        error_fingerprint: "ERRFP-1234ABCD",
        incident_reference: "ERR-DEAD-BEEF-1234",
        inspector_state: "open",
        recovery: "retry-route",
        route_template: "/law/$country/cases/$court/$slug",
        status: "recurred",
      },
    );

    expect(
      initOptions?.before_send({
        event: WEB_ANALYTICS_EVENTS.routeErrorRecovery,
        properties: {
          $current_url:
            "https://staging.stll.app/workspaces/private-matter?document=secret#selection",
          error_reference: "ERR-DEAD-BEEF-1234",
          error_fingerprint: "ERRFP-1234ABCD",
          incident_reference: "ERR-DEAD-BEEF-1234",
          inspector_state: "open",
          privileged_content: "never retain me",
          recovery: "retry-route",
          route_template: "/law/$country/cases/$court/$slug",
          status: "shown",
        },
      }),
    ).toEqual({
      event: WEB_ANALYTICS_EVENTS.routeErrorRecovery,
      properties: {
        error_reference: "ERR-DEAD-BEEF-1234",
        error_fingerprint: "ERRFP-1234ABCD",
        incident_reference: "ERR-DEAD-BEEF-1234",
        inspector_state: "open",
        recovery: "retry-route",
        route_template: "/law/$country/cases/$court/$slug",
        status: "shown",
      },
    });
    expect(
      initOptions?.before_send({
        event: WEB_ANALYTICS_EVENTS.routeErrorRecovery,
        properties: { route_template: "/workspaces/private matter" },
      }),
    ).toBeNull();
  });

  test("keeps only crash diagnostics from an SDK-enriched lifecycle event", () => {
    createPostHogAnalytics("phc_test", "https://posthog.test");

    expect(
      sanitizeRouteErrorLifecycleEvent({
        event: WEB_ANALYTICS_EVENTS.routeErrorRecovery,
        properties: {
          $current_url:
            "https://staging.stll.app/workspaces/private-matter?document=secret#selection",
          distinct_id: "user_123",
          $pathname: "/workspaces/private-matter",
          $referrer: "https://mail.example.test/client-name",
          $raw_user_agent: "private browser fingerprint",
          $session_id: "018f9f0e-7b42-7cc8-9a5d-42db46f6842d",
          app_commit: "abc123",
          app_version: "test",
          document_title: "Client Smith v Example",
          error_reference: "ERR-FEED-FACE-5678",
          error_fingerprint: "ERRFP-1234ABCD",
          incident_reference: "ERR-DEAD-BEEF-1234",
          inspector_state: "minimized",
          privileged_content: "never retain me",
          recovery: "retry-route",
          route_template: "/law/$country/cases/$court/$slug",
          status: "recurred",
        },
        uuid: "enriched-route-error-event",
      }),
    ).toEqual({
      event: WEB_ANALYTICS_EVENTS.routeErrorRecovery,
      properties: {
        distinct_id: "user_123",
        $session_id: "018f9f0e-7b42-7cc8-9a5d-42db46f6842d",
        app_commit: "abc123",
        app_version: "test",
        error_reference: "ERR-FEED-FACE-5678",
        error_fingerprint: "ERRFP-1234ABCD",
        incident_reference: "ERR-DEAD-BEEF-1234",
        inspector_state: "minimized",
        recovery: "retry-route",
        route_template: "/law/$country/cases/$court/$slug",
        status: "recurred",
      },
      uuid: "enriched-route-error-event",
    });
  });

  test("drops malformed crash diagnostics", () => {
    createPostHogAnalytics("phc_test", "https://posthog.test");

    expect(
      sanitizeRouteErrorLifecycleEvent({
        event: WEB_ANALYTICS_EVENTS.routeErrorRecovery,
        properties: {
          error_reference: "ERR-DEAD-BEEF-1234",
          error_fingerprint: "ERRFP-1234ABCD",
          incident_reference: "ERR-DEAD-BEEF-1234",
          inspector_state: "open",
          recovery: "retry-route",
          route_template: "/workspaces/private matter",
          status: "shown",
        },
        uuid: "malformed-route-error-event",
      }),
    ).toBeNull();
  });

  test("before_send strips exception messages and envelope noise", () => {
    createPostHogAnalytics("phc_test", "https://posthog.test");
    const sanitized = initOptions?.before_send({
      event: WEB_ANALYTICS_EVENTS.exception,
      properties: {
        token: "phc_test",
        distinct_id: "018f9f0e-7b42-7cc8-9a5d-42db46f6842d",
        $current_url: "https://my.stll.app/workspaces/private-matter#selection",
        $exception_list: [
          {
            type: "TypeError",
            value: "Privileged document name",
            stacktrace: {
              frames: [{ filename: "https://my.stll.app/assets/app.js" }],
            },
          },
        ],
      },
    });

    expect(sanitized).toEqual({
      event: WEB_ANALYTICS_EVENTS.exception,
      properties: {
        token: "phc_test",
        distinct_id: "018f9f0e-7b42-7cc8-9a5d-42db46f6842d",
        $exception_list: [
          {
            type: "TypeError",
            value: "",
            stacktrace: {
              type: "raw",
              frames: [{ filename: "https://my.stll.app/assets/app.js" }],
            },
          },
        ],
        $exception_type: "TypeError",
      },
    });
  });

  // posthog-js drops any event whose ingestion-required property was
  // removed by `before_send`, so a sanitizer stripping one of these keys
  // silently disables the whole telemetry stream. Assert both directions:
  // every declared key survives both sanitizers, and nothing else from the
  // envelope leaks through the exception sanitizer.
  test("sanitizers preserve every posthog ingestion-required property", () => {
    createPostHogAnalytics("phc_test", "https://posthog.test");
    // Independent restatement of the posthog-js contract (its
    // properties-required-for-ingestion set). If `INGESTION_REQUIRED_KEYS`
    // drifts from this literal, the guard fails instead of mirroring the
    // mistake.
    const requiredBySdk = ["token", "distinct_id", "$cookieless_mode"];
    expect(requiredBySdk).toEqual([...INGESTION_REQUIRED_KEYS]);
    const envelope = {
      token: "phc_test",
      distinct_id: "018f9f0e-7b42-7cc8-9a5d-42db46f6842d",
      $cookieless_mode: true,
      $session_id: "018f9f0e-7b42-7cc8-9a5d-42db46f6842d",
      $lib: "web",
      $current_url: "https://my.stll.app/workspaces/private-matter",
    };

    const exception = initOptions?.before_send({
      event: WEB_ANALYTICS_EVENTS.exception,
      properties: {
        ...envelope,
        $exception_list: [{ type: "TypeError", value: "Private matter" }],
      },
    });
    for (const key of INGESTION_REQUIRED_KEYS) {
      expect(exception?.properties?.[key]).toEqual(envelope[key]);
    }
    expect(exception?.properties).not.toContainKeys([
      "$session_id",
      "$lib",
      "$current_url",
    ]);

    const routeError = sanitizeRouteErrorLifecycleEvent({
      event: WEB_ANALYTICS_EVENTS.routeErrorRecovery,
      properties: {
        ...envelope,
        error_reference: "ERR-DEAD-BEEF-1234",
        error_fingerprint: "ERRFP-1234ABCD",
        incident_reference: "ERR-DEAD-BEEF-1234",
        inspector_state: "open",
        recovery: "retry-route",
        route_template: "/law/$country/cases/$court/$slug",
        status: "shown",
      },
      uuid: "route-error-envelope-event",
    });
    for (const key of INGESTION_REQUIRED_KEYS) {
      expect(routeError?.properties[key]).toEqual(envelope[key]);
    }
  });

  test("before_send keeps only valid opaque recovery references", () => {
    createPostHogAnalytics("phc_test", "https://posthog.test");
    const sanitized = initOptions?.before_send({
      event: WEB_ANALYTICS_EVENTS.exception,
      properties: {
        error_reference: "ERR-DEAD-BEEF-1234",
        route: "/workspaces/private-matter",
        $exception_list: [{ type: "TypeError", value: "Private matter" }],
      },
    });

    expect(sanitized).toEqual({
      event: WEB_ANALYTICS_EVENTS.exception,
      properties: {
        error_reference: "ERR-DEAD-BEEF-1234",
        $exception_list: [{ type: "TypeError", value: "" }],
        $exception_type: "TypeError",
      },
    });

    const rejected = initOptions?.before_send({
      event: WEB_ANALYTICS_EVENTS.exception,
      properties: {
        error_reference: "/workspaces/private-matter",
        $exception_list: [{ type: "TypeError", value: "Private matter" }],
      },
    });
    expect(rejected).toEqual({
      event: WEB_ANALYTICS_EVENTS.exception,
      properties: {
        $exception_list: [{ type: "TypeError", value: "" }],
        $exception_type: "TypeError",
      },
    });
  });

  test("captures sanitized page view payloads", () => {
    const { analytics } = createPostHogAnalytics(
      "phc_test",
      "https://posthog.test",
    );

    analytics.capturePageViewed({
      path: "/cases",
    });

    expect(captureMock).toHaveBeenCalledWith(WEB_ANALYTICS_EVENTS.pageViewed, {
      path: "/cases",
    });
  });

  test("identifies users by stable id without person properties", () => {
    const { analytics } = createPostHogAnalytics(
      "phc_test",
      "https://posthog.test",
    );

    analytics.identifyUser({ id: "user_123" });

    expect(identifyMock).toHaveBeenCalledWith("user_123");
  });

  test("identifies the same user only once per browser app session", () => {
    const { analytics } = createPostHogAnalytics(
      "phc_test",
      "https://posthog.test",
    );

    analytics.identifyUser({ id: "user_123" });
    analytics.identifyUser({ id: "user_123" });

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
    expect(identifyMock).toHaveBeenNthCalledWith(2, "user_456");
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
