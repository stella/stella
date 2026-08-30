import type { ErrorReference } from "@/lib/analytics/error-reference";

export const WEB_ANALYTICS_EVENTS = {
  exception: "$exception",
  identify: "$identify",
  // The standard event name, so PostHog web analytics aggregates our page
  // views; the payload still carries route templates, never resolved URLs.
  pageViewed: "$pageview",
  // SDK-emitted on tab hide and close; web analytics derives bounce rate
  // and page duration from it. `before_send` maps its resolved URL back to
  // the route template.
  pageLeft: "$pageleave",
  // SDK-emitted performance metrics; `before_send` rebuilds the payload so
  // only metric values and coarse client context leave the browser.
  webVitals: "$web_vitals",
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
  ) => Promise<void>;
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
  // page. `route-unavailable` means the user has no authorized destination
  // matching the semantic route. `anchor-pending` is declared-unwired, so it
  // is expected noise until the owning surface lands.
  | {
      reason: "anchor-missing" | "anchor-pending" | "route-unavailable";
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
  // Attached as the `organization` group so insights can aggregate and
  // break down by organization, not just by person.
  activeOrganizationId: string;
};
