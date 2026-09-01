import { CancelledError } from "@tanstack/react-query";
import { posthog } from "posthog-js";
import type { CaptureResult, SupportedWebVitalsMetrics } from "posthog-js";

import { env } from "@/env";
import {
  normalizeTelemetryErrorTypeName,
  telemetryErrorType,
} from "@/lib/analytics/error-diagnostics";
import { isErrorReference } from "@/lib/analytics/error-reference";
import { fingerprintExceptionEvent } from "@/lib/analytics/exception-fingerprint";
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

// PostHog group type for organization-level analytics; must match the
// server-side capture wrapper's group key.
const ORGANIZATION_GROUP_TYPE = "organization";

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

// Engines disagree on frame syntax: V8 indents frames with `at ` under a
// `<name>: <message>` header, while SpiderMonkey and JavaScriptCore write
// bare `<symbol>@<url>:<line>:<column>` lines and no header at all. Known JSC
// engine labels contain spaces; other callsite labels stay symbol-shaped so
// free-form text cannot ride along as a frame.
const V8_STACK_FRAME_SYNTAX = /^\s+at /u;
const CALLSITE_STACK_FRAME_SYNTAX =
  /^(?:[Aa]sync\*)?(?:[\p{ID_Continue}$.<>[\]#~/]{0,120}|(?:global|module|eval) code)@\S+:\d+:\d+$/u;

const hasOnlyDecimalDigits = (
  value: string,
  start: number,
  end: number,
): boolean => {
  if (start >= end) {
    return false;
  }
  for (let index = start; index < end; index += 1) {
    const code = value.codePointAt(index);
    if (code === undefined || code < 48 || code > 57) {
      return false;
    }
  }
  return true;
};

const stripStackFrameUrlMetadata = (frame: string): string => {
  const frameEnd = frame.endsWith(")") ? frame.length - 1 : frame.length;
  const columnSeparator = frame.lastIndexOf(":", frameEnd - 1);
  const lineSeparator = frame.lastIndexOf(":", columnSeparator - 1);
  if (
    lineSeparator === -1 ||
    !hasOnlyDecimalDigits(frame, lineSeparator + 1, columnSeparator) ||
    !hasOnlyDecimalDigits(frame, columnSeparator + 1, frameEnd)
  ) {
    return frame;
  }

  const v8Prefix = frame.trimStart().startsWith("at ")
    ? frame.indexOf("at ") + 3
    : -1;
  let urlStart = frame.indexOf("@") + 1;
  if (v8Prefix !== -1) {
    const locationSeparator = frame.indexOf(" (", v8Prefix);
    urlStart =
      locationSeparator === -1 || locationSeparator > lineSeparator
        ? v8Prefix
        : locationSeparator + 2;
  }
  let urlEnd = lineSeparator;
  for (const terminator of ["?", "#"] as const) {
    const index = frame.indexOf(terminator, urlStart);
    if (index !== -1 && index < urlEnd) {
      urlEnd = index;
    }
  }
  if (urlEnd === lineSeparator) {
    return frame;
  }
  return `${frame.slice(0, urlEnd)}${frame.slice(lineSeparator)}`;
};

const redactedStack = (error: Error): string | undefined => {
  const source = deepestCause(error);
  const { stack } = source;
  if (typeof stack !== "string") {
    return undefined;
  }
  const lines = stack.split("\n").filter((line) => line.length > 0);
  // Callsite engines start with a bare frame and never mix in V8 frames. V8
  // can serialize an empty name, making its message look like a callsite.
  const hasV8Frames = lines.some((line) => V8_STACK_FRAME_SYNTAX.test(line));
  const frameSyntax =
    !hasV8Frames && CALLSITE_STACK_FRAME_SYNTAX.test(lines.at(0) ?? "")
      ? CALLSITE_STACK_FRAME_SYNTAX
      : V8_STACK_FRAME_SYNTAX;
  const frames = lines
    .filter((line) => frameSyntax.test(line))
    .map(stripStackFrameUrlMetadata);
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

const stripUrlMetadata = (url: string): string => {
  const terminator = url.search(/[?#]/u);
  return terminator === -1 ? url : url.slice(0, terminator);
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
    // URL metadata on asset URLs can carry tokens; keep only the path.
    ...(typeof filename === "string"
      ? { filename: stripUrlMetadata(filename) }
      : {}),
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
  const safeArea =
    typeof area === "string" && TELEMETRY_AREA.test(area) ? area : undefined;
  return {
    ...event,
    properties: {
      ...pickIngestionRequired(properties),
      // Grouping identity derived from the sanitized list, so nothing the
      // redaction removed can reach it.
      $exception_fingerprint: fingerprintExceptionEvent({
        area: safeArea,
        entries: sanitizedList,
      }),
      $exception_list: sanitizedList,
      $exception_type: type,
      ...(typeof appCommit === "string" ? { app_commit: appCommit } : {}),
      ...(typeof appVersion === "string" ? { app_version: appVersion } : {}),
      ...(safeArea === undefined ? {} : { area: safeArea }),
      ...(isErrorReference(errorReference)
        ? { error_reference: errorReference }
        : {}),
    },
  };
};

type RouteErrorLifecycleSanitizer = typeof sanitizeRouteErrorLifecycleEvent;
let routeErrorLifecycleSanitizer: RouteErrorLifecycleSanitizer | undefined;

// The SDK stamps `$web_vitals` events with the resolved URL, which can
// carry resource ids. `capturePageViewed` records resolved pathname →
// route template for recent navigations (a bounded, adapter-owned map);
// the sanitizer attributes each event via its originating URL rather
// than the latest route, because vitals (CLS, INP) can flush after the
// next navigation resolves. An unknown origin drops the URL fields
// rather than mislabeling them.
const ROUTE_TEMPLATE_HISTORY_LIMIT = 50;
type RouteTemplateHistory = Map<string, string>;

const recordRouteTemplate = (
  history: RouteTemplateHistory,
  resolvedPath: string,
  template: string,
): void => {
  history.delete(resolvedPath);
  history.set(resolvedPath, template);
  for (const key of history.keys()) {
    if (history.size <= ROUTE_TEMPLATE_HISTORY_LIMIT) {
      break;
    }
    history.delete(key);
  }
};

// Property keys per metric, total over the SDK's metric union so a new
// metric cannot land without a decision here.
const WEB_VITALS_KEYS = {
  CLS: { value: "$web_vitals_CLS_value", event: "$web_vitals_CLS_event" },
  FCP: { value: "$web_vitals_FCP_value", event: "$web_vitals_FCP_event" },
  INP: { value: "$web_vitals_INP_value", event: "$web_vitals_INP_event" },
  LCP: { value: "$web_vitals_LCP_value", event: "$web_vitals_LCP_event" },
} as const satisfies Record<
  SupportedWebVitalsMetrics,
  { value: string; event: string }
>;

/**
 * The URL the vitals were measured on, read from the SDK's per-metric
 * event payloads (stamped when each metric fired, not when the batch
 * flushed).
 */
const webVitalsOriginatingUrl = (
  properties: Record<string, unknown>,
): URL | null => {
  for (const { event } of Object.values(WEB_VITALS_KEYS)) {
    const entry = properties[event];
    if (!isRecord(entry)) {
      continue;
    }
    const url = entry["$current_url"];
    if (typeof url !== "string") {
      continue;
    }
    try {
      return new URL(url);
    } catch {
      continue;
    }
  }
  return null;
};

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
const sanitizeWebVitalsEvent = (
  event: CaptureResult,
  history: RouteTemplateHistory,
): CaptureResult | null => {
  const properties: Record<string, unknown> = event.properties;
  const metricValues = Object.fromEntries(
    Object.values(WEB_VITALS_KEYS)
      .map(({ value }) => value)
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
  const origin = webVitalsOriginatingUrl(properties);
  const template = origin === null ? undefined : history.get(origin.pathname);
  return {
    ...event,
    properties: {
      ...pickIngestionRequired(properties),
      ...metricValues,
      ...context,
      ...(typeof appCommit === "string" ? { app_commit: appCommit } : {}),
      ...(typeof appVersion === "string" ? { app_version: appVersion } : {}),
      ...(origin !== null && template !== undefined
        ? {
            $current_url: `${origin.origin}${template}`,
            $pathname: template,
          }
        : {}),
    },
  };
};

// The SDK stamps every capture with context from the live location beyond
// the `$current_url`/`$pathname` pair `capturePageViewed` overrides: the
// previous page's pathname, the session entry URL, the document title, and
// referrers. Events whose payloads are not rebuilt from an allowlist
// (`$pageview`, `$pageleave`, `$identify`, custom events) go through this
// scrub so resolved resource ids still never leave the browser: each
// resolved path is rewritten to its recorded route template or dropped.
//
// `route-template` marks events whose `$current_url`/`$pathname` already
// carry the template (our own `$pageview` override); `resolved` events get
// those fields mapped through the history like every other resolved path.
type SdkUrlSource = "route-template" | "resolved";

type TemplateUrl = { url: string; pathname: string };

const templateUrl = (
  history: RouteTemplateHistory,
  value: unknown,
): TemplateUrl | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  const template = history.get(parsed.pathname);
  if (template === undefined) {
    return undefined;
  }
  return { url: `${parsed.origin}${template}`, pathname: template };
};

// Referrers on another host are marketing signal and carry no resource ids;
// same-host referrers are resolved in-app paths, and `$referring_domain`
// already covers them.
const isExternalReferrer = (value: unknown, host: unknown): boolean => {
  if (typeof value !== "string" || typeof host !== "string") {
    return false;
  }
  try {
    return new URL(value).host !== host;
  } catch {
    return false;
  }
};

const sanitizeSdkUrlContext = (
  event: CaptureResult,
  history: RouteTemplateHistory,
  urlSource: SdkUrlSource,
): CaptureResult => {
  const properties: Record<string, unknown> = { ...event.properties };
  // `document.title` can carry document or matter names.
  delete properties["title"];
  if (urlSource === "resolved") {
    const current = templateUrl(history, properties["$current_url"]);
    delete properties["$current_url"];
    delete properties["$pathname"];
    if (current !== undefined) {
      properties["$current_url"] = current.url;
      properties["$pathname"] = current.pathname;
    }
  }
  const previousPath = properties["$prev_pageview_pathname"];
  delete properties["$prev_pageview_pathname"];
  if (typeof previousPath === "string") {
    const template = history.get(previousPath);
    if (template !== undefined) {
      properties["$prev_pageview_pathname"] = template;
    }
  }
  const entry = templateUrl(history, properties["$session_entry_url"]);
  delete properties["$session_entry_url"];
  delete properties["$session_entry_pathname"];
  if (entry !== undefined) {
    properties["$session_entry_url"] = entry.url;
    properties["$session_entry_pathname"] = entry.pathname;
  }
  if (!isExternalReferrer(properties["$referrer"], properties["$host"])) {
    delete properties["$referrer"];
  }
  if (
    !isExternalReferrer(
      properties["$session_entry_referrer"],
      properties["$host"],
    )
  ) {
    delete properties["$session_entry_referrer"];
  }
  return { ...event, properties };
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
type CreatePostHogAnalyticsOptions = {
  key: string;
  host: string;
  /**
   * PostHog web-app origin, needed only when `host` is a first-party
   * ingest proxy: the SDK otherwise derives UI links from `api_host`,
   * which would point them at the proxy domain.
   */
  uiHost?: string | undefined;
};

export const createPostHogAnalytics = ({
  host,
  key,
  uiHost,
}: CreatePostHogAnalyticsOptions): {
  analytics: Analytics;
  client: typeof posthog | undefined;
} => {
  const localDebugEnabled = import.meta.env.DEV && env.VITE_POSTHOG_LOCAL_DEBUG;
  const routeTemplateHistory: RouteTemplateHistory = new Map();
  const client = posthog.init(key, {
    opt_out_capturing_by_default: import.meta.env.DEV && !localDebugEnabled,
    api_host: host,
    ...(uiHost === undefined ? {} : { ui_host: uiHost }),
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
    // The SDK's pageleave is what web analytics derives bounce rate and page
    // duration from; the default ties it to `capture_pageview`, which stays
    // off because page views are captured manually with route templates.
    capture_pageleave: true,
    before_send: (event) => {
      if (import.meta.env.DEV && !localDebugEnabled) {
        return null;
      }
      if (!event || !isWebAnalyticsEvent(event.event)) {
        return null;
      }
      switch (event.event) {
        case WEB_ANALYTICS_EVENTS.exception:
          return isNoiseException(event) ? null : sanitizeExceptionEvent(event);
        case WEB_ANALYTICS_EVENTS.routeErrorRecovery:
          return routeErrorLifecycleSanitizer?.(event) ?? null;
        case WEB_ANALYTICS_EVENTS.webVitals:
          return sanitizeWebVitalsEvent(event, routeTemplateHistory);
        case WEB_ANALYTICS_EVENTS.pageViewed:
          return sanitizeSdkUrlContext(
            event,
            routeTemplateHistory,
            "route-template",
          );
        case WEB_ANALYTICS_EVENTS.pageLeft:
        case WEB_ANALYTICS_EVENTS.identify:
        case WEB_ANALYTICS_EVENTS.guideStepSkipped:
          return sanitizeSdkUrlContext(event, routeTemplateHistory, "resolved");
        default: {
          const exhaustive: never = event.event;
          return exhaustive;
        }
      }
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
      if (hasLocation) {
        recordRouteTemplate(
          routeTemplateHistory,
          globalThis.location.pathname,
          path,
        );
      }
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
        // Same person, possibly a fresh active organization (SPA org
        // switch): rebind the group so later events attribute to the
        // current organization instead of the one bound at identify.
        posthog.group(ORGANIZATION_GROUP_TYPE, user.activeOrganizationId);
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
      // Group properties (name, practice jurisdictions) are set server-side
      // via groupIdentify; the browser only attaches the opaque key.
      posthog.group(ORGANIZATION_GROUP_TYPE, user.activeOrganizationId);
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
