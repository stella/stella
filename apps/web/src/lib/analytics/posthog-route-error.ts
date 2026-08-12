import type { CaptureResult, PostHog } from "posthog-js";

import { isErrorReference } from "@/lib/analytics/error-reference";
import { WEB_ANALYTICS_EVENTS } from "@/lib/analytics/types";
import type { RouteErrorLifecycleProperties } from "@/lib/analytics/types";

const STATUS_PATTERN = /^(?:shown|retry_started|recurred)$/u;
const RECOVERY_PATTERN = /^(?:reload-page|retry-route)$/u;
const INSPECTOR_PATTERN = /^(?:empty|minimized|open|unavailable)$/u;
const ROUTE_TEMPLATE_PATTERN = /^(?:unknown|\/[\w$./{}-]{0,299})$/u;
const ERROR_FINGERPRINT_PATTERN = /^ERRFP-[0-9A-F]{8}$/u;
const OPAQUE_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const matches = (value: unknown, pattern: RegExp): value is string =>
  typeof value === "string" && pattern.test(value);

export const sanitizeRouteErrorLifecycleEvent = (
  event: CaptureResult,
): CaptureResult | null => {
  const properties: Record<string, unknown> = event.properties;
  const distinctId = properties["$distinct_id"];
  const sessionId = properties["$session_id"];
  const appCommit = properties["app_commit"];
  const appVersion = properties["app_version"];
  const reference = properties["error_reference"];
  const incidentReference = properties["incident_reference"];
  const inspectorState = properties["inspector_state"];
  const errorFingerprint = properties["error_fingerprint"];
  const recovery = properties["recovery"];
  const routeTemplate = properties["route_template"];
  const status = properties["status"];

  if (
    !isErrorReference(reference) ||
    !isErrorReference(incidentReference) ||
    !matches(inspectorState, INSPECTOR_PATTERN) ||
    !matches(errorFingerprint, ERROR_FINGERPRINT_PATTERN) ||
    !matches(recovery, RECOVERY_PATTERN) ||
    !matches(routeTemplate, ROUTE_TEMPLATE_PATTERN) ||
    !matches(status, STATUS_PATTERN)
  ) {
    return null;
  }

  return {
    ...event,
    properties: {
      ...(typeof distinctId === "string" ? { $distinct_id: distinctId } : {}),
      ...(matches(sessionId, OPAQUE_SESSION_ID_PATTERN)
        ? { $session_id: sessionId }
        : {}),
      ...(typeof appCommit === "string" ? { app_commit: appCommit } : {}),
      ...(typeof appVersion === "string" ? { app_version: appVersion } : {}),
      error_reference: reference,
      error_fingerprint: errorFingerprint,
      incident_reference: incidentReference,
      inspector_state: inspectorState,
      recovery,
      route_template: routeTemplate,
      status,
    },
  };
};

export const captureRouteErrorLifecycle = (
  client: Pick<PostHog, "capture">,
  properties: RouteErrorLifecycleProperties,
) => {
  client.capture(WEB_ANALYTICS_EVENTS.routeErrorRecovery, {
    error_reference: properties.reference,
    error_fingerprint: properties.errorFingerprint,
    incident_reference: properties.incidentReference,
    inspector_state: properties.inspectorState,
    recovery: properties.recovery,
    route_template: properties.routeTemplate,
    status: properties.status,
  });
};
