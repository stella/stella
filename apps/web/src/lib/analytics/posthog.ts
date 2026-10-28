import { CancelledError } from "@tanstack/react-query";
import { panic } from "better-result";
import { posthog } from "posthog-js";
import type {
  CaptureResult,
  ResetOptions,
  SupportedWebVitalsMetrics,
} from "posthog-js";

import { POSTHOG_ORGANIZATION_GROUP_TYPE } from "@stll/analytics-config";
import {
  API_FILE_SECURITY_REJECTED_ERROR_CODE,
  CHAT_CONTINUATION_REJECTED_ERROR_CODE,
} from "@stll/api-contract";
import { PROVIDER_SETUP_ERROR_CODE } from "@stll/api-contract/provider-setup";
import { MAX_EXCEPTION_CAUSE_DEPTH } from "@stll/errors/exception-cause-chain";

import { env } from "@/env";
import { sanitizeHandoffUrl } from "@/lib/account/handoff-url";
import { normalizeTelemetryErrorTypeName } from "@/lib/analytics/error-diagnostics";
import { isErrorReference } from "@/lib/analytics/error-reference";
import {
  automaticExceptionKey,
  capturedApiErrorIdentity,
  capturedExceptionIdentity,
  fingerprintExceptionEvent,
  fingerprintExceptionScope,
  isApiErrorCode,
  isExceptionFingerprintKey,
  isExceptionScopeFingerprint,
  readApiErrorIdentity,
  sanitizeFingerprintFields,
} from "@/lib/analytics/exception-fingerprint";
import { sanitizeHangDiagnosticEvent } from "@/lib/analytics/posthog-hang-diagnostics";
import { pickIngestionRequired } from "@/lib/analytics/posthog-ingestion";
import type { sanitizeRouteErrorLifecycleEvent } from "@/lib/analytics/posthog-route-error";
import { captureRedactedException } from "@/lib/analytics/stack-redaction";
import { WEB_ANALYTICS_EVENTS } from "@/lib/analytics/types";
import type {
  Analytics,
  AnalyticsResetOptions,
  ErrorCaptureContext,
  WebAnalyticsEvent,
} from "@/lib/analytics/types";
import { APIError } from "@/lib/errors/api";
import { logDevError } from "@/lib/errors/telemetry";

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

// Every `DOMException` is coerced to this one class name (and every legacy
// `DOMError` to its own), so the entry type cannot tell an `AbortError` from a
// `QuotaExceededError` or a `SecurityError`. The distinguishing `name` is
// carried in the value instead, which the redaction below blanks, leaving the
// class as the sole identity of unrelated failures.
const DOM_EXCEPTION_CLASS = /^DOM(?:Error|Exception)$/u;

// The standard DOM exception names (WebIDL's name table). The coerced value is
// either the name alone or `name: message`, and a `DOMException` can be
// constructed with any name, so only a standard name is read back: a custom
// one could carry an identifier, and it falls back to the bare class.
const DOM_EXCEPTION_NAMES: ReadonlySet<string> = new Set([
  "AbortError",
  "ConstraintError",
  "DataCloneError",
  "DataError",
  "EncodingError",
  "HierarchyRequestError",
  "InUseAttributeError",
  "IndexSizeError",
  "InvalidAccessError",
  "InvalidCharacterError",
  "InvalidModificationError",
  "InvalidNodeTypeError",
  "InvalidStateError",
  "NamespaceError",
  "NetworkError",
  "NoModificationAllowedError",
  "NotAllowedError",
  "NotFoundError",
  "NotReadableError",
  "NotSupportedError",
  "OperationError",
  "OptOutError",
  "QuotaExceededError",
  "ReadOnlyError",
  "SecurityError",
  "SyntaxError",
  "TimeoutError",
  "TransactionInactiveError",
  "TypeMismatchError",
  "URLMismatchError",
  "UnknownError",
  "VersionError",
  "WrongDocumentError",
]);

// Recovers the specific error name of a DOM exception, keeping each kind of DOM
// failure a distinct class. This matches `telemetryErrorType`, which already
// identifies hand-captured errors by `error.name`.
const domExceptionClass = (type: string, value: string): string => {
  if (!DOM_EXCEPTION_CLASS.test(type)) {
    return type;
  }
  const separator = value.indexOf(":");
  const name = separator === -1 ? value : value.slice(0, separator);
  return DOM_EXCEPTION_NAMES.has(name) ? name : type;
};

// The reason a cancelled request rejects with. The router and the query layer
// cancel in-flight requests on every navigation and unmount and treat that as
// cancellation, never as failure; one that escapes to the global rejection
// handler still names no defect, only that a request was cut short.
const CANCELLED_REQUEST_CLASS = "AbortError";

// Errors whose type names an expected outcome, handled where it happens: no
// desktop app running, a public-law source down, a signed-out session, a
// model provider's failure the chat shows with its setup guidance (the API
// reports the provider failures it does not classify itself).
const EXPECTED_OUTCOME_TYPES: ReadonlySet<string> = new Set([
  "AuthClientError",
  "DesktopBridgeUnavailableError",
  "ProviderDiagnosticError",
  "PublicLawUnavailableError",
]);

// Messages that name no defect of ours: React reconciling a DOM another
// script (a translator, an extension) already changed, and a request the
// network dropped (the route's own offline state reports connectivity).
const ENVIRONMENT_NOISE_PATTERNS: readonly RegExp[] = [
  /Failed to execute '(?:removeChild|insertBefore)' on 'Node'/u,
  /The node (?:to be removed )?is not a child of this node/iu,
  /^(?:TypeError: )?(?:Failed to fetch|Load failed|NetworkError when attempting to fetch resource\.?)$/u,
];

const EXTENSION_FRAME = /^(?:chrome|moz|safari(?:-web)?)-extension:\/\//u;

// API answers the UI already turns into a state (sign in, no access, not
// found, a rejected provider key or continuation, a provider key that needs
// more setup, a file the upload scan refused). Other 4xx and every 5xx stay
// reported.
const API_ERROR_TYPES: ReadonlySet<string> = new Set([
  "ApiError",
  "StreamReadError",
]);
const EXPECTED_API_STATUSES: ReadonlySet<number> = new Set([401, 403, 404]);
const EXPECTED_API_CODES: ReadonlySet<string> = new Set([
  "ai_config_provider_validation_failed",
  ...Object.values(PROVIDER_SETUP_ERROR_CODE),
  CHAT_CONTINUATION_REJECTED_ERROR_CODE,
  API_FILE_SECURITY_REJECTED_ERROR_CODE,
]);

const hasExtensionFrame = (entry: unknown): boolean => {
  const stacktrace = isRecord(entry) ? entry["stacktrace"] : undefined;
  const frames = isRecord(stacktrace) ? stacktrace["frames"] : undefined;
  if (!Array.isArray(frames)) {
    return false;
  }
  const list: unknown[] = frames;
  return list.some((frame) =>
    EXTENSION_FRAME.test(readStringField(frame, "filename")),
  );
};

const isExpectedApiOutcome = (
  type: string,
  properties: Record<string, unknown> | undefined,
): boolean => {
  if (!API_ERROR_TYPES.has(type) || properties === undefined) {
    return false;
  }
  const status = properties["error_status"];
  const code = properties["error_code"];
  return (
    (typeof status === "number" && EXPECTED_API_STATUSES.has(status)) ||
    (typeof code === "string" && EXPECTED_API_CODES.has(code))
  );
};

const NOISE_PATTERNS = [
  ...EXCEPTION_NOISE_PATTERNS,
  ...ENVIRONMENT_NOISE_PATTERNS,
];

export const isNoiseException = (event: {
  properties?: Record<string, unknown>;
}): boolean => {
  if (event.properties?.["user_visible"] === true) {
    return false;
  }
  const list = event.properties?.["$exception_list"];
  if (!Array.isArray(list) || list.length === 0) {
    return false;
  }
  const entries: unknown[] = list;
  return entries.some((entry) => {
    const value = readStringField(entry, "value");
    const type = readStringField(entry, "type");
    return (
      domExceptionClass(type, value) === CANCELLED_REQUEST_CLASS ||
      EXPECTED_OUTCOME_TYPES.has(type) ||
      isExpectedApiOutcome(type, event.properties) ||
      hasExtensionFrame(entry) ||
      NOISE_PATTERNS.some(
        (pattern) => pattern.test(value) || pattern.test(type),
      )
    );
  });
};

// Telemetry areas are fixed subsystem slugs declared at error boundaries
// (`ClientTelemetryError.area`). The pattern rejects anything free-form so
// no dynamic string can ride along.
const TELEMETRY_AREA = /^[a-z][a-z0-9-]{0,39}$/u;
const USER_VISIBLE_FEATURE = /^[a-z][a-z0-9-]{0,39}$/u;
const ROUTE_TEMPLATE = /^(?:unknown|\/[A-Za-z0-9_.$/-]*)$/u;

declare const exceptionCodeBrand: unique symbol;
type ExceptionCode = string & { readonly [exceptionCodeBrand]: true };
declare const telemetryAreaBrand: unique symbol;
type TelemetryArea = string & { readonly [telemetryAreaBrand]: true };

type ExceptionValueFields = {
  /** Already a class token: `normalizeTelemetryErrorTypeName` output. */
  type: string;
  code?: ExceptionCode;
  status?: number;
  area?: TelemetryArea;
};

/** Renders only structural fields that have already crossed their allowlist. */
const exceptionValue = ({
  type,
  code,
  status,
  area,
}: ExceptionValueFields): string =>
  `${type}${code === undefined ? "" : `[${code}]`}${
    status === undefined ? "" : ` ${status}`
  }${area === undefined ? "" : ` area=${area}`}`;

// The allowlists narrow by predicate, so a branded value only ever comes from
// a string that passed its pattern.
const isExceptionCode = (value: string): value is ExceptionCode =>
  isApiErrorCode(value);

const isTelemetryArea = (value: string): value is TelemetryArea =>
  TELEMETRY_AREA.test(value);

const exceptionCode = (value: string | undefined): ExceptionCode | undefined =>
  value !== undefined && isExceptionCode(value) ? value : undefined;

const telemetryArea = (value: unknown): TelemetryArea | undefined =>
  typeof value === "string" && isTelemetryArea(value) ? value : undefined;

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

const apiErrorTelemetryProperties = (
  error: unknown,
): Record<string, number | string> | undefined => {
  const identity = capturedApiErrorIdentity(error);
  if (identity === undefined) {
    return undefined;
  }
  return {
    error_status: identity.status,
    ...(identity.code === undefined ? {} : { error_code: identity.code }),
  };
};

// Structural frame fields only: code locations from the deployed bundle.
// Free-text fields (context lines, local variables, function names) never
// pass through. Function names are unsafe even when identifier-shaped:
// engines infer them from computed property keys, which can be user data.
//
// PostHog's ingestion parses each raw frame by `platform` and requires
// `function`; a frame without them fails the whole exception. These carry
// posthog-js's own defaults for a browser frame, with the function always
// reported as unknown.
//
// `chunk_id` is the id the release build injected into the chunk and uploaded
// its source map under. It is the only way the tracker finds that map: without
// it, the tracker fetches the public bundle, which serves no maps.
export const UNKNOWN_FRAME_FUNCTION = "?";
const WEB_FRAME_PLATFORM = "web:javascript";

type SanitizedFrame = {
  platform: string;
  function: typeof UNKNOWN_FRAME_FUNCTION;
  in_app: boolean;
  filename?: string;
  lineno?: number;
  colno?: number;
  chunk_id?: string;
};

// The CLI injects UUIDs; anything else is not a chunk id.
const CHUNK_ID = /^[0-9a-f-]{1,64}$/iu;

const stripUrlMetadata = (url: string): string => {
  const terminator = url.search(/[?#]/u);
  return terminator === -1 ? url : url.slice(0, terminator);
};

export const sanitizeFrame = (frame: unknown): SanitizedFrame => {
  const fields = isRecord(frame) ? frame : {};
  const filename = fields["filename"];
  const platform = fields["platform"];
  const inApp = fields["in_app"];
  const lineno = fields["lineno"];
  const colno = fields["colno"];
  const chunkId = fields["chunk_id"];
  return {
    platform: typeof platform === "string" ? platform : WEB_FRAME_PLATFORM,
    function: UNKNOWN_FRAME_FUNCTION,
    in_app: typeof inApp === "boolean" ? inApp : true,
    // URL metadata on asset URLs can carry tokens; keep only the path.
    ...(typeof filename === "string"
      ? { filename: stripUrlMetadata(filename) }
      : {}),
    ...(typeof lineno === "number" ? { lineno } : {}),
    ...(typeof colno === "number" ? { colno } : {}),
    ...(typeof chunkId === "string" && CHUNK_ID.test(chunkId)
      ? { chunk_id: chunkId }
      : {}),
  };
};

const sanitizeExceptionEntry = (
  entry: unknown,
  fields: Omit<ExceptionValueFields, "type">,
) => {
  const type = domExceptionClass(
    normalizeTelemetryErrorTypeName(readStringField(entry, "type")),
    readStringField(entry, "value"),
  );
  const stacktrace = isRecord(entry) ? entry["stacktrace"] : undefined;
  const frames = isRecord(stacktrace) ? stacktrace["frames"] : undefined;
  return {
    type,
    value: exceptionValue({ type, ...fields }),
    ...(Array.isArray(frames)
      ? { stacktrace: { type: "raw", frames: frames.map(sanitizeFrame) } }
      : {}),
  };
};

type RouteTemplateHistory = Map<string, string>;

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

export const sanitizeExceptionEvent = (
  event: CaptureResult,
  history: RouteTemplateHistory,
): CaptureResult => {
  const properties: Record<string, unknown> = event.properties;
  const appCommit = properties["app_commit"];
  const appVersion = properties["app_version"];
  const area = properties["area"];
  const errorReference = properties["error_reference"];
  const feature = properties["feature"];
  const routeTemplate = properties["route_template"];
  const userVisible = properties["user_visible"] === true;
  const exceptionList = properties["$exception_list"];
  const entries: unknown[] = Array.isArray(exceptionList) ? exceptionList : [];
  const safeArea = telemetryArea(area);
  const http = readApiErrorIdentity({
    status: properties["error_status"],
    code: properties["error_code"],
  });
  const safeCode = exceptionCode(http?.code);
  const valueFields = {
    ...(safeArea === undefined ? {} : { area: safeArea }),
    ...(http === undefined
      ? {}
      : {
          status: http.status,
          ...(safeCode === undefined ? {} : { code: safeCode }),
        }),
  };
  const sanitizedList =
    entries.length > 0
      ? entries.map((entry) => sanitizeExceptionEntry(entry, valueFields))
      : [sanitizeExceptionEntry(undefined, valueFields)];
  const type = sanitizedList.at(0)?.type ?? normalizeTelemetryErrorTypeName("");
  const fields = sanitizeFingerprintFields(properties["exception_fields"]);
  const causalTypes = properties["exception_error_types"];
  const declaredKey = properties["exception_key"];
  const key = isExceptionFingerprintKey(declaredKey)
    ? declaredKey
    : automaticExceptionKey({
        entries: sanitizedList,
        message: readStringField(entries.at(-1), "value"),
        firstPartyOrigin: env.VITE_PUBLIC_APP_URL,
      });
  const declaredScope = properties["exception_scope"];
  const scopeIdentity = isExceptionScopeFingerprint(declaredScope)
    ? declaredScope
    : fingerprintExceptionScope({ type: "handler", handlerId: key });
  // Session and window ids join an exception to the page views and actions
  // around it; they are random SDK ids that carry no user content.
  const sessionId = properties["$session_id"];
  const windowId = properties["$window_id"];
  // The route template the exception happened on; a resolved URL with no
  // recorded template is dropped rather than sent.
  const route = templateUrl(history, properties["$current_url"]);
  return {
    ...event,
    properties: {
      ...pickIngestionRequired(properties),
      ...(typeof sessionId === "string" ? { $session_id: sessionId } : {}),
      ...(typeof windowId === "string" ? { $window_id: windowId } : {}),
      ...(route === undefined
        ? {}
        : { $current_url: route.url, $pathname: route.pathname }),
      // Explicit owners are preferred; SDK captures use asset ownership and an
      // opaque normalized message shape. Source positions remain diagnostic.
      $exception_fingerprint: fingerprintExceptionEvent({
        key,
        scopeIdentity,
        entries:
          Array.isArray(causalTypes) && causalTypes.length > 0
            ? causalTypes
                .slice(0, MAX_EXCEPTION_CAUSE_DEPTH)
                .map((causalType) => ({
                  type: normalizeTelemetryErrorTypeName(
                    typeof causalType === "string" ? causalType : "",
                  ),
                }))
            : sanitizedList,
        fields,
        http,
      }),
      $exception_list: sanitizedList,
      $exception_type: type,
      ...(properties["exception_identity_status"] === "read_failed"
        ? { exception_identity_status: "read_failed" }
        : {}),
      ...(typeof appCommit === "string" ? { app_commit: appCommit } : {}),
      ...(typeof appVersion === "string" ? { app_version: appVersion } : {}),
      ...(safeArea === undefined ? {} : { area: safeArea }),
      ...(http === undefined
        ? {}
        : {
            error_status: http.status,
            ...(http.code === undefined ? {} : { error_code: http.code }),
          }),
      ...(isErrorReference(errorReference)
        ? { error_reference: errorReference }
        : {}),
      ...(userVisible ? { user_visible: true } : {}),
      ...(userVisible &&
      typeof feature === "string" &&
      USER_VISIBLE_FEATURE.test(feature)
        ? { feature }
        : {}),
      ...(userVisible &&
      typeof routeTemplate === "string" &&
      ROUTE_TEMPLATE.test(routeTemplate)
        ? { route_template: routeTemplate }
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
  return {
    ...event,
    properties: {
      ...properties,
      ...Object.fromEntries(
        ["$referrer", "$session_entry_referrer"].flatMap((key) => {
          const value = properties[key];
          return typeof value === "string"
            ? [[key, sanitizeHandoffUrl(value)]]
            : [];
        }),
      ),
    },
  };
};

const errorContextProperties = (
  context: ErrorCaptureContext | undefined,
): Record<string, string | boolean> | undefined => {
  switch (context?.type) {
    case "recovery":
      return { error_reference: context.reference };
    case "user-visible":
      return {
        feature: context.feature,
        route_template: context.routeTemplate,
        user_visible: true,
      };
    case "detached":
    case undefined:
      return undefined;
    default: {
      context satisfies never;
      return panic(`Unhandled context: ${String(context)}`);
    }
  }
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
    case "user-visible":
      return {
        feature: context.feature,
        route_template: context.routeTemplate,
        user_visible: "true",
      };
    default: {
      context satisfies never;
      return panic(`Unhandled context: ${String(context)}`);
    }
  }
};

// The anonymous side of a page load's `$identify` when the load holds no
// anonymous activity worth linking: the same value on every load of the same
// user, so it joins that person once and never adds another distinct id.
export const signedInAnonymousId = (userId: string): string =>
  `signed-in:${userId}`;

const registerBuildProperties = () => {
  posthog.register({
    app_commit: __APP_COMMIT_SHA__,
    app_version: __APP_VERSION__,
  });
};

const captureError: Analytics["captureError"] = (
  error,
  { fingerprintKey, scope, context },
) => {
  // A cancelled request is expected control flow, not an operational failure.
  if (
    (APIError.is(error) && error.transportKind === "aborted") ||
    (typeof DOMException !== "undefined" &&
      error instanceof DOMException &&
      error.name === "AbortError")
  ) {
    return;
  }
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
  const identity = capturedExceptionIdentity(error);
  captureRedactedException(error, (redacted) => {
    posthog.captureException(redacted, {
      exception_key: fingerprintKey,
      exception_scope: fingerprintExceptionScope(scope),
      exception_error_types: identity.types,
      exception_fields: identity.fields,
      ...(identity.status === "read_failed"
        ? { exception_identity_status: identity.status }
        : {}),
      ...errorContextProperties(context),
      ...telemetryAreaProperty(error),
      ...apiErrorTelemetryProperties(error),
    });
  });
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
  routeTemplates?: readonly string[];
  key: string;
  host: string;
  /**
   * PostHog web-app origin, needed only when `host` is a first-party
   * ingest proxy: the SDK otherwise derives UI links from `api_host`,
   * which would point them at the proxy domain.
   */
  uiHost?: string | undefined;
};

// Events whose properties are already typed for PostHog go straight to the
// SDK; keeping them out of the factory keeps its body to the stateful parts.
const forwardedCaptures: Pick<
  Analytics,
  | "capturePageHangSuspected"
  | "captureLongAnimationFrame"
  | "captureGuideStepSkipped"
  | "captureFeedbackDialogOpened"
  | "captureFeedbackReportSubmitted"
  | "captureProvisionPlacementGaps"
  | "captureCaseLawAnalysisTiming"
  | "captureInspectorRestoreRecovered"
  | "captureFollowupShown"
  | "captureFollowupSelected"
  | "captureKeyActionTiming"
> = {
  capturePageHangSuspected: (properties) => {
    posthog.capture(WEB_ANALYTICS_EVENTS.pageHangSuspected, properties);
  },
  captureLongAnimationFrame: (properties) => {
    posthog.capture(WEB_ANALYTICS_EVENTS.longAnimationFrame, properties);
  },
  captureGuideStepSkipped: (properties) => {
    posthog.capture(WEB_ANALYTICS_EVENTS.guideStepSkipped, properties);
  },
  captureFeedbackDialogOpened: (properties) => {
    posthog.capture(WEB_ANALYTICS_EVENTS.feedbackDialogOpened, properties);
  },
  captureFeedbackReportSubmitted: (properties) => {
    posthog.capture(WEB_ANALYTICS_EVENTS.feedbackReportSubmitted, properties);
  },
  captureProvisionPlacementGaps: (properties) => {
    posthog.capture(WEB_ANALYTICS_EVENTS.provisionPlacementGaps, properties);
  },
  captureCaseLawAnalysisTiming: (properties) => {
    posthog.capture(WEB_ANALYTICS_EVENTS.caseLawAnalysisTiming, properties);
  },
  captureInspectorRestoreRecovered: (properties) => {
    posthog.capture(WEB_ANALYTICS_EVENTS.inspectorRestoreRecovered, properties);
  },
  captureFollowupShown: (properties) => {
    posthog.capture(WEB_ANALYTICS_EVENTS.followupShown, properties);
  },
  captureFollowupSelected: (properties) => {
    posthog.capture(WEB_ANALYTICS_EVENTS.followupSelected, properties);
  },
  captureKeyActionTiming: (properties) => {
    posthog.capture(WEB_ANALYTICS_EVENTS.keyActionTimed, properties);
  },
};

export const createPostHogAnalytics = ({
  host,
  key,
  uiHost,
  routeTemplates = [],
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
          return isNoiseException(event)
            ? null
            : sanitizeExceptionEvent(event, routeTemplateHistory);
        case WEB_ANALYTICS_EVENTS.routeErrorRecovery:
          return routeErrorLifecycleSanitizer?.(event) ?? null;
        case WEB_ANALYTICS_EVENTS.pageHangSuspected:
        case WEB_ANALYTICS_EVENTS.longAnimationFrame:
          return sanitizeHangDiagnosticEvent({
            event,
            appUrl: env.VITE_PUBLIC_APP_URL,
            routeTemplates,
          });
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
        case WEB_ANALYTICS_EVENTS.feedbackDialogOpened:
        case WEB_ANALYTICS_EVENTS.feedbackReportSubmitted:
        case WEB_ANALYTICS_EVENTS.provisionPlacementGaps:
        case WEB_ANALYTICS_EVENTS.caseLawAnalysisTiming:
        case WEB_ANALYTICS_EVENTS.inspectorRestoreRecovered:
        case WEB_ANALYTICS_EVENTS.followupShown:
        case WEB_ANALYTICS_EVENTS.followupSelected:
        case WEB_ANALYTICS_EVENTS.keyActionTimed:
          return sanitizeSdkUrlContext(event, routeTemplateHistory, "resolved");
        default: {
          event.event satisfies never;
          return panic(`Unhandled event: ${String(event.event)}`);
        }
      }
    },
  });

  // Attach build metadata as super-properties so every captured
  // event carries the exact deployed build. `reset` clears super-properties,
  // so every identity change goes through `resetIdentity`, which registers
  // them again.
  registerBuildProperties();

  // Persistence is off, so every page load starts with a fresh anonymous
  // distinct id. Identity binds through one `$identify` per load, which is what
  // marks the person identified and lets analytics count signed-in users. The
  // anonymous side of that `$identify` is chosen so the person's distinct ids
  // stay bounded:
  // - after the app saw a signed-out visitor in this load (an in-app sign-in),
  //   the load's own anonymous id, so the pages visited before signing in join
  //   the person; this happens once per sign-in, not per page load;
  // - otherwise (a page load that already holds a session, another user's
  //   identity), an anonymous id derived from the user id, which joins the
  //   person once and is a no-op on every later load.
  let signedOutVisitorSeen = false;

  const resetIdentity = (options?: ResetOptions) => {
    posthog.reset(options);
    registerBuildProperties();
  };

  const bindIdentity = (userId: string) => {
    if (posthog._isIdentified() || !signedOutVisitorSeen) {
      resetIdentity({
        bootstrap: {
          distinctID: signedInAnonymousId(userId),
          isIdentifiedID: false,
        },
      });
    }
    signedOutVisitorSeen = false;
    // The stable user id is the whole identity. Profile attributes such as
    // name and email already live server-side keyed by this id, so
    // duplicating them into PostHog person properties adds no analytical
    // value and only widens the person-property surface.
    posthog.identify(userId);
  };

  const analytics: Analytics = {
    captureError,
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
    ...forwardedCaptures,
    captureRouteErrorLifecycle: async (properties) =>
      import("@/lib/analytics/posthog-route-error")
        .then((module) => {
          routeErrorLifecycleSanitizer =
            module.sanitizeRouteErrorLifecycleEvent;
          return module.captureRouteErrorLifecycle(posthog, properties);
        })
        .catch((error: unknown) => {
          analytics.captureError(error, {
            fingerprintKey:
              "createPostHogAnalytics.captureRouteErrorLifecycle:failure",
            scope: {
              type: "handler",
              handlerId:
                "createPostHogAnalytics.captureRouteErrorLifecycle:failure",
            },
            context: {
              operation: "posthog.route-error-lifecycle",
              type: "detached",
            },
          });
        }),
    identifyUser: (user) => {
      const distinctId = posthog.get_distinct_id();

      if (distinctId === user.id) {
        // Same person, possibly a fresh active organization (SPA org
        // switch): rebind the group so later events attribute to the
        // current organization instead of the one bound at identify.
        posthog.group(
          POSTHOG_ORGANIZATION_GROUP_TYPE,
          user.activeOrganizationId,
        );
        return;
      }

      bindIdentity(user.id);
      // Group properties (name, practice jurisdictions) are set server-side
      // via groupIdentify; the browser only attaches the opaque key.
      posthog.group(POSTHOG_ORGANIZATION_GROUP_TYPE, user.activeOrganizationId);
    },
    reset: ({ onlyIfIdentified }: AnalyticsResetOptions = {}) => {
      signedOutVisitorSeen = true;
      if (onlyIfIdentified && !posthog._isIdentified()) {
        return;
      }

      resetIdentity();
    },
  };

  return { analytics, client };
};
