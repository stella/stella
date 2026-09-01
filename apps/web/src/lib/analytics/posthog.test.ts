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
  capture_pageleave: boolean;
  capture_pageview: boolean;
  capture_performance:
    | boolean
    | { network_timing: boolean; web_vitals: boolean };
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
const groupMock = mock((_type: string, _key: string) => undefined);

const posthogMock = {
  capture: captureMock,
  captureException: captureExceptionMock,
  get_distinct_id: getDistinctIdMock,
  group: groupMock,
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
const { redactTelemetryStack } = await import("./stack-redaction");
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
    groupMock.mockClear();
  });

  test("structurally disables interaction tracking features", () => {
    createPostHogAnalytics({ host: "https://posthog.test", key: "phc_test" });

    expect(initOptions).toMatchObject({
      advanced_disable_feature_flags: true,
      advanced_disable_flags: true,
      autocapture: false,
      capture_dead_clicks: false,
      capture_heatmaps: false,
      capture_pageleave: true,
      capture_pageview: false,
      capture_performance: { network_timing: false, web_vitals: true },
      disable_persistence: true,
      disable_session_recording: true,
      mask_all_text: true,
      mask_personal_data_properties: true,
      person_profiles: "identified_only",
      rageclick: false,
    });
  });

  test("points UI links at the PostHog origin when ingesting via a proxy", () => {
    createPostHogAnalytics({
      host: "https://e.example.test",
      key: "phc_test",
      uiHost: "https://eu.posthog.com",
    });

    expect(initOptions).toMatchObject({
      api_host: "https://e.example.test",
      ui_host: "https://eu.posthog.com",
    });
  });

  test("derives UI links from the api host when no proxy is configured", () => {
    createPostHogAnalytics({ host: "https://posthog.test", key: "phc_test" });

    expect(initOptions).not.toHaveProperty("ui_host");
  });

  test("drops browser events outside the telemetry allowlist", () => {
    createPostHogAnalytics({ host: "https://posthog.test", key: "phc_test" });

    expect(
      initOptions?.before_send({
        event: WEB_ANALYTICS_EVENTS.identify,
      }),
    ).toEqual({ event: WEB_ANALYTICS_EVENTS.identify, properties: {} });
    expect(
      initOptions?.before_send({
        event: WEB_ANALYTICS_EVENTS.pageViewed,
      }),
    ).toEqual({ event: WEB_ANALYTICS_EVENTS.pageViewed, properties: {} });
    expect(
      initOptions?.before_send({
        event: WEB_ANALYTICS_EVENTS.pageLeft,
      }),
    ).toEqual({ event: WEB_ANALYTICS_EVENTS.pageLeft, properties: {} });
    expect(initOptions?.before_send({ event: "$autocapture" })).toBeNull();
    expect(initOptions?.before_send({ event: "$heatmap" })).toBeNull();
  });

  test("scrubs SDK-stamped resolved URLs from navigation events", () => {
    const { analytics } = createPostHogAnalytics({
      host: "https://posthog.test",
      key: "phc_test",
    });

    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: new URL("https://app.example.test/workspaces/ws_1"),
    });
    // Records resolved pathname -> route template in the history the
    // scrubber maps through.
    analytics.capturePageViewed({ path: "/workspaces/$workspaceId" });

    const sanitized = initOptions?.before_send({
      event: WEB_ANALYTICS_EVENTS.pageLeft,
      properties: {
        $current_url: "https://app.example.test/workspaces/ws_1",
        $pathname: "/workspaces/ws_1",
        $host: "app.example.test",
        $prev_pageview_pathname: "/workspaces/ws_1",
        $session_entry_url: "https://app.example.test/workspaces/ws_1",
        $session_entry_pathname: "/workspaces/ws_1",
        $referrer: "https://app.example.test/workspaces/ws_1",
        $session_entry_referrer: "https://www.google.com/",
        $prev_pageview_duration: 12,
        title: "Client Smith v Example",
        $session_id: "session-1",
      },
    });

    expect(sanitized?.properties).toEqual({
      $current_url: "https://app.example.test/workspaces/$workspaceId",
      $pathname: "/workspaces/$workspaceId",
      $host: "app.example.test",
      $prev_pageview_pathname: "/workspaces/$workspaceId",
      $session_entry_url: "https://app.example.test/workspaces/$workspaceId",
      $session_entry_pathname: "/workspaces/$workspaceId",
      // Internal referrer dropped; external referrer kept.
      $session_entry_referrer: "https://www.google.com/",
      $prev_pageview_duration: 12,
      $session_id: "session-1",
    });
  });

  test("drops resolved URLs the route template history cannot map", () => {
    createPostHogAnalytics({ host: "https://posthog.test", key: "phc_test" });

    const sanitized = initOptions?.before_send({
      event: WEB_ANALYTICS_EVENTS.pageLeft,
      properties: {
        $current_url: "https://app.example.test/workspaces/ws_unknown",
        $pathname: "/workspaces/ws_unknown",
        $prev_pageview_pathname: "/workspaces/ws_unknown",
        $session_entry_url: "https://app.example.test/workspaces/ws_unknown",
        $session_entry_pathname: "/workspaces/ws_unknown",
        title: "Client Smith v Example",
        $session_id: "session-1",
      },
    });

    expect(sanitized?.properties).toEqual({ $session_id: "session-1" });
  });

  test("keeps the route template override on page views while scrubbing SDK context", () => {
    createPostHogAnalytics({ host: "https://posthog.test", key: "phc_test" });

    const sanitized = initOptions?.before_send({
      event: WEB_ANALYTICS_EVENTS.pageViewed,
      properties: {
        $current_url: "https://app.example.test/workspaces/$workspaceId",
        $pathname: "/workspaces/$workspaceId",
        path: "/workspaces/$workspaceId",
        $prev_pageview_pathname: "/workspaces/ws_unmapped",
        title: "Client Smith v Example",
      },
    });

    expect(sanitized?.properties).toEqual({
      $current_url: "https://app.example.test/workspaces/$workspaceId",
      $pathname: "/workspaces/$workspaceId",
      path: "/workspaces/$workspaceId",
    });
  });

  test("drops known browser-noise exceptions", () => {
    createPostHogAnalytics({ host: "https://posthog.test", key: "phc_test" });

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
    createPostHogAnalytics({ host: "https://posthog.test", key: "phc_test" });

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
        $exception_fingerprint: "UnhandledRejection|||",
        $exception_list: [{ type: "UnhandledRejection", value: "" }],
        $exception_type: "UnhandledRejection",
      },
    });
  });

  test("keeps real exception types and frames without messages", () => {
    createPostHogAnalytics({ host: "https://posthog.test", key: "phc_test" });

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
        $exception_fingerprint: "TypeError||app.js:|",
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
    createPostHogAnalytics({ host: "https://posthog.test", key: "phc_test" });

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
                    "https://my.stll.app/assets/app.js#access_token=private-token",
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
    const { analytics } = createPostHogAnalytics({
      host: "https://posthog.test",
      key: "phc_test",
    });
    analytics.captureError(null);
    analytics.captureError(undefined);
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  test("captureError sends the error type and a message-free stack", () => {
    const { analytics } = createPostHogAnalytics({
      host: "https://posthog.test",
      key: "phc_test",
    });
    const error = new TypeError("Privileged document name and server payload");
    error.stack = [
      `TypeError: ${error.message}`,
      "    at renderMatter (https://stella.test/assets/index.js:10:15)",
    ].join("\n");
    analytics.captureError(error);

    const captured = captureExceptionMock.mock.calls.at(-1)?.[0];
    expect(captured).toBeInstanceOf(Error);
    expect(captured).toMatchObject({ name: "TypeError", message: "" });
    if (!(captured instanceof Error)) {
      throw new TypeError("Expected a redacted Error");
    }
    expect(captured.stack).toStartWith("TypeError:\n");
    expect(captured.stack).not.toContain("Privileged document name");
    expect(captured.stack).toContain("    at renderMatter");
  });

  // Frame syntax is engine-specific, so the redaction has to hold for each
  // one: every frame survives, and the header carrying the message does not.
  const ENGINE_FRAMES = {
    callsite: [
      "renderMatter@https://stella.test/assets/index.js:10:15",
      "handleClick/<@https://stella.test/assets/index.js:22:3",
      "async*renderMatter@https://stella.test/assets/index.js:26:5",
      "Async*@https://stella.test/assets/index.js:28:6",
      "calculÉchéance@https://stella.test/assets/index.js:29:6",
      "global code@https://stella.test/assets/index.js:30:7",
    ],
    indented: [
      "    at renderMatter (https://stella.test/assets/index.js:10:15)",
      "    at handleClick (https://stella.test/assets/index.js:22:3)",
    ],
  } as const satisfies Record<string, readonly string[]>;

  test.each(Object.entries(ENGINE_FRAMES))(
    "stack redaction keeps %s frames and drops the message",
    (_syntax, frames) => {
      const stack =
        _syntax === "callsite"
          ? frames.join("\n")
          : ["RangeError: Privileged document name", ...frames].join("\n");

      expect(
        redactTelemetryStack({
          errorType: "RangeError",
          stack,
          syntax: _syntax === "callsite" ? "callsite" : "v8",
        }),
      ).toBe(["RangeError:", ...frames].join("\n"));
    },
  );

  test("stack redaction drops a callsite stack that starts with message text", () => {
    expect(
      redactTelemetryStack({
        errorType: "Error",
        stack: [
          "Privileged document name",
          "clientName@https://stella.test/assets/private.js:20:5",
        ].join("\n"),
        syntax: "callsite",
      }),
    ).toBeUndefined();
  });

  // A header whose message is frame-shaped is still a header: no engine
  // may read it as a frame, with or without frames beneath it.
  test.each(["callsite", "v8"] as const)(
    "stack redaction drops a frame-shaped header under %s syntax",
    (syntax) => {
      expect(
        redactTelemetryStack({
          errorType: "TypeError",
          stack:
            "TypeError: notify jane@https://my.stll.app/matters/Client-Smith:1:2",
          syntax,
        }),
      ).toBeUndefined();
    },
  );

  test("stack redaction keeps callsite frames under a native built-in frame", () => {
    const frame = "renderMatter@https://stella.test/assets/index.js:10:15";
    expect(
      redactTelemetryStack({
        errorType: "SyntaxError",
        stack: ["parse@[native code]", frame].join("\n"),
        syntax: "callsite",
      }),
    ).toBe(["SyntaxError:", frame].join("\n"));
  });

  const URL_METADATA_FRAMES = {
    callsiteQuery: {
      frame:
        "renderMatter@https://stella.test/assets/index.js?token=private:10:15",
      safeFrame: "renderMatter@https://stella.test/assets/index.js:10:15",
    },
    callsiteFragment: {
      frame:
        "renderMatter@https://stella.test/assets/index.js#access_token=private:10:15",
      safeFrame: "renderMatter@https://stella.test/assets/index.js:10:15",
    },
    indentedQuery: {
      frame:
        "    at renderMatter (https://stella.test/assets/index.js?token=private:10:15)",
      safeFrame:
        "    at renderMatter (https://stella.test/assets/index.js:10:15)",
    },
    indentedFragment: {
      frame:
        "    at renderMatter (https://stella.test/assets/index.js#access_token=private:10:15)",
      safeFrame:
        "    at renderMatter (https://stella.test/assets/index.js:10:15)",
    },
    indentedWithQueryParentheses: {
      frame:
        "    at renderMatter (https://stella.test/assets/index.js?token=private(value):10:15)",
      safeFrame:
        "    at renderMatter (https://stella.test/assets/index.js:10:15)",
    },
  } as const;

  test.each(Object.entries(URL_METADATA_FRAMES))(
    "stack redaction removes URL metadata from %s frames",
    (_syntax, { frame, safeFrame }) => {
      expect(
        redactTelemetryStack({
          errorType: "Error",
          stack: frame,
          syntax: frame.startsWith("    at ") ? "v8" : "callsite",
        }),
      ).toBe(["Error:", safeFrame].join("\n"));
    },
  );

  const UNSAFE_SOURCE_FRAMES = {
    callsiteData:
      "renderMatter@data:text/javascript,throw%20new%20Error(%22PrivilegedMatterName%22):1:1",
    indentedData:
      "    at renderMatter (data:text/javascript,throw%20new%20Error(%22PrivilegedMatterName%22):1:1)",
    callsiteBlob: "renderMatter@blob:https://stella.test/private-token:1:1",
    indentedCredentials:
      "    at renderMatter (https://client:secret@stella.test/index.js:1:1)",
  } as const;

  test.each(Object.entries(UNSAFE_SOURCE_FRAMES))(
    "stack redaction drops unsafe %s locations",
    (_kind, frame) => {
      expect(
        redactTelemetryStack({
          errorType: "Error",
          stack: frame,
          syntax: frame.startsWith("    at ") ? "v8" : "callsite",
        }),
      ).toBeUndefined();
    },
  );

  test("captureError cannot treat a multiline message as a stack frame", () => {
    const { analytics } = createPostHogAnalytics({
      host: "https://posthog.test",
      key: "phc_test",
    });
    const injectedFrame =
      "clientName@https://stella.test/assets/private.js:20:5";
    const actualFrame =
      "    at renderMatter (https://stella.test/assets/index.js:10:15)";
    const error = new Error(`Privileged document name\n${injectedFrame}`);
    error.stack = [`Error: ${error.message}`, actualFrame].join("\n");

    analytics.captureError(error);

    const captured = captureExceptionMock.mock.calls.at(-1)?.[0];
    if (!(captured instanceof Error)) {
      throw new TypeError("Expected a redacted Error");
    }
    expect(captured.stack).toBe(["Error:", actualFrame].join("\n"));
  });

  test("captureError ignores a serialized header after error fields change", () => {
    const { analytics } = createPostHogAnalytics({
      host: "https://posthog.test",
      key: "phc_test",
    });
    const injectedFrame =
      "clientName@https://stella.test/assets/private.js:20:5";
    const actualFrame =
      "    at renderMatter (https://stella.test/assets/index.js:10:15)";
    const error = new Error(`Privileged document name\n${injectedFrame}`);
    error.stack = [`Error: ${error.message}`, actualFrame].join("\n");
    error.name = "ClientTelemetryError";
    error.message = "Changed after stack serialization";

    analytics.captureError(error);

    const captured = captureExceptionMock.mock.calls.at(-1)?.[0];
    if (!(captured instanceof Error)) {
      throw new TypeError("Expected a redacted Error");
    }
    expect(captured.stack).toBe(
      ["ClientTelemetryError:", actualFrame].join("\n"),
    );
  });

  test("captureError cannot partially remove a stale serialized header", () => {
    const { analytics } = createPostHogAnalytics({
      host: "https://posthog.test",
      key: "phc_test",
    });
    const injectedFrame =
      "clientName@https://stella.test/assets/private.js:20:5";
    const error = new Error(`Public summary\n${injectedFrame}`);
    error.stack = `Error: ${error.message}`;
    error.message = "Public summary";

    analytics.captureError(error);

    const captured = captureExceptionMock.mock.calls.at(-1)?.[0];
    if (!(captured instanceof Error)) {
      throw new TypeError("Expected a redacted Error");
    }
    expect(captured.stack).toBeUndefined();
  });

  test("captureError cannot infer callsite syntax from a V8 header", () => {
    const { analytics } = createPostHogAnalytics({
      host: "https://posthog.test",
      key: "phc_test",
    });
    const injectedFrame =
      "clientName@https://stella.test/assets/private.js:20:5";
    const actualFrame =
      "    at renderMatter (https://stella.test/assets/index.js:10:15)";
    const error = new Error(
      `renderMatter@https://stella.test/assets/a.js:1:2\n${injectedFrame}`,
    );
    error.stack = [`Error: ${error.message}`, actualFrame].join("\n");

    analytics.captureError(error);

    const captured = captureExceptionMock.mock.calls.at(-1)?.[0];
    if (!(captured instanceof Error)) {
      throw new TypeError("Expected a redacted Error");
    }
    expect(captured.stack).toBe(["Error:", actualFrame].join("\n"));
  });

  test("captureError cannot treat an empty-name V8 header as a callsite", () => {
    const { analytics } = createPostHogAnalytics({
      host: "https://posthog.test",
      key: "phc_test",
    });
    const injectedFrame =
      "clientName@https://stella.test/assets/private.js:20:5";
    const actualFrame =
      "    at renderMatter (https://stella.test/assets/index.js:10:15)";
    const error = new Error(injectedFrame);
    error.name = "";
    error.stack = [error.message, actualFrame].join("\n");

    analytics.captureError(error);

    const captured = captureExceptionMock.mock.calls.at(-1)?.[0];
    if (!(captured instanceof Error)) {
      throw new TypeError("Expected a redacted Error");
    }
    expect(captured.stack).toBe(["UnknownError:", actualFrame].join("\n"));
  });

  test("captureError drops a frameless empty-name V8 stack", () => {
    const { analytics } = createPostHogAnalytics({
      host: "https://posthog.test",
      key: "phc_test",
    });
    const error = new Error("Privileged message");
    error.name = "";
    error.stack = [
      "renderMatter@https://stella.test/assets/a.js:1:2",
      "clientName@https://stella.test/assets/private.js:20:5",
    ].join("\n");

    analytics.captureError(error);

    const captured = captureExceptionMock.mock.calls.at(-1)?.[0];
    if (!(captured instanceof Error)) {
      throw new TypeError("Expected a redacted Error");
    }
    expect(captured.stack).toBeUndefined();
  });

  test("captureError survives a cyclic cause chain", () => {
    const { analytics } = createPostHogAnalytics({
      host: "https://posthog.test",
      key: "phc_test",
    });
    const first = new Error("Privileged first");
    const second = new Error("Privileged second", { cause: first });
    first.cause = second;
    analytics.captureError(second);
    expect(captureExceptionMock.mock.calls.at(-1)?.[0]).toBeInstanceOf(Error);
  });

  test("drops frame function names that are not symbol-shaped", () => {
    createPostHogAnalytics({ host: "https://posthog.test", key: "phc_test" });
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
    const { analytics } = createPostHogAnalytics({
      host: "https://posthog.test",
      key: "phc_test",
    });
    const original = new RangeError("Privileged original message");
    const wrapper = new Error("Privileged wrapper message", {
      cause: original,
    });
    wrapper.name = "ClientTelemetryError";
    // Distinguishable stacks: the wrapper's own stack must not win.
    wrapper.stack = [
      "Error: Privileged wrapper message",
      "    at boundary (https://stella.test/assets/boundary.js:1:2)",
    ].join("\n");
    original.stack =
      "RangeError: Privileged original message\n    at failureSite (https://stella.test/assets/failure.js:3:4)";
    analytics.captureError(wrapper);

    const captured = captureExceptionMock.mock.calls.at(-1)?.[0];
    if (!(captured instanceof Error)) {
      throw new TypeError("Expected a redacted Error");
    }
    expect(captured.name).toBe("ClientTelemetryError");
    expect(captured.stack).toBe(
      "ClientTelemetryError:\n    at failureSite (https://stella.test/assets/failure.js:3:4)",
    );
  });

  test("captureError attaches the telemetry area slug and nothing free-form", () => {
    const { analytics } = createPostHogAnalytics({
      host: "https://posthog.test",
      key: "phc_test",
    });
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
    createPostHogAnalytics({ host: "https://posthog.test", key: "phc_test" });

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

  test("fingerprints exceptions from structure, never from message content", () => {
    createPostHogAnalytics({ host: "https://posthog.test", key: "phc_test" });

    // Production-shaped event: PII in the message, a token-bearing query
    // string on the asset URL, and a wrapped cause.
    const crashInMatterView = {
      event: WEB_ANALYTICS_EVENTS.exception,
      properties: {
        area: "pdf-viewer",
        $exception_list: [
          {
            type: "ClientTelemetryError",
            value:
              "Cannot render brief for jana.novakova@example.com in Client Smith v Example",
            stacktrace: {
              frames: [
                {
                  filename:
                    "https://my.stll.app/assets/matter-view-D3kfQx9a.js?token=phx_9f3b2c&email=jana.novakova@example.com",
                  function: "renderMatter",
                  in_app: true,
                  lineno: 4,
                  colno: 18_733,
                },
              ],
            },
          },
          {
            type: "RangeError",
            value: "Privileged cause detail for jana.novakova@example.com",
          },
        ],
      },
    };
    const fingerprint =
      initOptions?.before_send(crashInMatterView)?.properties?.[
        "$exception_fingerprint"
      ];
    expect(fingerprint).toBe(
      "ClientTelemetryError|pdf-viewer|matter-view.js:renderMatter|RangeError",
    );

    // Deterministic: the same defect groups into the same issue.
    expect(
      initOptions?.before_send(crashInMatterView)?.properties?.[
        "$exception_fingerprint"
      ],
    ).toBe(fingerprint);

    // A different defect in a different component groups separately even
    // though the error class matches.
    expect(
      initOptions?.before_send({
        event: WEB_ANALYTICS_EVENTS.exception,
        properties: {
          $exception_list: [
            {
              type: "ClientTelemetryError",
              value: "Different failure, same class",
              stacktrace: {
                frames: [
                  {
                    filename:
                      "https://my.stll.app/assets/document-panel-Ck2pW7dm.js",
                    function: "openDocument",
                    in_app: true,
                    lineno: 2,
                    colno: 9812,
                  },
                ],
              },
            },
          ],
        },
      })?.properties?.["$exception_fingerprint"],
    ).not.toBe(fingerprint);
  });

  test("captureError correlates a recovery reference without error details", () => {
    const { analytics } = createPostHogAnalytics({
      host: "https://posthog.test",
      key: "phc_test",
    });
    analytics.captureError(new TypeError("Privileged document name"), {
      type: "recovery",
      reference: "ERR-DEAD-BEEF-1234",
    });

    expect(captureExceptionMock.mock.calls.at(-1)?.[1]).toEqual({
      error_reference: "ERR-DEAD-BEEF-1234",
    });
  });

  test("captures and sanitizes route crash lifecycle properties", async () => {
    const { analytics } = createPostHogAnalytics({
      host: "https://posthog.test",
      key: "phc_test",
    });
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
    createPostHogAnalytics({ host: "https://posthog.test", key: "phc_test" });

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
    createPostHogAnalytics({ host: "https://posthog.test", key: "phc_test" });

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
    createPostHogAnalytics({ host: "https://posthog.test", key: "phc_test" });
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
        $exception_fingerprint: "TypeError||app.js:|",
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
    createPostHogAnalytics({ host: "https://posthog.test", key: "phc_test" });
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

    const webVitals = initOptions?.before_send({
      event: WEB_ANALYTICS_EVENTS.webVitals,
      properties: {
        ...envelope,
        $web_vitals_LCP_value: 1234.5,
      },
    });
    for (const key of INGESTION_REQUIRED_KEYS) {
      expect(webVitals?.properties?.[key]).toEqual(envelope[key]);
    }
    expect(webVitals?.properties).not.toContainKeys(["$lib", "$current_url"]);
  });

  test("before_send keeps only valid opaque recovery references", () => {
    createPostHogAnalytics({ host: "https://posthog.test", key: "phc_test" });
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
        $exception_fingerprint: "TypeError|||",
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
        $exception_fingerprint: "TypeError|||",
        $exception_list: [{ type: "TypeError", value: "" }],
        $exception_type: "TypeError",
      },
    });
  });

  test("web vitals keep metric values and coarse context, never attribution or resolved URLs", () => {
    const { analytics } = createPostHogAnalytics({
      host: "https://posthog.test",
      key: "phc_test",
    });
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: new URL(
        "https://app.example.test/workspaces/private-matter-018f9f0e",
      ),
    });
    analytics.capturePageViewed({ path: "/workspaces/$workspaceId" });

    const sanitized = initOptions?.before_send({
      event: WEB_ANALYTICS_EVENTS.webVitals,
      properties: {
        token: "phc_test",
        distinct_id: "018f9f0e-7b42-7cc8-9a5d-42db46f6842d",
        $current_url:
          "https://app.example.test/workspaces/private-matter-018f9f0e",
        $pathname: "/workspaces/private-matter-018f9f0e",
        $session_id: "018f9f0e-7b42-7cc8-9a5d-42db46f6842e",
        $browser: "Chrome",
        $web_vitals_LCP_value: 1234.5,
        $web_vitals_CLS_value: 0.02,
        $web_vitals_LCP_event: {
          name: "LCP",
          value: 1234.5,
          $current_url:
            "https://app.example.test/workspaces/private-matter-018f9f0e",
          attribution: { element: "div#client-name" },
        },
        $web_vitals_CLS_event: { name: "CLS", value: 0.02 },
      },
    });

    expect(sanitized).toEqual({
      event: WEB_ANALYTICS_EVENTS.webVitals,
      properties: {
        token: "phc_test",
        distinct_id: "018f9f0e-7b42-7cc8-9a5d-42db46f6842d",
        $web_vitals_LCP_value: 1234.5,
        $web_vitals_CLS_value: 0.02,
        $session_id: "018f9f0e-7b42-7cc8-9a5d-42db46f6842e",
        $browser: "Chrome",
        $current_url: "https://app.example.test/workspaces/$workspaceId",
        $pathname: "/workspaces/$workspaceId",
      },
    });
  });

  // Vitals can flush after the next navigation resolves, so attribution
  // must follow the metric's originating URL, not the latest route.
  test("web vitals flushed after a navigation keep their originating route", () => {
    const { analytics } = createPostHogAnalytics({
      host: "https://posthog.test",
      key: "phc_test",
    });
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: new URL("https://app.example.test/workspaces/private-matter-a"),
    });
    analytics.capturePageViewed({ path: "/workspaces/$workspaceId" });
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: new URL("https://app.example.test/contacts"),
    });
    analytics.capturePageViewed({ path: "/contacts" });

    // Measured on the workspace route, delivered while /contacts is
    // current: the label must stay the workspace template.
    const sanitized = initOptions?.before_send({
      event: WEB_ANALYTICS_EVENTS.webVitals,
      properties: {
        token: "phc_test",
        $current_url: "https://app.example.test/contacts",
        $pathname: "/contacts",
        $web_vitals_INP_value: 87,
        $web_vitals_INP_event: {
          name: "INP",
          value: 87,
          $current_url: "https://app.example.test/workspaces/private-matter-a",
        },
      },
    });
    expect(sanitized?.properties?.["$pathname"]).toBe(
      "/workspaces/$workspaceId",
    );
    expect(sanitized?.properties?.["$current_url"]).toBe(
      "https://app.example.test/workspaces/$workspaceId",
    );
  });

  test("web vitals without metric values or a known origin are constrained", () => {
    createPostHogAnalytics({ host: "https://posthog.test", key: "phc_test" });

    // No metric values: nothing worth ingesting.
    expect(
      initOptions?.before_send({
        event: WEB_ANALYTICS_EVENTS.webVitals,
        properties: {
          token: "phc_test",
          $current_url: "https://app.example.test/workspaces/private-matter",
        },
      }),
    ).toBeNull();

    // An originating URL no capturePageViewed ever recorded: the
    // resolved URL is dropped rather than substituted or mislabeled.
    const sanitized = initOptions?.before_send({
      event: WEB_ANALYTICS_EVENTS.webVitals,
      properties: {
        token: "phc_test",
        $current_url: "https://app.example.test/workspaces/private-matter",
        $pathname: "/workspaces/private-matter",
        $web_vitals_INP_value: 87,
        $web_vitals_INP_event: {
          name: "INP",
          value: 87,
          $current_url: "https://app.example.test/workspaces/private-matter",
        },
      },
    });
    expect(sanitized?.properties).toEqual({
      token: "phc_test",
      $web_vitals_INP_value: 87,
    });
  });

  test("captures sanitized page view payloads", () => {
    const { analytics } = createPostHogAnalytics({
      host: "https://posthog.test",
      key: "phc_test",
    });

    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: new URL("https://app.example.test"),
    });
    analytics.capturePageViewed({
      path: "/workspaces/$workspaceId",
    });

    // The route template overrides the SDK's own URL properties so resolved
    // resource ids never reach analytics, while web analytics still
    // aggregates by page.
    expect(captureMock).toHaveBeenCalledWith(WEB_ANALYTICS_EVENTS.pageViewed, {
      $current_url: "https://app.example.test/workspaces/$workspaceId",
      $pathname: "/workspaces/$workspaceId",
      path: "/workspaces/$workspaceId",
    });
  });

  test("identifies users by stable id and attaches the organization group", () => {
    const { analytics } = createPostHogAnalytics({
      host: "https://posthog.test",
      key: "phc_test",
    });

    analytics.identifyUser({ id: "user_123", activeOrganizationId: "org_1" });

    expect(identifyMock).toHaveBeenCalledWith("user_123");
    expect(groupMock).toHaveBeenCalledWith("organization", "org_1");
  });

  test("identifies the same user only once per browser app session", () => {
    const { analytics } = createPostHogAnalytics({
      host: "https://posthog.test",
      key: "phc_test",
    });

    analytics.identifyUser({ id: "user_123", activeOrganizationId: "org_1" });
    analytics.identifyUser({ id: "user_123", activeOrganizationId: "org_1" });

    expect(identifyMock).toHaveBeenCalledTimes(1);
    expect(resetMock).not.toHaveBeenCalled();
  });

  test("rebinds the organization group on a same-user organization switch", () => {
    const { analytics } = createPostHogAnalytics({
      host: "https://posthog.test",
      key: "phc_test",
    });

    analytics.identifyUser({ id: "user_123", activeOrganizationId: "org_1" });
    analytics.identifyUser({ id: "user_123", activeOrganizationId: "org_2" });

    // The identity guard still suppresses the duplicate identify, but the
    // group must follow the active organization or later events attribute
    // to the previous organization across an ownership boundary.
    expect(identifyMock).toHaveBeenCalledTimes(1);
    expect(groupMock).toHaveBeenNthCalledWith(2, "organization", "org_2");
  });

  test("resets before identifying a different user", () => {
    const { analytics } = createPostHogAnalytics({
      host: "https://posthog.test",
      key: "phc_test",
    });

    analytics.identifyUser({ id: "user_123", activeOrganizationId: "org_1" });
    analytics.identifyUser({ id: "user_456", activeOrganizationId: "org_2" });

    expect(resetMock).toHaveBeenCalledTimes(1);
    expect(identifyMock).toHaveBeenNthCalledWith(2, "user_456");
    expect(groupMock).toHaveBeenNthCalledWith(2, "organization", "org_2");
  });

  test("reset can be limited to identified sessions", () => {
    const { analytics } = createPostHogAnalytics({
      host: "https://posthog.test",
      key: "phc_test",
    });

    analytics.reset({ onlyIfIdentified: true });

    expect(resetMock).not.toHaveBeenCalled();

    analytics.identifyUser({ id: "user_123", activeOrganizationId: "org_1" });
    analytics.reset({ onlyIfIdentified: true });

    expect(resetMock).toHaveBeenCalledTimes(1);
  });

  test("reset clears anonymous sessions by default", () => {
    const { analytics } = createPostHogAnalytics({
      host: "https://posthog.test",
      key: "phc_test",
    });

    analytics.reset();

    expect(resetMock).toHaveBeenCalledTimes(1);
  });

  test("reset clears the in-memory identity guard", () => {
    const { analytics } = createPostHogAnalytics({
      host: "https://posthog.test",
      key: "phc_test",
    });

    analytics.identifyUser({ id: "user_123", activeOrganizationId: "org_1" });
    analytics.reset();
    analytics.identifyUser({ id: "user_123", activeOrganizationId: "org_1" });

    expect(resetMock).toHaveBeenCalledTimes(1);
    expect(identifyMock).toHaveBeenCalledTimes(2);
  });
});
