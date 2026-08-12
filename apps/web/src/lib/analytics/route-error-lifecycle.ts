import type { ErrorReference } from "@/lib/analytics/error-reference";
import type {
  Analytics,
  RouteErrorLifecycleProperties,
} from "@/lib/analytics/types";

export type RouteErrorAnalytics = Pick<
  Analytics,
  "captureError" | "captureRouteErrorLifecycle"
>;

export type RouteErrorIncident = Omit<RouteErrorLifecycleProperties, "status">;

export type ShowRouteErrorOptions = {
  error: unknown;
  recovery: RouteErrorIncident["recovery"];
  reference: ErrorReference;
};

export type RouteErrorLifecycleController = {
  caught: (routeTemplate: string) => void;
  routeResolved: (routeTemplate: string) => void;
  retryStarted: (
    reference: ErrorReference,
    recovery: RouteErrorIncident["recovery"],
  ) => void;
  shown: (options: ShowRouteErrorOptions) => void;
  updateInspectorState: (
    inspectorState: RouteErrorIncident["inspectorState"],
  ) => void;
};

export type RouteErrorLifecycleSnapshot = {
  inspectorState: RouteErrorIncident["inspectorState"];
  routeTemplate: string;
};

export const createRouteErrorLifecycleController = (
  analytics: RouteErrorAnalytics,
): RouteErrorLifecycleController => {
  let snapshot: RouteErrorLifecycleSnapshot = {
    inspectorState: "unavailable",
    routeTemplate: "unknown",
  };
  let loaded: Promise<RouteErrorLifecycleController | undefined> | undefined;
  const load = async () => {
    loaded ??= import("@/lib/analytics/route-error-lifecycle-loaded")
      .then((module) =>
        module.createLoadedRouteErrorLifecycleController(analytics, snapshot),
      )
      .catch((error: unknown) => {
        analytics.captureError(error, {
          operation: "route-error.load",
          type: "detached",
        });
        return undefined;
      });
    return await loaded;
  };
  const captureDispatchError = (error: unknown) => {
    analytics.captureError(error, {
      operation: "route-error.dispatch",
      type: "detached",
    });
  };
  const run = (action: (controller: RouteErrorLifecycleController) => void) => {
    load()
      .then((controller) => (controller ? action(controller) : undefined))
      .catch(captureDispatchError);
  };
  const runIfLoaded = (
    action: (controller: RouteErrorLifecycleController) => void,
  ) => {
    loaded
      ?.then((controller) => (controller ? action(controller) : undefined))
      .catch(captureDispatchError);
  };

  return {
    caught: (routeTemplate) => {
      run((controller) => controller.caught(routeTemplate));
    },
    routeResolved: (routeTemplate) => {
      snapshot = { ...snapshot, routeTemplate };
      runIfLoaded((controller) => controller.routeResolved(routeTemplate));
    },
    retryStarted: (reference, recovery) => {
      run((controller) => controller.retryStarted(reference, recovery));
    },
    shown: (options) => {
      run((controller) => controller.shown(options));
    },
    updateInspectorState: (inspectorState) => {
      snapshot = { ...snapshot, inspectorState };
      runIfLoaded((controller) =>
        controller.updateInspectorState(inspectorState),
      );
    },
  };
};
