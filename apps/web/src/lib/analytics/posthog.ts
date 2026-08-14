import { CancelledError } from "@tanstack/react-query";
import { posthog } from "posthog-js";
import type { CaptureResult, SupportedWebVitalsMetrics } from "posthog-js";

import { env } from "@/env";
import {
  normalizeTelemetryErrorTypeName,
  telemetryErrorType,
} from "@/lib/analytics/error-diagnostics";
import { isErrorReference } from "@/lib/analytics/error-reference";
import { pickIngestionRequired } from "@/lib/analytics/posthog-ingestion";
import type { sanitizeRouteErrorLifecycleEvent } from "@/lib/analytics/posthog-route-error";
import { WEB_ANALYTICS_EVENTS } from "@/lib/analytics/types";
import type {
  Analytics,
  ErrorCaptureContext,
  WebAnalyticsEvent,
} from "@/lib/analytics/types";
import { logDevError } from "@/lib/errors/utils";

const isWebAnalyticsEvent = (event: string): event is WebAnalyticsEvent =>
  Object.values(WEB_ANALYTICS_EVENTS).some((value) => value === event);

// Browser-noise patterns we drop client-side before they hit
// PostHog ingest. PostHog has no built-in `ignoreErrors` analogue
// to Sentry's, so the canonical filter point is `before_send`.
//
// - `ResizeObserver loop ...`: benign Chromium/Firefox quirk that
//   fires when a ResizeObserver callback queues another resize.
// - `Script error.`: W3C-mandated cross-origin sanitization with
//   no payload — not actionable.
// - Empty / `undefined` rejection values: produced by
//   `capture_unhandled_rejections: true` catching a
//   `Promise.reject()` that carries no reason. No stack, no
//   message — filtering loses zero debuggable signal.
const EXCEPTION_NOISE_PATTERNS: readonly RegExp[] = [
  /^ResizeObserver loop/iu,
  /^Script error\.?$/iu,
  /^(?:Error: )?undefined$/iu,
  // Match only the empty form, not rejections that carry a useful
  // string (e.g. `Promise.reject("API_TIMEOUT")`) which we want to
  // keep capturing.
  /^Non-Error promise rejection captured with value: (?:undefined|null)$/iu,
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const readStringField = (entry: unknown, key: string): string => {
  if (!isRecord(entry)) {
    return "";
  }
  const value = entry[key];
  return typeof value === "string" ? value : "";
};

const isNoiseException = (event: {
  properties?: Record<string, unknown>;
}): boolean => {
  const list = event.properties?.["$exception_list"];
  if (!Array.isArray(list) || list.length === 0) {
    return false;
  }
  const entries: unknown[] = list;
  return entries.some((entry) => {
    const value = readStringField(entry, "value");
    const type = readStringField(entry, "type");
    return EXCEPTION_NOISE_PATTERNS.some(
      (pattern) => pattern.test(value) || pattern.test(type),
    );
  });
};

// Telemetry areas are fixed subsystem slugs declared at error boundaries
// (`ClientTelemetryError.area`). The pattern rejects anything free-form so
// no dynamic string can ride along.
const TELEMETRY_AREA = /^[a-z][a-z0-9-]{0,39}$/u;

const telemetryAreaProperty = (
  error: unknown,
): Record<string, string> | undefined => {
  if (!isRecord(error)) {
    return undefined;
  }
  const area = error["area"];
  return typeof area === "string" && TELEMETRY_AREA.test(area)
    ? { area }
    : undefined;
};

// The deepest error in a `cause` chain carries the stack of the original
// failure site; wrapper classes (boundary telemetry errors) only record
// where they were constructed. `cause` is writable, so third-party code can
// hand us a cycle; the visited set bounds the walk.
const deepestCause = (error: Error): Error => {
  let current = error;
  const seen = new Set<Error>([error]);
  while (current.cause instanceof Error && !seen.has(current.cause)) {
    current = current.cause;
    seen.add(current);
  }
  return current;
};

// A V8 stack begins with `<name>: <message>`; the message can carry PII, so
// keep only the frame lines (`    at …`), which name bundled assets and
// minified symbols but never user content.
const redactedStack = (error: Error): string | undefined => {
  const { stack } = deepestCause(error);
  if (typeof stack !== "string") {
    return undefined;
  }
  const frames = stack.split("\n").filter((line) => /^\s+at /u.test(line));
  if (frames.length === 0) {
    return undefined;
  }
  return [`${telemetryErrorType(error)}:`, ...frames].join("\n");
};

const toRedactedTelemetryError = (error: unknown): Error => {
  // eslint-disable-next-line unicorn/error-message -- the original message is intentionally dropped so telemetry cannot leak PII from the underlying error; the error class is carried in `.name` instead.
  const redacted = new Error("");
  redacted.name = telemetryErrorType(error);
  const stack = error instanceof Error ? redactedStack(error) : undefined;
  if (stack === undefined) {
    Reflect.deleteProperty(redacted, "stack");
  } else {
    redacted.stack = stack;
  }
  return redacted;
};

// Structural frame fields only: code locations and symbol names from the
// deployed bundle. Free-text fields (context lines, local variables) never
// pass through.
type SanitizedFrame = {
  platform?: string;
  filename?: string;
  function?: string;
  in_app?: boolean;
  lineno?: number;
  colno?: number;
};

// Symbol-shaped frame function names only. V8 embeds computed property keys
// verbatim in stacks (`at Client Smith (…)`), so anything with whitespace or
// beyond identifier punctuation is treated as untrusted and dropped.
const FRAME_SYMBOL = /^[\w$.<>[\]#~]{1,120}$/u;

const stripQuery = (url: string): string => {
  const queryIndex = url.indexOf("?");
  return queryIndex === -1 ? url : url.slice(0, queryIndex);
};

const sanitizeFrame = (frame: unknown): SanitizedFrame => {
  if (!isRecord(frame)) {
    return {};
  }
  const filename = frame["filename"];
  const functionName = frame["function"];
  const platform = frame["platform"];
  const inApp = frame["in_app"];
  const lineno = frame["lineno"];
  const colno = frame["colno"];
  return {
    ...(typeof platform === "string" ? { platform } : {}),
    // Query strings on asset URLs can carry tokens; keep only the path.
    ...(typeof filename === "string" ? { filename: stripQuery(filename) } : {}),
    ...(typeof functionName === "string" && FRAME_SYMBOL.test(functionName)
      ? { function: functionName }
      : {}),
    ...(typeof inApp === "boolean" ? { in_app: inApp } : {}),
    ...(typeof lineno === "number" ? { lineno } : {}),
    ...(typeof colno === "number" ? { colno } : {}),
  };
};

const sanitizeExceptionEntry = (entry: unknown) => {
  const type = normalizeTelemetryErrorTypeName(readStringField(entry, "type"));
  const stacktrace = isRecord(entry) ? entry["stacktrace"] : undefined;
  const frames = isRecord(stacktrace) ? stacktrace["frames"] : undefined;
  return {
    type,
    value: "",
    ...(Array.isArray(frames)
      ? { stacktrace: { type: "raw", frames: frames.map(sanitizeFrame) } }
      : {}),
  };
};

const sanitizeExceptionEvent = (event: CaptureResult): CaptureResult => {
  const properties: Record<string, unknown> = event.properties;
  const appCommit = properties["app_commit"];
  const appVersion = properties["app_version"];
  const area = properties["area"];
  const errorReference = properties["error_reference"];
  const exceptionList = properties["$exception_list"];
  const entries: unknown[] = Array.isArray(exceptionList) ? exceptionList : [];
  const sanitizedList =
    entries.length > 0
      ? entries.map(sanitizeExceptionEntry)
      : [sanitizeExceptionEntry(undefined)];
  const type = sanitizedList.at(0)?.type ?? normalizeTelemetryErrorTypeName("");
  return {
    ...event,
    properties: {
      ...pickIngestionRequired(properties),
      $exception_list: sanitizedList,
      $exception_type: type,
      ...(typeof appCommit === "string" ? { app_commit: appCommit } : {}),
      ...(typeof appVersion === "string" ? { app_version: appVersion } : {}),
      ...(typeof area === "string" && TELEMETRY_AREA.test(area)
        ? { area }
        : {}),
      ...(isErrorReference(errorReference)
        ? { error_reference: errorReference }
        : {}),
    },
  };
};

type RouteErrorLifecycleSanitizer = typeof sanitizeRouteErrorLifecycleEvent;
let routeErrorLifecycleSanitizer: RouteErrorLifecycleSanitizer | undefined;

// The SDK stamps `$web_vitals` events with the resolved URL, which can
// carry resource ids. `capturePageViewed` records the matched route
// template here so the sanitizer can substitute it; until the first page
// view lands the URL fields are dropped rather than leaked.
let lastPageViewPath: string | null = null;

// Value keys per metric, total over the SDK's metric union so a new
// metric cannot land without a decision here.
const WEB_VITALS_VALUE_KEYS = {
  CLS: "$web_vitals_CLS_value",
  FCP: "$web_vitals_FCP_value",
  INP: "$web_vitals_INP_value",
  LCP: "$web_vitals_LCP_value",
} as const satisfies Record<SupportedWebVitalsMetrics, string>;

// Coarse client context worth keeping on web vitals: device/viewport
// slicing without URLs, element attribution, or user content.
const WEB_VITALS_CONTEXT_KEYS = [
  "$session_id",
  "$window_id",
  "$browser",
  "$browser_version",
  "$os",
  "$device_type",
  "$viewport_height",
  "$viewport_width",
] as const;

/**
 * Rebuild a `$web_vitals` payload from an allowlist: metric values plus
 * coarse client context. The SDK's per-metric `$web_vitals_*_event`
 * objects (element attribution, resolved URLs) never pass through, and
 * the URL fields are replaced with the last captured route template.
 */
const sanitizeWebVitalsEvent = (event: CaptureResult): CaptureResult | null => {
  const properties: Record<string, unknown> = event.properties;
  const metricValues = Object.fromEntries(
    Object.values(WEB_VITALS_VALUE_KEYS)
      .filter((key) => typeof properties[key] === "number")
      .map((key) => [key, properties[key]]),
  );
  if (Object.keys(metricValues).length === 0) {
    return null;
  }
  const context = Object.fromEntries(
    WEB_VITALS_CONTEXT_KEYS.filter((key) => key in properties).map((key) => [
      key,
      properties[key],
    ]),
  );
  const appCommit = properties["app_commit"];
  const appVersion = properties["app_version"];
  const hasLocation = "location" in globalThis;
  return {
    ...event,
    properties: {
      ...pickIngestionRequired(properties),
      ...metricValues,
      ...context,
      ...(typeof appCommit === "string" ? { app_commit: appCommit } : {}),
      ...(typeof appVersion === "string" ? { app_version: appVersion } : {}),
      ...(lastPageViewPath === null
        ? {}
        : {
            ...(hasLocation
              ? {
                  $current_url: `${globalThis.location.origin}${lastPageViewPath}`,
                }
              : {}),
            $pathname: lastPageViewPath,
          }),
    },
  };
};

const errorContextProperties = (
  context: ErrorCaptureContext | undefined,
): Record<string, string> | undefined => {
  if (context?.type !== "recovery") {
    return undefined;
  }

  return { error_reference: context.reference };
};

const devErrorContext = (
  context: ErrorCaptureContext | undefined,
): Record<string, string> | undefined => {
  if (!context) {
    return undefined;
  }

  switch (context.type) {
    case "detached":
      return { detached: context.operation };
    case "recovery":
      return { error_reference: context.reference };
    default: {
      const exhaustive: never = context;
      return exhaustive;
    }
  }
};

/**
 * Initialize PostHog and return an Analytics adapter.
 *
 * Stella sends only error diagnostics, template-path page views, and web
 * vitals through this adapter. Session replay, heatmaps, autocapture, and
 * remote PostHog feature configuration are structurally disabled here
 * rather than relying on deployment-specific environment settings.
 */
export const createPostHogAnalytics = (
  key: string,
  host: string,
): { analytics: Analytics; client: typeof posthog | undefined } => {
  const localDebugEnabled = import.meta.env.DEV && env.VITE_POSTHOG_LOCAL_DEBUG;
  lastPageViewPath = null;
  const client = posthog.init(key, {
    opt_out_capturing_by_default: import.meta.env.DEV && !localDebugEnabled,
    api_host: host,
    defaults: "2025-05-24",
    advanced_disable_feature_flags: true,
    advanced_disable_flags: true,
    autocapture: false,
    capture_exceptions: {
      capture_console_errors: false,
      capture_unhandled_errors: true,
      capture_unhandled_rejections: true,
    },
    rageclick: false,
    capture_dead_clicks: false,
    disable_persistence: true,
    disable_product_tours: true,
    disable_session_recording: true,
    disable_surveys: true,
    disable_surveys_automatic_display: true,
    disable_web_experiments: true,
    mask_all_text: true,
    mask_personal_data_properties: true,
    person_profiles: "identified_only",
    capture_heatmaps: false,
    capture_performance: { network_timing: false, web_vitals: true },
    capture_pageview: false,
    before_send: (event) => {
      if (import.meta.env.DEV && !localDebugEnabled) {
        return null;
      }
      if (!event || !isWebAnalyticsEvent(event.event)) {
        return null;
      }
      if (
        event.event === WEB_ANALYTICS_EVENTS.exception &&
        isNoiseException(event)
      ) {
        return null;
      }
      if (event.event === WEB_ANALYTICS_EVENTS.exception) {
        return sanitizeExceptionEvent(event);
      }
      if (event.event === WEB_ANALYTICS_EVENTS.routeErrorRecovery) {
        return routeErrorLifecycleSanitizer?.(event) ?? null;
      }
      if (event.event === WEB_ANALYTICS_EVENTS.webVitals) {
        return sanitizeWebVitalsEvent(event);
      }
      return event;
    },
  });

  // Attach build metadata as super-properties so every captured
  // event carries the exact deployed build.
  posthog.register({
    app_commit: __APP_COMMIT_SHA__,
    app_version: __APP_VERSION__,
  });

  const analytics: Analytics = {
    captureError: (error, context) => {
      // Cheap guards before the SDK call: a stray `captureError(null)`
      // or `captureError(undefined)` would otherwise reach PostHog as
      // `Error: "undefined"` noise that the `before_send` filter then
      // has to clean up.
      if (
        error === null ||
        error === undefined ||
        error instanceof CancelledError
      ) {
        return;
      }
      logDevError(error, devErrorContext(context));
      posthog.captureException(toRedactedTelemetryError(error), {
        ...errorContextProperties(context),
        ...telemetryAreaProperty(error),
      });
    },
    capturePageViewed: ({ path }) => {
      // `path` is the matched route template (`/workspaces/$workspaceId`),
      // never a resolved URL. Overriding the SDK's own `$current_url` and
      // `$pathname` with the template keeps resource ids out of analytics
      // while letting web analytics aggregate by page. DOM types claim
      // `location` always exists, but during SSR it does not; the `in` check
      // is the runtime truth the types cannot express.
      const hasLocation = "location" in globalThis;
      lastPageViewPath = path;
      posthog.capture(WEB_ANALYTICS_EVENTS.pageViewed, {
        ...(hasLocation
          ? { $current_url: `${globalThis.location.origin}${path}` }
          : {}),
        $pathname: path,
        path,
      });
    },
    captureGuideStepSkipped: (properties) => {
      posthog.capture(WEB_ANALYTICS_EVENTS.guideStepSkipped, properties);
    },
    captureRouteErrorLifecycle: async (properties) =>
      import("@/lib/analytics/posthog-route-error")
        .then((module) => {
          routeErrorLifecycleSanitizer =
            module.sanitizeRouteErrorLifecycleEvent;
          return module.captureRouteErrorLifecycle(posthog, properties);
        })
        .catch((error: unknown) => {
          analytics.captureError(error, {
            operation: "posthog.route-error-lifecycle",
            type: "detached",
          });
        }),
    identifyUser: (user) => {
      const distinctId = posthog.get_distinct_id();

      if (distinctId === user.id) {
        return;
      }

      if (posthog._isIdentified() && distinctId !== user.id) {
        posthog.reset();
      }

      // Identify by the stable user id only. Profile attributes such as
      // name and email already live server-side keyed by this id, so
      // duplicating them into PostHog person properties adds no analytical
      // value and only widens the person-property surface.
      posthog.identify(user.id);
    },
    reset: ({ onlyIfIdentified } = {}) => {
      if (onlyIfIdentified && !posthog._isIdentified()) {
        return;
      }

      posthog.reset();
    },
  };

  return { analytics, client };
};
