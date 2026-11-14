import { CancelledError } from "@tanstack/react-query";
import { panic } from "better-result";

import type { Analytics, ErrorCaptureContext } from "@/lib/analytics/types";
import { logDevError } from "@/lib/errors/telemetry";

const noop = () => undefined;
const noopAsync = async () => {
  await Promise.resolve();
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

export const noopAnalytics: Analytics = {
  captureError: (error, { context }) => {
    if (error instanceof CancelledError) {
      return;
    }
    logDevError(error, devErrorContext(context));
  },
  capturePageViewed: noop,
  capturePageHangSuspected: noop,
  captureLongAnimationFrame: noop,
  captureGuideStepSkipped: noop,
  captureProvisionPlacementGaps: noop,
  captureCaseLawAnalysisTiming: noop,
  captureInspectorRestoreRecovered: noop,
  captureFollowupShown: noop,
  captureFollowupSelected: noop,
  captureKeyActionTiming: noop,
  captureFeedbackDialogOpened: noop,
  captureFeedbackReportSubmitted: noop,
  captureRouteErrorLifecycle: noopAsync,
  identifyUser: noop,
  reset: noop,
};
