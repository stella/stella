import { beforeEach, describe, expect, mock, test } from "bun:test";
import fc from "fast-check";
import * as posthogSdk from "posthog-js";

import {
  API_FILE_SECURITY_REJECTED_ERROR_CODE,
  CHAT_CONTINUATION_REJECTED_ERROR_CODE,
} from "@stll/api-contract";
import { PROVIDER_SETUP_ERROR_CODE } from "@stll/api-contract/provider-setup";
import { MAX_EXCEPTION_CAUSE_DEPTH } from "@stll/errors/exception-cause-chain";
import { assertProperty } from "@stll/property-testing";

import { env } from "@/env";
import { sanitizeHangDiagnosticEvent } from "@/lib/analytics/posthog-hang-diagnostics";
import { INGESTION_REQUIRED_KEYS } from "@/lib/analytics/posthog-ingestion";
import { WEB_ANALYTICS_EVENTS } from "@/lib/analytics/types";
import { APIError } from "@/lib/errors/api";
import { ClientTelemetryError } from "@/lib/errors/telemetry";

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
    boolean | { network_timing: boolean; web_vitals: boolean };
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
// The `$identify` events the SDK sends, with the anonymous id each links.
let identifyEvents: { distinctId: string; anonymousId: string }[] = [];
// Mirrors posthog-js: identifying from an anonymous state sends `$identify`
// with the previous id as `$anon_distinct_id`; from an identified state it
// only switches the id.
const identifyMock = mock((id: string) => {
  if (!identified && id !== distinctId) {
    identifyEvents.push({ distinctId: id, anonymousId: distinctId });
  }
  distinctId = id;
  identified = true;
});
const initMock = mock((_key: string, options: PostHogInitOptions) => {
  initOptions = options;
  return posthogMock;
});
const registerMock = mock((_properties: Record<string, unknown>) => undefined);
const getDistinctIdMock = mock(() => distinctId);
const isIdentifiedMock = mock(() => identified);
type ResetOptions = {
  bootstrap?: { distinctID?: string; isIdentifiedID?: boolean };
};
// Mirrors posthog-js: a bootstrapped id becomes the distinct id, identified
// when the bootstrap says so; a bare reset mints a new anonymous id.
const resetMock = mock((options?: ResetOptions) => {
  distinctId = options?.bootstrap?.distinctID ?? "anonymous_after_reset";
  identified = options?.bootstrap?.isIdentifiedID === true;
});
const groupMock = mock((_type: string, _key: string) => undefined);

const posthogMock = Object.assign(new posthogSdk.PostHog(), {
  capture: captureMock,
  captureException: captureExceptionMock,
  get_distinct_id: getDistinctIdMock,
  group: groupMock,
  identify: identifyMock,
  init: initMock,
  _isIdentified: isIdentifiedMock,
  register: registerMock,
  reset: resetMock,
});

Object.defineProperty(globalThis, "__APP_VERSION__", {
  configurable: true,
  value: "test",
});
Object.defineProperty(globalThis, "__APP_COMMIT_SHA__", {
  configurable: true,
  value: "abc123",
});

void mock.module("posthog-js", () => ({
  ...posthogSdk,
  posthog: posthogMock,
}));

const {
  createPostHogAnalytics,
  isNoiseException,
  sanitizeFrame,
  signedInAnonymousId,
  UNKNOWN_FRAME_FUNCTION,
} = await import("./posthog");
const { redactTelemetryStack } = await import("./stack-redaction");
const { sanitizeRouteErrorLifecycleEvent } =
  await import("./posthog-route-error");

const BROWSER_RUNTIME = { type: "browser" } as const;

describe("PostHog browser analytics adapter", () => {
  beforeEach(() => {
    distinctId = "anonymous";
    identified = false;
    identifyEvents = [];
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

  test("captures hang diagnostics without storage values or SDK page context", () => {
    const { analytics } = createPostHogAnalytics({
      host: "https://posthog.test",
      key: "phc_test",
      routeTemplates: ["/chat/$threadId"],
    });
    const diagnostic = {
      routeTemplate: "/chat/$threadId",
      phase: "boot",
      build: "1.2.3-abc123",
      restoredState: [{ key: "stella:inspector-state", bytes: 123 }],
    } as const;
    analytics.capturePageHangSuspected(diagnostic);
    expect(captureMock).toHaveBeenCalledWith(
      WEB_ANALYTICS_EVENTS.pageHangSuspected,
      diagnostic,
    );
    const result = initOptions?.before_send({
      event: WEB_ANALYTICS_EVENTS.pageHangSuspected,
      properties: {
        ...diagnostic,
        token: "phc_test",
        distinct_id: "anonymous",
        $current_url: "https://staging.stll.app/chat/private-id",
        title: "Privileged title",
        restoredState: [
          {
            key: "stella:inspector-state",
            bytes: 123,
            value: "Privileged content",
          },
          { key: "private-account-id", bytes: 42 },
          { key: "stella:inspector-width", bytes: -1 },
        ],
      },
    });
    expect(result?.properties).toEqual({
      ...diagnostic,
      token: "phc_test",
      distinct_id: "anonymous",
    });
    expect(JSON.stringify(result)).not.toContain("Privileged");
    for (const invalid of [
      { phase: "unknown" },
      { build: "private build text" },
      { routeTemplate: "/chat?id=private" },
      { routeTemplate: "/chat/private-thread-id" },
      { routeTemplate: "/chat/$chatId" },
      { routeTemplate: "https://staging.stll.app/chat/private-thread-id" },
    ]) {
      expect(
        initOptions?.before_send({
          event: WEB_ANALYTICS_EVENTS.pageHangSuspected,
          properties: { ...diagnostic, ...invalid },
        }),
      ).toBeNull();
    }
    expect(
      initOptions?.before_send({
        event: WEB_ANALYTICS_EVENTS.pageHangSuspected,
        properties: { ...diagnostic, routeTemplate: "unknown" },
      })?.properties?.["routeTemplate"],
    ).toBe("unknown");
  });

  test("hang diagnostics accept only the route templates supplied by their router", () => {
    createPostHogAnalytics({
      host: "https://posthog.test",
      key: "phc_test",
      routeTemplates: ["/isolated/$routeId"],
    });
    for (const routeTemplate of ["/isolated/$routeId", "/chat/$threadId"]) {
      const result = initOptions?.before_send({
        event: WEB_ANALYTICS_EVENTS.pageHangSuspected,
        properties: {
          routeTemplate,
          phase: "session",
          build: "test",
          restoredState: [],
        },
      });
      if (routeTemplate === "/isolated/$routeId") {
        expect(result?.properties?.["routeTemplate"]).toBe(routeTemplate);
      } else {
        expect(result).toBeNull();
      }
    }
  });

  test("allows long animation frames with bounded static script attribution only", () => {
    const { analytics } = createPostHogAnalytics({
      host: "https://posthog.test",
      key: "phc_test",
    });
    const diagnostic = {
      duration: 1200,
      scripts: [
        {
          invoker: "Window.requestAnimationFrame",
          sourceURL: `${env.VITE_PUBLIC_APP_URL}/assets/index-Abc123.js?token=secret#private`,
          sourceFunctionName: "PrivilegedDocumentName",
        },
      ],
    };
    analytics.captureLongAnimationFrame(diagnostic);
    expect(captureMock).toHaveBeenCalledWith(
      WEB_ANALYTICS_EVENTS.longAnimationFrame,
      diagnostic,
    );
    const event = {
      event: WEB_ANALYTICS_EVENTS.longAnimationFrame,
      properties: {
        ...diagnostic,
        $current_url: "https://staging.stll.app/private",
        scripts: [
          ...diagnostic.scripts,
          {
            invoker: "DIV#privileged.onclick",
            sourceURL: `${env.VITE_PUBLIC_APP_URL}/assets/other-Abc123.js`,
            sourceFunctionName: "PrivateName",
          },
          {
            invoker: "Window.setTimeout",
            sourceURL: "https://external.test/assets/index.js",
            sourceFunctionName: "external",
          },
          {
            invoker: "Window.setTimeout",
            sourceURL: `${env.VITE_PUBLIC_APP_URL}/files/private-id`,
            sourceFunctionName: "private",
          },
        ],
      },
    };
    expect(initOptions?.before_send(event)?.properties).toEqual({
      duration: 1200,
      scripts: [
        {
          invoker: "Window.requestAnimationFrame",
          sourceURL: `${env.VITE_PUBLIC_APP_URL}/assets/index-Abc123.js`,
          sourceFunctionName: "?",
        },
        {
          invoker: "?",
          sourceURL: `${env.VITE_PUBLIC_APP_URL}/assets/other-Abc123.js`,
          sourceFunctionName: "?",
        },
      ],
    });
    for (const duration of [0, 999, 1000, Number.NaN, Infinity]) {
      expect(
        initOptions?.before_send({
          ...event,
          properties: { ...event.properties, duration },
        }),
      ).toBeNull();
    }
    expect(
      initOptions?.before_send({
        ...event,
        properties: {
          ...event.properties,
          scripts: Array.from({ length: 50 }, () => diagnostic.scripts.at(0)),
        },
      })?.properties?.["scripts"],
    ).toHaveLength(10);
  });

  test("retains first-party frame attribution when the configured app URL includes a slash or path", () => {
    for (const appUrl of [
      "https://staging.stll.app/",
      "https://staging.stll.app/app/",
    ]) {
      const result = sanitizeHangDiagnosticEvent({
        event: {
          event: WEB_ANALYTICS_EVENTS.longAnimationFrame,
          uuid: "normalized-origin-frame",
          properties: {
            duration: 1200,
            scripts: [
              {
                invoker: "Window.requestAnimationFrame",
                sourceURL:
                  "https://staging.stll.app/assets/index-Abc123.js?secret=value",
                sourceFunctionName: "private",
              },
              {
                invoker: "Window.setTimeout",
                sourceURL: "https://external.test/assets/index-Abc123.js",
                sourceFunctionName: "private",
              },
            ],
          },
        },
        appUrl,
        routeTemplates: [],
      });
      expect(result?.properties["scripts"]).toEqual([
        {
          invoker: "Window.requestAnimationFrame",
          sourceURL: "https://staging.stll.app/assets/index-Abc123.js",
          sourceFunctionName: "?",
        },
      ]);
    }
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
        $current_url: "https://app.example.test/workspaces/ws_1#sh=sh1_sample",
        $pathname: "/workspaces/ws_1",
        $host: "app.example.test",
        $prev_pageview_pathname: "/workspaces/ws_1",
        $session_entry_url:
          "https://app.example.test/workspaces/ws_1#sh=sh1_sample",
        $session_entry_pathname: "/workspaces/ws_1",
        $referrer: "https://app.example.test/workspaces/ws_1",
        $session_entry_referrer:
          "https://www.google.com/?sh=sh1_sample#sh=sh1_sample",
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

  const exceptionEvent = (
    entry: Record<string, unknown>,
    properties: Record<string, unknown> = {},
  ) => ({
    event: WEB_ANALYTICS_EVENTS.exception,
    properties: { ...properties, $exception_list: [entry] },
  });

  test.each([
    ["no desktop app", { type: "DesktopBridgeUnavailableError", value: "x" }],
    [
      "public law source down",
      { type: "PublicLawUnavailableError", value: "x" },
    ],
    ["signed-out session", { type: "AuthClientError", value: "x" }],
    [
      "a provider failure with setup guidance",
      { type: "ProviderDiagnosticError", value: "x" },
    ],
    [
      "a React removeChild race",
      {
        type: "NotFoundError",
        value:
          "Failed to execute 'removeChild' on 'Node': The node to be removed is not a child of this node.",
      },
    ],
    [
      "a React insertBefore race",
      {
        type: "Error",
        value: "Failed to execute 'insertBefore' on 'Node': x",
      },
    ],
    [
      "a dropped fetch (Chromium)",
      { type: "TypeError", value: "Failed to fetch" },
    ],
    ["a dropped fetch (Safari)", { type: "TypeError", value: "Load failed" }],
    [
      "a dropped fetch (Firefox)",
      {
        type: "TypeError",
        value: "NetworkError when attempting to fetch resource.",
      },
    ],
    [
      "an extension frame",
      {
        type: "TypeError",
        value: "x is undefined",
        stacktrace: {
          frames: [
            { filename: "https://my.stll.app/assets/app.js" },
            { filename: "chrome-extension://abcdef/content.js" },
          ],
        },
      },
    ],
  ])("drops %s as noise", (_label, entry) => {
    expect(isNoiseException(exceptionEvent(entry))).toBe(true);
  });

  test.each([401, 403, 404])("drops an expected %i API answer", (status) => {
    expect(
      isNoiseException(
        exceptionEvent(
          { type: "ApiError", value: "x" },
          { error_status: status },
        ),
      ),
    ).toBe(true);
  });

  test.each([
    ["AuthClientError", undefined],
    ["ApiError", 403],
  ])("keeps a user-visible %s", (type, status) => {
    createPostHogAnalytics({ host: "https://posthog.test", key: "phc_test" });

    const sanitized = initOptions?.before_send({
      event: WEB_ANALYTICS_EVENTS.exception,
      properties: {
        $exception_list: [{ type, value: "private detail" }],
        feature: "auth",
        route_template: "/auth/error",
        user_visible: true,
        ...(status === undefined ? {} : { error_status: status }),
      },
    });

    expect(sanitized?.properties).toMatchObject({
      feature: "auth",
      route_template: "/auth/error",
      user_visible: true,
    });
  });

  test.each([
    "ai_config_provider_validation_failed",
    ...Object.values(PROVIDER_SETUP_ERROR_CODE),
    CHAT_CONTINUATION_REJECTED_ERROR_CODE,
    API_FILE_SECURITY_REJECTED_ERROR_CODE,
  ])("drops the expected API outcome %s", (code) => {
    expect(
      isNoiseException(
        exceptionEvent(
          { type: "ApiError", value: "x" },
          { error_status: 422, error_code: code },
        ),
      ),
    ).toBe(true);
  });

  test.each([
    ["a server error", { type: "ApiError", value: "x" }, { error_status: 500 }],
    ["another 4xx", { type: "ApiError", value: "x" }, { error_status: 409 }],
    [
      "a 404 a viewer boundary caught",
      { type: "ClientTelemetryError", value: "x" },
      { error_status: 404 },
    ],
    [
      "a TypeError of ours",
      { type: "TypeError", value: "x is not a function" },
      {},
    ],
    [
      "a fetch failure with more context",
      {
        type: "TypeError",
        value: "Failed to fetch dynamically imported module: /a.js",
      },
      {},
    ],
  ])("keeps %s", (_label, entry, properties) => {
    expect(isNoiseException(exceptionEvent(entry, properties))).toBe(false);
  });

  test("identifies a DOM exception by its error name", () => {
    createPostHogAnalytics({ host: "https://posthog.test", key: "phc_test" });

    const sanitized = initOptions?.before_send({
      event: WEB_ANALYTICS_EVENTS.exception,
      properties: {
        $exception_list: [
          {
            type: "DOMException",
            value: "QuotaExceededError: Smith v Example",
          },
        ],
      },
    });

    expect(sanitized?.properties).toEqual({
      $exception_fingerprint: expect.stringMatching(
        /^\[\["QuotaExceededError"\],"browser:[^"]+","scope:[0-9a-f]+",null,null,\[\]\]$/u,
      ),
      $exception_list: [
        { type: "QuotaExceededError", value: "QuotaExceededError" },
      ],
      $exception_type: "QuotaExceededError",
    });
  });

  test("separates DOM exceptions that differ only by error name", () => {
    createPostHogAnalytics({ host: "https://posthog.test", key: "phc_test" });

    const fingerprintOf = (value: string) =>
      initOptions?.before_send({
        event: WEB_ANALYTICS_EVENTS.exception,
        properties: { $exception_list: [{ type: "DOMException", value }] },
      })?.properties?.["$exception_fingerprint"];

    // A message-less DOM exception carries the bare name as its value.
    expect(fingerprintOf("NetworkError")).toEqual(
      expect.stringMatching(
        /^\[\["NetworkError"\],"browser:[^"]+","scope:[0-9a-f]+",null,null,\[\]\]$/u,
      ),
    );
    expect(fingerprintOf("NotAllowedError: denied")).toEqual(
      expect.stringMatching(
        /^\[\["NotAllowedError"\],"browser:[^"]+","scope:[0-9a-f]+",null,null,\[\]\]$/u,
      ),
    );
    expect(fingerprintOf("NetworkError")).not.toBe(
      fingerprintOf("SecurityError"),
    );
  });

  test("falls back to the class when a DOM exception name is not a symbol", () => {
    createPostHogAnalytics({ host: "https://posthog.test", key: "phc_test" });

    const sanitized = initOptions?.before_send({
      event: WEB_ANALYTICS_EVENTS.exception,
      properties: {
        $exception_list: [
          { type: "DOMException", value: "Client Smith v Example: leaked" },
        ],
      },
    });

    expect(sanitized?.properties).toEqual({
      $exception_fingerprint: expect.stringMatching(
        /^\[\["DOMException"\],"browser:[^"]+","scope:[0-9a-f]+",null,null,\[\]\]$/u,
      ),
      $exception_list: [{ type: "DOMException", value: "DOMException" }],
      $exception_type: "DOMException",
    });
  });

  test("keeps only standard DOM exception names, never a custom one", () => {
    createPostHogAnalytics({ host: "https://posthog.test", key: "phc_test" });

    const typeOf = (value: string) =>
      initOptions?.before_send({
        event: WEB_ANALYTICS_EVENTS.exception,
        properties: { $exception_list: [{ type: "DOMException", value }] },
      })?.properties?.["$exception_type"];

    expect(typeOf("TimeoutError: signal timed out")).toBe("TimeoutError");
    // A constructor-supplied name is free text even when symbol-shaped.
    expect(typeOf("Matter2041Error: leaked")).toBe("DOMException");
    expect(typeOf("SmithVExampleError")).toBe("DOMException");
  });

  test("drops a cancelled request's abort reason as noise", () => {
    createPostHogAnalytics({ host: "https://posthog.test", key: "phc_test" });

    for (const value of [
      "AbortError",
      "AbortError: signal is aborted without reason",
    ]) {
      expect(
        initOptions?.before_send({
          event: WEB_ANALYTICS_EVENTS.exception,
          properties: { $exception_list: [{ type: "DOMException", value }] },
        }),
      ).toBeNull();
    }

    // Other DOM failures keep flowing under their own name.
    expect(
      initOptions?.before_send({
        event: WEB_ANALYTICS_EVENTS.exception,
        properties: {
          $exception_list: [{ type: "DOMException", value: "SecurityError" }],
        },
      })?.properties?.["$exception_type"],
    ).toBe("SecurityError");
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
        $exception_fingerprint: expect.stringMatching(
          /^\[\["UnhandledRejection"\],"browser:[^"]+","scope:[0-9a-f]+",null,null,\[\]\]$/u,
        ),
        $exception_list: [
          { type: "UnhandledRejection", value: "UnhandledRejection" },
        ],
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
        $exception_fingerprint: expect.stringMatching(
          /^\[\["TypeError"\],"browser:[^"]+","scope:[0-9a-f]+",null,null,\[\]\]$/u,
        ),
        $exception_list: [
          {
            type: "TypeError",
            value: "TypeError",
            stacktrace: {
              type: "raw",
              frames: [
                {
                  platform: "web:javascript",
                  function: UNKNOWN_FRAME_FUNCTION,
                  in_app: true,
                  filename: "app.js",
                  lineno: 42,
                },
              ],
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
        value: "TypeError",
        stacktrace: {
          type: "raw",
          frames: [
            {
              platform: "web:javascript",
              function: UNKNOWN_FRAME_FUNCTION,
              filename: "https://my.stll.app/assets/app.js",
              in_app: true,
              lineno: 42,
              colno: 7,
            },
          ],
        },
      },
    ]);
  });

  // PostHog drops an exception whose raw frame lacks `platform`, `function`
  // or `in_app` ("missing field function"), so no input frame may lose them.
  test.each([
    ["an empty frame", {}],
    ["a non-object frame", "at renderMatter (app.js:1:2)"],
    ["a null frame", null],
    ["a frame without a function", { filename: "app.js", lineno: 3 }],
    [
      "a frame with a named function",
      { function: "renderMatter", filename: "app.js", in_app: false },
    ],
    ["a frame from another platform", { platform: "node:javascript" }],
  ])("a sanitized frame keeps every required field: %s", (_label, frame) => {
    const sanitized = sanitizeFrame(frame);
    expect(sanitized.function).toBe(UNKNOWN_FRAME_FUNCTION);
    expect(typeof sanitized.platform).toBe("string");
    expect(typeof sanitized.in_app).toBe("boolean");
  });

  test("a sanitized frame never carries the function name", () => {
    expect(
      sanitizeFrame({ function: "Smith v Example", filename: "app.js" }),
    ).toEqual({
      platform: "web:javascript",
      function: UNKNOWN_FRAME_FUNCTION,
      in_app: true,
      filename: "app.js",
    });
  });

  // The tracker finds an uploaded source map only through the chunk id the
  // release build injected; without it, frames stay minified.
  test("a sanitized frame keeps the injected chunk id and nothing shaped otherwise", () => {
    const chunkId = "0199f2a4-5d1e-7c3a-9b2f-1e4d5c6b7a80";
    expect(
      sanitizeFrame({ filename: "app.js", lineno: 3, chunk_id: chunkId }),
    ).toMatchObject({ chunk_id: chunkId });
    expect(
      sanitizeFrame({ filename: "app.js", chunk_id: "Smith v Example" }),
    ).not.toHaveProperty("chunk_id");
    expect(
      sanitizeFrame({ filename: "app.js", chunk_id: 7 }),
    ).not.toHaveProperty("chunk_id");
  });

  test("an exception carries its session and route template, never the resolved URL", () => {
    const { analytics } = createPostHogAnalytics({
      host: "https://posthog.test",
      key: "phc_test",
    });
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: new URL("https://app.example.test/law/cze/cases/nss/a-1"),
    });
    analytics.capturePageViewed({ path: "/law/$country/cases/$court/$slug" });

    const exception = (url: string) =>
      initOptions?.before_send({
        event: WEB_ANALYTICS_EVENTS.exception,
        properties: {
          $current_url: url,
          $session_id: "session-1",
          $window_id: "window-1",
          $exception_list: [{ type: "TypeError", value: "secret" }],
        },
      })?.properties;

    expect(
      exception("https://app.example.test/law/cze/cases/nss/a-1?q=secret"),
    ).toMatchObject({
      $session_id: "session-1",
      $window_id: "window-1",
      $current_url: "https://app.example.test/law/$country/cases/$court/$slug",
      $pathname: "/law/$country/cases/$court/$slug",
    });
    const unknown = exception("https://app.example.test/workspaces/ws_1");
    expect(unknown).toMatchObject({ $session_id: "session-1" });
    expect(unknown).not.toHaveProperty("$current_url");
    expect(unknown).not.toHaveProperty("$pathname");
  });

  test("placement gaps are a counted event, not an exception", () => {
    const { analytics } = createPostHogAnalytics({
      host: "https://posthog.test",
      key: "phc_test",
    });

    analytics.captureProvisionPlacementGaps({
      surface: "full-reader",
      kind: "expected",
      reason: "work-unresolved",
      count: 3,
    });

    expect(captureMock).toHaveBeenCalledWith(
      WEB_ANALYTICS_EVENTS.provisionPlacementGaps,
      {
        surface: "full-reader",
        kind: "expected",
        reason: "work-unresolved",
        count: 3,
      },
    );
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  test("key action timings send the action, surface and bucket only", () => {
    const { analytics } = createPostHogAnalytics({
      host: "https://posthog.test",
      key: "phc_test",
    });

    analytics.captureKeyActionTiming({
      action: "search-results",
      durationBucketMs: 750,
      surface: "case-law",
    });

    expect(captureMock).toHaveBeenCalledWith(
      WEB_ANALYTICS_EVENTS.keyActionTimed,
      { action: "search-results", durationBucketMs: 750, surface: "case-law" },
    );
    expect(
      initOptions?.before_send({
        event: WEB_ANALYTICS_EVENTS.keyActionTimed,
        properties: {
          action: "search-results",
          durationBucketMs: 750,
          surface: "case-law",
          title: "Client Smith v Example",
        },
      })?.properties,
    ).toEqual({
      action: "search-results",
      durationBucketMs: 750,
      surface: "case-law",
    });
  });

  test("captureError ignores null and undefined", () => {
    const { analytics } = createPostHogAnalytics({
      host: "https://posthog.test",
      key: "phc_test",
    });
    analytics.captureError(null, {
      fingerprintKey: "posthog:failure",
      scope: { type: "handler", handlerId: "posthog:failure" },
    });
    analytics.captureError(undefined, {
      fingerprintKey: "posthog:undefined",
      scope: { type: "handler", handlerId: "posthog:undefined" },
    });
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
    analytics.captureError(error, {
      fingerprintKey: "posthog:failure-2",
      scope: { type: "handler", handlerId: "posthog:failure-2" },
    });

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

  // During SSR the adapter runs on Bun: the real throw site, not the
  // reporting path the SDK would synthesize, has to reach error tracking.
  test("captureError on the server keeps app-relative frames", () => {
    const { analytics } = createPostHogAnalytics({
      host: "https://posthog.test",
      key: "phc_test",
    });
    const error = new TypeError("Privileged document name");
    error.stack = [
      `TypeError: ${error.message}`,
      `    at renderMatter (${process.cwd()}/dist/server/assets/provider-B5cnvp1A.js:728:4)`,
    ].join("\n");
    analytics.captureError(error, {
      fingerprintKey: "posthog:ssr-frame",
      scope: { type: "handler", handlerId: "posthog:ssr-frame" },
    });

    const captured = captureExceptionMock.mock.calls.at(-1)?.[0];
    if (!(captured instanceof Error)) {
      throw new TypeError("Expected a redacted Error");
    }
    expect(captured.stack).toBe(
      [
        "TypeError:",
        "    at renderMatter (dist/server/assets/provider-B5cnvp1A.js:728:4)",
      ].join("\n"),
    );
  });

  test("captureError on the server strips directories from dot-segment frames", () => {
    const { analytics } = createPostHogAnalytics({
      host: "https://posthog.test",
      key: "phc_test",
    });
    const error = new TypeError("Privileged document name");
    error.stack = [
      `TypeError: ${error.message}`,
      `    at renderMatter (${process.cwd()}/../private-client/render.tsx?token=private#client:10:15)`,
    ].join("\n");
    analytics.captureError(error, {
      fingerprintKey: "posthog:ssr-dot-segment",
      scope: { type: "handler", handlerId: "posthog:ssr-dot-segment" },
    });

    const captured = captureExceptionMock.mock.calls.at(-1)?.[0];
    if (!(captured instanceof Error)) {
      throw new TypeError("Expected a redacted Error");
    }
    expect(captured.stack).toBe(
      ["TypeError:", "    at renderMatter (render.tsx:10:15)"].join("\n"),
    );
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
          runtime: BROWSER_RUNTIME,
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
        runtime: BROWSER_RUNTIME,
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
          runtime: BROWSER_RUNTIME,
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
        runtime: BROWSER_RUNTIME,
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
          runtime: BROWSER_RUNTIME,
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
          runtime: BROWSER_RUNTIME,
          stack: frame,
          syntax: frame.startsWith("    at ") ? "v8" : "callsite",
        }),
      ).toBeUndefined();
    },
  );

  // Bun reports SSR frames as file paths, which a browser never does.
  const SERVER_RUNTIME = { type: "server", root: "/app/apps/web" } as const;
  const SERVER_FRAMES = {
    serverChunk: {
      frame:
        "    at renderMatter (/app/apps/web/dist/server/assets/provider-B5cnvp1A.js:728:4)",
      safeFrame:
        "    at renderMatter (dist/server/assets/provider-B5cnvp1A.js:728:4)",
    },
    anonymousServerEntry: {
      frame: "    at /app/apps/web/dist/server/server.js:21:27",
      safeFrame: "    at dist/server/server.js:21:27",
    },
    dependency: {
      frame:
        "    at renderElement (/app/node_modules/.bun/react-dom@19.3.0/node_modules/react-dom/cjs/react-dom-server.bun.production.js:6523:46)",
      safeFrame:
        "    at renderElement (react-dom-server.bun.production.js:6523:46)",
    },
    outsideAppRoot: {
      frame:
        "    at renderMatter (/srv/checkout-client-smith/stella/apps/web/src/routes/matter.tsx:10:15)",
      safeFrame: "    at renderMatter (matter.tsx:10:15)",
    },
    aboveAppRoot: {
      frame:
        "    at renderMatter (/app/apps/web/../private-client/render.tsx:10:15)",
      safeFrame: "    at renderMatter (render.tsx:10:15)",
    },
    insideDotSegment: {
      frame:
        "    at renderMatter (/app/apps/web/src/./private-client/render.tsx:10:15)",
      safeFrame: "    at renderMatter (render.tsx:10:15)",
    },
    query: {
      frame:
        "    at renderMatter (/app/apps/web/src/routes/matter.tsx?matter=private#client:10:15)",
      safeFrame: "    at renderMatter (src/routes/matter.tsx:10:15)",
    },
  } as const;

  test.each(Object.entries(SERVER_FRAMES))(
    "server stack redaction keeps %s frames without the path above the app root",
    (_kind, { frame, safeFrame }) => {
      const stack = ["Panic: Privileged document name", frame].join("\n");
      expect(
        redactTelemetryStack({
          errorType: "Panic",
          runtime: SERVER_RUNTIME,
          stack,
          syntax: "v8",
        }),
      ).toBe(["Panic:", safeFrame].join("\n"));
      expect(
        redactTelemetryStack({
          errorType: "Panic",
          runtime: BROWSER_RUNTIME,
          stack,
          syntax: "v8",
        }),
      ).toBeUndefined();
    },
  );

  test("server dot-segment frames retain only the basename", () => {
    assertProperty(
      "server dot-segment frames retain only the basename",
      fc.property(
        fc.array(fc.constantFrom("src", "routes", "dist", "server")),
        fc.constantFrom(".", ".."),
        fc.array(fc.constantFrom("private-client", "private-matter")),
        fc.constantFrom("render.tsx", "provider-B5cnvp1A.js"),
        fc.constantFrom(
          "",
          "?token=private",
          "#client",
          "?token=private#client",
        ),
        fc.constantFrom("v8", "callsite"),
        (
          directories,
          dotSegment,
          privateDirectories,
          basename,
          metadata,
          syntax,
        ) => {
          const file = [
            SERVER_RUNTIME.root,
            ...directories,
            dotSegment,
            "private-client",
            ...privateDirectories,
            basename,
          ].join("/");
          const frame =
            syntax === "v8"
              ? `    at renderMatter (${file}${metadata}:10:15)`
              : `renderMatter@${file}${metadata}:10:15`;
          const stack =
            syntax === "v8"
              ? ["TypeError: Privileged document name", frame].join("\n")
              : frame;
          const safeFrame =
            syntax === "v8"
              ? `    at renderMatter (${basename}:10:15)`
              : `renderMatter@${basename}:10:15`;
          expect(
            redactTelemetryStack({
              errorType: "TypeError",
              runtime: SERVER_RUNTIME,
              stack,
              syntax,
            }),
          ).toBe(["TypeError:", safeFrame].join("\n"));
          expect(
            redactTelemetryStack({
              errorType: "TypeError",
              runtime: BROWSER_RUNTIME,
              stack,
              syntax,
            }),
          ).toBeUndefined();
        },
      ),
    );
  });

  test("server stack redaction still drops locations that are not files or web URLs", () => {
    expect(
      redactTelemetryStack({
        errorType: "Error",
        runtime: SERVER_RUNTIME,
        stack: [
          "Error: Privileged document name",
          "    at processTicksAndRejections (native:7:39)",
          "    at renderMatter (data:text/javascript,throw%20new%20Error(%22PrivilegedMatterName%22):1:1)",
        ].join("\n"),
        syntax: "v8",
      }),
    ).toBeUndefined();
  });

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

    analytics.captureError(error, {
      fingerprintKey: "posthog:failure-3",
      scope: { type: "handler", handlerId: "posthog:failure-3" },
    });

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

    analytics.captureError(error, {
      fingerprintKey: "posthog:failure-4",
      scope: { type: "handler", handlerId: "posthog:failure-4" },
    });

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

    analytics.captureError(error, {
      fingerprintKey: "posthog:failure-5",
      scope: { type: "handler", handlerId: "posthog:failure-5" },
    });

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

    analytics.captureError(error, {
      fingerprintKey: "posthog:failure-6",
      scope: { type: "handler", handlerId: "posthog:failure-6" },
    });

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

    analytics.captureError(error, {
      fingerprintKey: "posthog:failure-7",
      scope: { type: "handler", handlerId: "posthog:failure-7" },
    });

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

    analytics.captureError(error, {
      fingerprintKey: "posthog:failure-8",
      scope: { type: "handler", handlerId: "posthog:failure-8" },
    });

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
    analytics.captureError(second, {
      fingerprintKey: "posthog:second",
      scope: { type: "handler", handlerId: "posthog:second" },
    });
    expect(captureExceptionMock.mock.calls.at(-1)?.[0]).toBeInstanceOf(Error);
  });

  test("drops every frame function name", () => {
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
                {
                  filename: "app.js",
                  function: "jana_novakova",
                  lineno: 1,
                },
                { filename: "app.js", function: "renderMatter2", lineno: 2 },
              ],
            },
          },
        ],
      },
    });

    expect(sanitized?.properties?.["$exception_list"]).toEqual([
      {
        type: "TypeError",
        value: "TypeError",
        stacktrace: {
          type: "raw",
          frames: [
            {
              platform: "web:javascript",
              function: UNKNOWN_FRAME_FUNCTION,
              in_app: true,
              filename: "app.js",
              lineno: 1,
            },
            {
              platform: "web:javascript",
              function: UNKNOWN_FRAME_FUNCTION,
              in_app: true,
              filename: "app.js",
              lineno: 2,
            },
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
    analytics.captureError(wrapper, {
      fingerprintKey: "posthog:wrapper",
      scope: { type: "handler", handlerId: "posthog:wrapper" },
    });

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
    analytics.captureError(boundaryError, {
      fingerprintKey: "posthog:boundaryError",
      scope: { type: "handler", handlerId: "posthog:boundaryError" },
    });
    expect(captureExceptionMock.mock.calls.at(-1)?.[1]).toEqual({
      area: "pdf-viewer",
      exception_scope: expect.stringMatching(/^scope:[0-9a-f]+$/u),
      exception_key: "posthog:boundaryError",
      exception_error_types: ["Error"],
      exception_fields: {},
    });

    const freeFormError = new Error("Privileged message");
    Object.assign(freeFormError, { area: "Client Smith v Example" });
    analytics.captureError(freeFormError, {
      fingerprintKey: "posthog:freeFormError",
      scope: { type: "handler", handlerId: "posthog:freeFormError" },
    });
    expect(captureExceptionMock.mock.calls.at(-1)?.[1]).toEqual({
      exception_scope: expect.stringMatching(/^scope:[0-9a-f]+$/u),
      exception_key: "posthog:freeFormError",
      exception_error_types: ["Error"],
      exception_fields: {},
    });
  });

  test("capture and sanitizer retain only the explicit failed-read diagnostic", () => {
    const { analytics } = createPostHogAnalytics({
      host: "https://posthog.test",
      key: "phc_test",
    });
    class MetadataError extends Error {
      override readonly name = "MetadataError";
      static readonly stellaExceptionFingerprintFields = new Proxy(["reason"], {
        get: () => {
          throw new TypeError("unreadable metadata");
        },
      });
    }
    analytics.captureError(new MetadataError("private metadata sentinel"), {
      fingerprintKey: "posthog:metadata",
      scope: { type: "handler", handlerId: "posthog:metadata" },
    });
    expect(captureExceptionMock.mock.calls.at(-1)?.[1]).toMatchObject({
      exception_error_types: ["MetadataError"],
      exception_identity_status: "read_failed",
    });
    for (const status of ["read_failed", "private metadata sentinel"]) {
      const sanitized = initOptions?.before_send({
        event: WEB_ANALYTICS_EVENTS.exception,
        properties: { exception_identity_status: status },
      });
      expect(sanitized?.properties?.["exception_identity_status"]).toBe(
        status === "read_failed" ? status : undefined,
      );
    }
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

  test("automatic TypeErrors retain their crash path across rebuilds", () => {
    createPostHogAnalytics({ host: "https://posthog.test", key: "phc_test" });
    const fingerprint = ({
      asset,
      line,
      message,
    }: {
      asset: string;
      line: number;
      message: string;
    }) =>
      initOptions?.before_send({
        event: WEB_ANALYTICS_EVENTS.exception,
        properties: {
          $exception_list: [
            {
              type: "TypeError",
              value: message,
              stacktrace: {
                frames: [
                  {
                    in_app: true,
                    filename: new URL(
                      `/assets/${asset}.js`,
                      env.VITE_PUBLIC_APP_URL,
                    ).toString(),
                    lineno: line,
                    colno: 51,
                  },
                ],
              },
            },
          ],
        },
      })?.properties?.["$exception_fingerprint"];
    const before = {
      asset: "chat-runtime-D3kfQx9a",
      line: 766,
      message: 'Cannot read "private value" at 123',
    };
    const original = fingerprint(before);
    expect(typeof original).toBe("string");
    expect(
      fingerprint({ ...before, asset: "document-panel-D3kfQx9a" }),
    ).not.toBe(original);
    expect(
      fingerprint({ ...before, message: "Cannot convert object to primitive" }),
    ).not.toBe(original);
    expect(
      fingerprint({
        ...before,
        asset: "chat-runtime-Ck2pW7dm",
        line: 767,
        message: 'Cannot read "other private value" at 987',
      }),
    ).toBe(original);
    expect(original).not.toContain("private");
  });

  test("fingerprints automatic exceptions without sending readable message content", () => {
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
                  filename: new URL(
                    "/assets/matter-view-D3kfQx9a.js?token=phx_9f3b2c&email=jana.novakova@example.com",
                    env.VITE_PUBLIC_APP_URL,
                  ).toString(),
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
    expect(fingerprint).toEqual(
      expect.stringMatching(
        /^\[\["ClientTelemetryError","RangeError"\],"browser:[^"]+","scope:[0-9a-f]+",null,null,\[\]\]$/u,
      ),
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
                    filename: new URL(
                      "/assets/document-panel-Ck2pW7dm.js",
                      env.VITE_PUBLIC_APP_URL,
                    ).toString(),
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
      fingerprintKey: "posthog:TypeError",
      scope: { type: "handler", handlerId: "posthog:TypeError" },
      context: {
        type: "recovery",
        reference: "ERR-DEAD-BEEF-1234",
      },
    });

    expect(captureExceptionMock.mock.calls.at(-1)?.[1]).toEqual({
      error_reference: "ERR-DEAD-BEEF-1234",
      exception_scope: expect.stringMatching(/^scope:[0-9a-f]+$/u),
      exception_key: "posthog:TypeError",
      exception_error_types: ["TypeError"],
      exception_fields: {},
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
        $exception_fingerprint: expect.stringMatching(
          /^\[\["TypeError"\],"browser:[^"]+","scope:[0-9a-f]+",null,null,\[\]\]$/u,
        ),
        $exception_list: [
          {
            type: "TypeError",
            value: "TypeError",
            stacktrace: {
              type: "raw",
              frames: [
                {
                  platform: "web:javascript",
                  function: UNKNOWN_FRAME_FUNCTION,
                  in_app: true,
                  filename: "https://my.stll.app/assets/app.js",
                },
              ],
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
        $exception_fingerprint: expect.stringMatching(
          /^\[\["TypeError"\],"browser:[^"]+","scope:[0-9a-f]+",null,null,\[\]\]$/u,
        ),
        $exception_list: [{ type: "TypeError", value: "TypeError" }],
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
        $exception_fingerprint: expect.stringMatching(
          /^\[\["TypeError"\],"browser:[^"]+","scope:[0-9a-f]+",null,null,\[\]\]$/u,
        ),
        $exception_list: [{ type: "TypeError", value: "TypeError" }],
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

  const newAdapter = () =>
    createPostHogAnalytics({ host: "https://posthog.test", key: "phc_test" })
      .analytics;

  // A new page load: persistence is off, so it starts anonymous.
  const pageLoad = (anonymousId: string) => {
    distinctId = anonymousId;
    identified = false;
    return newAdapter();
  };

  test("a page load that already holds a session sends one identify", () => {
    const analytics = pageLoad("anonymous_load_1");

    analytics.identifyUser({ id: "user_123", activeOrganizationId: "org_1" });

    expect(identifyEvents).toEqual([
      {
        distinctId: "user_123",
        anonymousId: signedInAnonymousId("user_123"),
      },
    ]);
    expect(isIdentifiedMock()).toBe(true);
    expect(groupMock).toHaveBeenCalledWith("organization", "org_1");
    // Only the opaque id is sent: no person properties.
    expect(identifyMock).toHaveBeenCalledWith("user_123");
  });

  test("an in-app sign-in links the signed-out pages of the same load", () => {
    const analytics = pageLoad("anonymous_load_1");

    analytics.reset({ onlyIfIdentified: true });
    analytics.identifyUser({ id: "user_123", activeOrganizationId: "org_1" });

    expect(resetMock).not.toHaveBeenCalled();
    expect(identifyEvents).toEqual([
      { distinctId: "user_123", anonymousId: "anonymous_load_1" },
    ]);
  });

  test("every page load identifies while a person's distinct ids stay bounded", () => {
    // Twenty loads with a session plus three in-app sign-ins.
    for (let load = 0; load < 23; load += 1) {
      const analytics = pageLoad(`anonymous_load_${String(load)}`);
      if (load % 8 === 0) {
        analytics.reset({ onlyIfIdentified: true });
      }
      analytics.identifyUser({ id: "user_123", activeOrganizationId: "org_1" });
    }

    expect(identifyEvents).toHaveLength(23);
    const linkedAnonymousIds = new Set(
      identifyEvents.map(({ anonymousId }) => anonymousId),
    );
    // One stable id for loads with a session, one per in-app sign-in.
    expect(linkedAnonymousIds).toEqual(
      new Set([
        signedInAnonymousId("user_123"),
        "anonymous_load_0",
        "anonymous_load_8",
        "anonymous_load_16",
      ]),
    );
  });

  test("binds the same user only once per page load", () => {
    const analytics = pageLoad("anonymous_load_1");

    analytics.identifyUser({ id: "user_123", activeOrganizationId: "org_1" });
    analytics.identifyUser({ id: "user_123", activeOrganizationId: "org_1" });

    expect(identifyEvents).toHaveLength(1);
  });

  test("rebinds the organization group on a same-user organization switch", () => {
    const analytics = pageLoad("anonymous_load_1");

    analytics.identifyUser({ id: "user_123", activeOrganizationId: "org_1" });
    analytics.identifyUser({ id: "user_123", activeOrganizationId: "org_2" });

    // The identity guard still suppresses a second bind, but the group must
    // follow the active organization or later events attribute to the
    // previous organization across an ownership boundary.
    expect(identifyEvents).toHaveLength(1);
    expect(groupMock).toHaveBeenNthCalledWith(2, "organization", "org_2");
  });

  test("binds a different user without linking it to the previous one", () => {
    const analytics = pageLoad("anonymous_load_1");

    analytics.identifyUser({ id: "user_123", activeOrganizationId: "org_1" });
    analytics.identifyUser({ id: "user_456", activeOrganizationId: "org_2" });

    expect(identifyEvents).toEqual([
      {
        distinctId: "user_123",
        anonymousId: signedInAnonymousId("user_123"),
      },
      {
        distinctId: "user_456",
        anonymousId: signedInAnonymousId("user_456"),
      },
    ]);
    expect(getDistinctIdMock()).toBe("user_456");
    expect(groupMock).toHaveBeenNthCalledWith(2, "organization", "org_2");
  });

  test("a sign-out then sign-in as another user never links the two", () => {
    const analytics = pageLoad("anonymous_load_1");

    analytics.identifyUser({ id: "user_123", activeOrganizationId: "org_1" });
    analytics.reset();
    analytics.identifyUser({ id: "user_456", activeOrganizationId: "org_2" });

    expect(identifyEvents.map(({ anonymousId }) => anonymousId)).toEqual([
      signedInAnonymousId("user_123"),
      "anonymous_after_reset",
    ]);
  });

  test("every identity change keeps the build metadata on later events", () => {
    const analytics = pageLoad("anonymous_load_1");

    analytics.identifyUser({ id: "user_123", activeOrganizationId: "org_1" });
    analytics.reset();

    // `reset` clears super-properties; each one is followed by a register.
    expect(registerMock).toHaveBeenCalledTimes(3);
    for (const [properties] of registerMock.mock.calls) {
      expect(Object.keys(properties).toSorted()).toEqual([
        "app_commit",
        "app_version",
      ]);
    }
  });

  test("reset can be limited to identified sessions", () => {
    const analytics = pageLoad("anonymous_load_1");

    analytics.reset({ onlyIfIdentified: true });

    expect(resetMock).not.toHaveBeenCalled();

    analytics.identifyUser({ id: "user_123", activeOrganizationId: "org_1" });
    analytics.reset({ onlyIfIdentified: true });

    expect(resetMock).toHaveBeenCalledTimes(1);
    expect(resetMock).toHaveBeenLastCalledWith(undefined);
    expect(isIdentifiedMock()).toBe(false);
  });

  test("reset clears anonymous sessions by default", () => {
    const analytics = pageLoad("anonymous_load_1");

    analytics.reset();

    expect(resetMock).toHaveBeenCalledTimes(1);
  });

  test("reset clears the in-memory identity guard", () => {
    const analytics = pageLoad("anonymous_load_1");

    analytics.identifyUser({ id: "user_123", activeOrganizationId: "org_1" });
    analytics.reset();
    analytics.identifyUser({ id: "user_123", activeOrganizationId: "org_1" });

    expect(identifyEvents).toHaveLength(2);
    expect(getDistinctIdMock()).toBe("user_123");
  });

  test("declared browser owners retain causal and HTTP identity through structural rendering", () => {
    createPostHogAnalytics({ host: "https://posthog.test", key: "phc_test" });
    const sanitize = (overrides: Record<string, unknown> = {}) =>
      initOptions?.before_send({
        event: WEB_ANALYTICS_EVENTS.exception,
        properties: {
          exception_key: "editor.save:failure",
          exception_scope: "scope:1234abcd",
          exception_error_types: ["ClientTelemetryError", "ApiError"],
          area: "pdf-viewer",
          error_status: 502,
          error_code: "upstream_failed",
          $exception_list: [
            { type: "ClientTelemetryError", value: "private document title" },
          ],
          ...overrides,
        },
      });
    const baseline = sanitize();
    const fingerprint = baseline?.properties?.["$exception_fingerprint"];
    expect(typeof fingerprint).toBe("string");
    expect(baseline?.properties?.["$exception_list"]).toEqual([
      {
        type: "ClientTelemetryError",
        value: "ClientTelemetryError[upstream_failed] 502 area=pdf-viewer",
      },
    ]);
    expect(
      sanitize({
        $exception_list: [
          { type: "ClientTelemetryError", value: "another private title" },
        ],
      })?.properties?.["$exception_fingerprint"],
    ).toBe(fingerprint);
    for (const changed of [
      { exception_key: "editor.open:failure" },
      { exception_scope: "scope:5678abcd" },
      { exception_error_types: ["ClientTelemetryError", "TypeError"] },
      { error_status: 503 },
      { error_code: "upstream_timeout" },
    ]) {
      expect(
        sanitize(changed)?.properties?.["$exception_fingerprint"],
      ).not.toBe(fingerprint);
    }
    expect(JSON.stringify(baseline)).not.toContain("private document title");
  });

  test("sanitizer keeps a validated API response identity and groups by it", () => {
    createPostHogAnalytics({ host: "https://posthog.test", key: "phc_test" });

    const sanitized = initOptions?.before_send({
      event: WEB_ANALYTICS_EVENTS.exception,
      properties: {
        $exception_list: [{ type: "ApiError", value: "Conflict" }],
        error_status: 409,
        error_code: "conflict",
      },
    });
    expect(sanitized?.properties?.["$exception_fingerprint"]).toEqual(
      expect.stringMatching(
        /^\[\["ApiError"\],"browser:[^"]+","scope:[0-9a-f]+",409,"conflict",\[\]\]$/u,
      ),
    );
    expect(sanitized?.properties?.["error_status"]).toBe(409);
    expect(sanitized?.properties?.["error_code"]).toBe("conflict");
    expect(sanitized?.properties?.["$exception_list"]).toEqual([
      { type: "ApiError", value: "ApiError[conflict] 409" },
    ]);

    // A free-text code or an out-of-range status never passes through.
    const rejected = initOptions?.before_send({
      event: WEB_ANALYTICS_EVENTS.exception,
      properties: {
        $exception_list: [{ type: "ApiError", value: "" }],
        error_status: 9999,
        error_code: "Client Smith asked for jana.novakova@example.com",
      },
    });
    expect(rejected?.properties?.["$exception_fingerprint"]).toEqual(
      expect.stringMatching(
        /^\[\["ApiError"\],"browser:[^"]+","scope:[0-9a-f]+",null,null,\[\]\]$/u,
      ),
    );
    expect(rejected?.properties).not.toContainKey("error_status");
    expect(rejected?.properties).not.toContainKey("error_code");
  });

  test("exception properties never carry arbitrary message text", () => {
    createPostHogAnalytics({ host: "https://posthog.test", key: "phc_test" });

    assertProperty(
      "exception properties never carry arbitrary message text",
      fc.property(fc.string(), (message) => {
        const privateMessage = `Alex Doe <alex@example.test> document ${JSON.stringify(message)}`;
        const sanitized = initOptions?.before_send({
          event: WEB_ANALYTICS_EVENTS.exception,
          properties: {
            area: "case-law-search",
            $exception_list: [{ type: "ApiError", value: privateMessage }],
            error_status: 502,
            error_code: "model_output_incomplete",
            unknown_field: privateMessage,
          },
        });
        const serialized = JSON.stringify(sanitized?.properties);
        expect(serialized).not.toContain(privateMessage);
        expect(sanitized?.properties?.["$exception_list"]).toEqual([
          {
            type: "ApiError",
            value: "ApiError[model_output_incomplete] 502 area=case-law-search",
          },
        ]);
        expect(sanitized?.properties).not.toContainKey("unknown_field");
      }),
    );
  });

  test("captureError reports the status and code of an API error", () => {
    const { analytics } = createPostHogAnalytics({
      host: "https://posthog.test",
      key: "phc_test",
    });
    analytics.captureError(
      new APIError({
        code: "usage_limit_exceeded",
        message: "Privileged localized text",
        status: 402,
      }),
      {
        fingerprintKey: "posthog:APIError",
        scope: { type: "handler", handlerId: "posthog:APIError" },
      },
    );

    expect(captureExceptionMock.mock.calls.at(-1)?.[1]).toEqual({
      error_code: "usage_limit_exceeded",
      error_status: 402,
      exception_scope: expect.stringMatching(/^scope:[0-9a-f]+$/u),
      exception_key: "posthog:APIError",
      exception_error_types: ["ApiError"],
      exception_fields: {},
    });
  });

  test("captureError finds the API error behind a boundary wrapper", () => {
    const { analytics } = createPostHogAnalytics({
      host: "https://posthog.test",
      key: "phc_test",
    });
    analytics.captureError(
      new ClientTelemetryError({
        area: "pdf-viewer",
        message: "[pdf-viewer] Privileged document name",
        cause: new APIError({
          code: "forbidden",
          message: "Privileged localized text",
          status: 403,
        }),
      }),
      {
        fingerprintKey: "posthog:ClientTelemetryError",
        scope: { type: "handler", handlerId: "posthog:ClientTelemetryError" },
      },
    );

    expect(captureExceptionMock.mock.calls.at(-1)?.[1]).toEqual({
      area: "pdf-viewer",
      exception_scope: expect.stringMatching(/^scope:[0-9a-f]+$/u),
      exception_key: "posthog:ClientTelemetryError",
      exception_error_types: ["ClientTelemetryError", "ApiError"],
      exception_fields: {},
      error_code: "forbidden",
      error_status: 403,
    });
  });

  // Resolved URLs and arbitrary scope objects must never cross the sanitizer.
  test("manual captures use opaque source scope while SDK scope objects are dropped", () => {
    const { analytics } = createPostHogAnalytics({
      host: "https://posthog.test",
      key: "phc_test",
    });
    const error = new TypeError("Private text");
    analytics.captureError(error, {
      fingerprintKey: "scopeTest:request",
      scope: {
        type: "request",
        method: "GET",
        routeTemplate: "/v1/entities/:entityId",
      },
    });
    const first = captureExceptionMock.mock.calls.at(-1)?.[1];
    analytics.captureError(error, {
      fingerprintKey: "scopeTest:request",
      scope: {
        type: "request",
        method: "PATCH",
        routeTemplate: "/v1/entities/:entityId",
      },
    });
    const second = captureExceptionMock.mock.calls.at(-1)?.[1];
    expect(first?.["exception_scope"]).not.toBe(second?.["exception_scope"]);
    expect(JSON.stringify(first)).not.toContain("/v1/entities");
    const sanitized = initOptions?.before_send({
      event: WEB_ANALYTICS_EVENTS.exception,
      properties: {
        $exception_list: [{ type: "TypeError", value: "Private text" }],
        exception_scope: {
          type: "request",
          method: "GET",
          routeTemplate: "/v1/entities/private-entity",
        },
      },
    });
    expect(JSON.stringify(sanitized)).not.toContain("private-entity");
    expect(sanitized?.properties).not.toContainKey("exception_scope");
  });

  test("manual and SDK wrappers retain distinct causal classes after sanitization", () => {
    const { analytics } = createPostHogAnalytics({
      host: "https://posthog.test",
      key: "phc_test",
    });
    const manualIdentities = [];
    const sdkIdentities = [];
    for (const cause of [
      new TypeError("private detail"),
      new ReferenceError("private detail"),
    ]) {
      analytics.captureError(new Error("private wrapper", { cause }), {
        fingerprintKey: "wrapper:test",
        scope: { type: "handler", handlerId: "wrapper.test" },
      });
      const properties = captureExceptionMock.mock.calls.at(-1)?.[1];
      manualIdentities.push(
        initOptions?.before_send({
          event: "$exception",
          properties: {
            ...properties,
            $exception_list: [{ type: "Error", value: "" }],
          },
        })?.properties?.["$exception_fingerprint"],
      );
      sdkIdentities.push(
        initOptions?.before_send({
          event: "$exception",
          properties: {
            $exception_list: [
              { type: "Error", value: "" },
              { type: cause.name, value: "" },
            ],
          },
        })?.properties?.["$exception_fingerprint"],
      );
    }
    expect(new Set(manualIdentities).size).toBe(manualIdentities.length);
    expect(new Set(sdkIdentities).size).toBe(sdkIdentities.length);
  });

  test("manual causal classes never read beyond the shared depth bound", () => {
    createPostHogAnalytics({ host: "https://posthog.test", key: "phc_test" });
    const classes = Array.from(
      { length: MAX_EXCEPTION_CAUSE_DEPTH },
      (_, index) => `CapturedError${index}`,
    );
    const causalTypes = [...classes];
    Object.defineProperty(causalTypes, MAX_EXCEPTION_CAUSE_DEPTH, {
      get: () => {
        throw new Error("private tail");
      },
    });
    const sanitized = initOptions?.before_send({
      event: WEB_ANALYTICS_EVENTS.exception,
      properties: {
        $exception_list: [{ type: "Error", value: "" }],
        exception_key: "bounded:classes",
        exception_error_types: causalTypes,
        private_property: "private content",
      },
    });
    expect(sanitized).not.toBeNull();
    expect(sanitized?.properties?.["$exception_fingerprint"]).toStartWith(
      `[${JSON.stringify(classes)},`,
    );
    expect(sanitized?.properties).not.toContainKey("exception_error_types");
    expect(sanitized?.properties).not.toContainKey("private_property");
  });
});
