import type { ErrorReference } from "@/lib/analytics/error-reference";

export const WEB_ANALYTICS_EVENTS = {
  exception: "$exception",
  identify: "$identify",
  pageViewed: "page_viewed",
  guideStepSkipped: "guide_step_skipped",
  routeErrorRecovery: "route_error_recovery",
} as const;

export type WebAnalyticsEvent =
  (typeof WEB_ANALYTICS_EVENTS)[keyof typeof WEB_ANALYTICS_EVENTS];

export type Analytics = {
  captureError: (error: unknown, context?: ErrorCaptureContext) => void;
  capturePageViewed: (properties: PageViewedProperties) => void;
  captureGuideStepSkipped: (properties: GuideStepSkippedProperties) => void;
  captureRouteErrorLifecycle: (
    properties: RouteErrorLifecycleProperties,
  ) => void;
  identifyUser: (user: AnalyticsUserIdentity) => void;
  reset: (options?: AnalyticsResetOptions) => void;
};

// Why a guide step could not be shown against the live app surface. Emitted so
// divergence between a tour and the real UI is observed, not silent.
//
// Discriminated rather than a flat record with optional fields: `tour-empty`
// describes the whole run and has no one anchor to name, and a placeholder
// there would be a value no dashboard filter can match.
export type GuideStepSkippedProperties =
  // `anchor-missing` is real divergence: the anchor should have been on the
  // page. `anchor-pending` is declared-unwired, so it is expected noise until
  // the owning surface lands.
  | {
      reason: "anchor-missing" | "anchor-pending";
      tourId: string;
      anchorId: string;
    }
  | { reason: "tour-empty"; tourId: string };

export type ErrorCaptureContext =
  | { type: "detached"; operation: string }
  | { type: "recovery"; reference: ErrorReference };

export type AnalyticsResetOptions = {
  onlyIfIdentified?: boolean;
};

export type PageViewedProperties = {
  path: string;
};

type RouteErrorLifecycleCommon = {
  errorFingerprint: string;
  incidentReference: ErrorReference;
  inspectorState: "empty" | "minimized" | "open" | "unavailable";
  recovery: "reload-page" | "retry-route";
  reference: ErrorReference;
  routeTemplate: string;
};

export type RouteErrorLifecycleProperties = RouteErrorLifecycleCommon & {
  status: "shown" | "retry_started" | "recurred";
};

export type AnalyticsUserIdentity = {
  id: string;
};
