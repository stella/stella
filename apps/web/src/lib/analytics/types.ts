import type { ErrorReference } from "@/lib/analytics/error-reference";

export const WEB_ANALYTICS_EVENTS = {
  exception: "$exception",
  identify: "$identify",
  pageViewed: "page_viewed",
  guideStepSkipped: "guide_step_skipped",
} as const;

export type WebAnalyticsEvent =
  (typeof WEB_ANALYTICS_EVENTS)[keyof typeof WEB_ANALYTICS_EVENTS];

export type Analytics = {
  captureError: (error: unknown, context?: ErrorCaptureContext) => void;
  capturePageViewed: (properties: PageViewedProperties) => void;
  captureGuideStepSkipped: (properties: GuideStepSkippedProperties) => void;
  identifyUser: (user: AnalyticsUserIdentity) => void;
  reset: (options?: AnalyticsResetOptions) => void;
};

// Why a guide step could not be shown against the live app surface. Emitted so
// divergence between a tour and the real UI is observed, not silent.
export type GuideStepSkippedReason = "anchor-missing" | "tour-empty";

export type GuideStepSkippedProperties = {
  tourId: string;
  anchorId: string;
  reason: GuideStepSkippedReason;
};

export type ErrorCaptureContext =
  | { type: "detached"; operation: string }
  | { type: "recovery"; reference: ErrorReference };

export type AnalyticsResetOptions = {
  onlyIfIdentified?: boolean;
};

export type PageViewedProperties = {
  path: string;
};

export type AnalyticsUserIdentity = {
  id: string;
};
