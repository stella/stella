import type { FeedbackArea, FeedbackKind } from "@stll/api-contract/feedback";
import type {
  ProvisionPlacementFailureKind,
  ProvisionPlacementFailureReason,
} from "@stll/api-contract/provision-placement";
import type { ExceptionScope } from "@stll/errors";

import type { ErrorReference } from "@/lib/analytics/error-reference";
import type { ExceptionFingerprintKey } from "@/lib/analytics/exception-fingerprint";
import type { KeyActionDurationBucketMs } from "@/lib/analytics/key-action-timing";

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
  feedbackDialogOpened: "feedback_dialog_opened",
  feedbackReportSubmitted: "feedback_report_submitted",
  provisionPlacementGaps: "provision_placement_gaps",
  caseLawAnalysisTiming: "case_law_analysis_timing",
  pageHangSuspected: "web_page_hang_suspected",
  longAnimationFrame: "web_long_animation_frame",
  inspectorRestoreRecovered: "inspector_restore_recovered",
  followupShown: "followup_shown",
  followupSelected: "followup_selected",
  keyActionTimed: "key_action_timed",
} as const;

export type WebAnalyticsEvent =
  (typeof WEB_ANALYTICS_EVENTS)[keyof typeof WEB_ANALYTICS_EVENTS];

// An API client error envelope carries the API status and raw body;
// captured raw, analytics loses both. Callers convert it with `toAPIError`.
type ApiErrorEnvelope = { status: number; value: unknown };

export type NotApiErrorEnvelope<E> = E extends Error
  ? E
  : E extends ApiErrorEnvelope
    ? never
    : E;

type ErrorCaptureOptions = {
  scope: ExceptionScope;
  fingerprintKey: ExceptionFingerprintKey;
  context?: ErrorCaptureContext;
};

export type Analytics = {
  captureError: <E>(
    error: E & NotApiErrorEnvelope<E>,
    options: ErrorCaptureOptions,
  ) => void;
  capturePageViewed: (properties: PageViewedProperties) => void;
  capturePageHangSuspected: (properties: PageHangSuspectedProperties) => void;
  captureLongAnimationFrame: (properties: LongAnimationFrameProperties) => void;
  captureGuideStepSkipped: (properties: GuideStepSkippedProperties) => void;
  captureFeedbackDialogOpened: (
    properties: FeedbackDialogOpenedProperties,
  ) => void;
  captureFeedbackReportSubmitted: (
    properties: FeedbackDialogSubmittedProperties,
  ) => void;
  captureProvisionPlacementGaps: (
    properties: ProvisionPlacementGapsProperties,
  ) => void;
  captureCaseLawAnalysisTiming: (
    properties: CaseLawAnalysisTimingProperties,
  ) => void;
  captureInspectorRestoreRecovered: (
    properties: InspectorRestoreRecoveredProperties,
  ) => void;
  captureFollowupShown: (properties: FollowupShownProperties) => void;
  captureFollowupSelected: (properties: FollowupSelectedProperties) => void;
  captureKeyActionTiming: (properties: KeyActionTiming) => void;
  captureRouteErrorLifecycle: (
    properties: RouteErrorLifecycleProperties,
  ) => Promise<void>;
  identifyUser: (user: AnalyticsUserIdentity) => void;
  reset: (options?: AnalyticsResetOptions) => void;
};

export type FollowupSurface =
  "chat-thread" | "document-chat" | "inspector-chat";

// Click-through needs where and how a suggestion was used, never which
// conversation it came from.
type FollowupProperties = {
  source: "generated";
  surface: FollowupSurface;
};

type FollowupShownProperties = FollowupProperties & {
  count: number;
};

type FollowupSelectedProperties = FollowupProperties & {
  index: number;
  via: "chip" | "ghost-tab";
};

export type DocumentTimingSurface = "full-view" | "inspector";

export type SearchTimingSurface = "case-law" | "legislation";

export type ChatTimingSurface = FollowupSurface | "template-studio";

/** One user-visible action and where it ran. The surface is the only
 *  context a timing carries: no document, query, thread or message
 *  identifies what the action touched. */
export type KeyActionMeasure =
  // Click on a document until its editor accepts input.
  | { action: "document-open"; surface: DocumentTimingSurface }
  // A checkpoint save from snapshot to the server's confirmation.
  | { action: "document-save"; surface: DocumentTimingSurface }
  // A changed search query until its first result page is on screen.
  | { action: "search-results"; surface: SearchTimingSurface }
  // A sent chat message until the reply starts streaming, and until it ends.
  | { action: "chat-first-token" | "chat-total"; surface: ChatTimingSurface };

export type KeyActionTiming = KeyActionMeasure & {
  durationBucketMs: KeyActionDurationBucketMs;
};

// Why a guide step could not be shown against the live app surface. Emitted so
// divergence between a tour and the real UI is observed, not silent.
//
// Discriminated rather than a flat record with optional fields: `tour-empty`
// describes the whole run and has no one anchor to name, and a placeholder
// there would be a value no dashboard filter can match.
type GuideStepSkippedProperties =
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

/** Which surface opened the feedback dialog. Reports arriving from the route
 *  error screen carry a reference the sidebar ones never have, so the two are
 *  distinguished at the source rather than inferred from the payload. */
export type FeedbackReportSource = "sidebar" | "route_error";

type FeedbackDialogOpenedProperties = {
  source: FeedbackReportSource;
};

// Classification only: the report's own text never reaches analytics.
type FeedbackDialogSubmittedProperties = {
  area: FeedbackArea;
  kind: FeedbackKind;
  source: FeedbackReportSource;
};

export type ErrorCaptureContext =
  | { type: "detached"; operation: string }
  | { type: "recovery"; reference: ErrorReference }
  | {
      type: "user-visible";
      feature: string;
      routeTemplate: string;
    };

// Stored citations a decision reader could not place: one event per decision,
// reader surface and reason, counting the rows. A placement gap is a data
// outcome (corpus coverage or linker drift), not an exception.
/** The inspector restored its tabs minimized because the previous load never
 *  settled after restoring them. Counts only, never tab content. */
type InspectorRestoreRecoveredProperties = {
  tabCount: number;
};

type ProvisionPlacementGapsProperties = {
  surface: string;
  kind: ProvisionPlacementFailureKind;
  reason: ProvisionPlacementFailureReason;
  count: number;
};

type CaseLawAnalysisTimingProperties = {
  ms_to_first_section: number | null;
  ms_to_done: number | null;
  outcome: "done" | "error" | "left";
  from_store: boolean;
};

export type AnalyticsResetOptions = {
  onlyIfIdentified?: boolean;
};

type PageViewedProperties = {
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

type AnalyticsUserIdentity = {
  id: string;
  // Attached as the `organization` group so insights can aggregate and
  // break down by organization, not just by person.
  activeOrganizationId: string;
};

type PageHangSuspectedProperties = {
  routeTemplate: string;
  phase: "boot" | "session";
  build: string;
  restoredState: readonly { key: string; bytes: number }[];
};

type LongAnimationFrameProperties = {
  duration: number;
  scripts: readonly {
    invoker: string;
    sourceURL: string;
    sourceFunctionName: string;
  }[];
};
