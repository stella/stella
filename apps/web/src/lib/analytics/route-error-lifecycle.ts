import type { ErrorReference } from "@/lib/analytics/error-reference";
import { routeExceptionFingerprintKey } from "@/lib/analytics/exception-fingerprint";
import { reportErrorOnce } from "@/lib/analytics/reported-error";
import type {
  Analytics,
  RouteErrorLifecycleProperties,
} from "@/lib/analytics/types";
import { detached } from "@/lib/detached";
import { isStaleDeploymentLoadError } from "@/lib/preload-error-recovery";

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
  ) => Promise<void>;
  shown: (options: ShowRouteErrorOptions) => void;
  updateInspectorState: (
    inspectorState: RouteErrorIncident["inspectorState"],
  ) => void;
};

export type RouteErrorLifecycleSnapshot = {
  inspectorState: RouteErrorIncident["inspectorState"];
  routeTemplate: string;
};

export const resolveCaughtRouteTemplate = (
  matches: readonly { fullPath: string; status?: string }[],
): string =>
  matches.findLast(({ status }) => status === "error")?.fullPath ??
  matches.at(-1)?.fullPath ??
  "unknown";

type LoadedRouteErrorLifecycleModule = {
  createLoadedRouteErrorLifecycleController: (
    analytics: RouteErrorAnalytics,
    initial: RouteErrorLifecycleSnapshot,
  ) => RouteErrorLifecycleController;
};

export const createRouteErrorLifecycleController = (
  analytics: RouteErrorAnalytics,
  loadModule: () => Promise<LoadedRouteErrorLifecycleModule> = async () =>
    import("@/lib/analytics/route-error-lifecycle-loaded"),
): RouteErrorLifecycleController => {
  let snapshot: RouteErrorLifecycleSnapshot = {
    inspectorState: "unavailable",
    routeTemplate: "unknown",
  };
  let loaded: Promise<RouteErrorLifecycleController | undefined> | undefined;
  let capturedReference: ErrorReference | undefined;
  let caughtRouteTemplate: string | undefined;
  const load = async () => {
    if (!loaded) {
      const initial = snapshot;
      loaded = loadModule()
        .then((module) =>
          module.createLoadedRouteErrorLifecycleController(analytics, initial),
        )
        .catch((error: unknown) => {
          // Vite's preload helper also dispatches this rejection as
          // `vite:preloadError`, so preload recovery owns a stale chunk. Its
          // redacted exception carries no message and no in-app frame.
          if (isStaleDeploymentLoadError(error)) {
            return undefined;
          }
          analytics.captureError(error, {
            fingerprintKey: "createRouteErrorLifecycleController.load:failure",
            scope: {
              type: "handler",
              handlerId: "createRouteErrorLifecycleController.load:failure",
            },
            context: {
              operation: "route-error.load",
              type: "detached",
            },
          });
          return undefined;
        });
    }
    return await loaded;
  };
  const captureDispatchError = (error: unknown) => {
    analytics.captureError(error, {
      fingerprintKey:
        "createRouteErrorLifecycleController.captureDispatchError:failure",
      scope: {
        type: "handler",
        handlerId:
          "createRouteErrorLifecycleController.captureDispatchError:failure",
      },
      context: {
        operation: "route-error.dispatch",
        type: "detached",
      },
    });
  };
  const run = async (
    action: (controller: RouteErrorLifecycleController) => void | Promise<void>,
  ): Promise<void> => {
    const controller = await load();
    if (!controller) {
      return;
    }
    await Promise.resolve(action(controller)).catch(captureDispatchError);
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
      caughtRouteTemplate = routeTemplate;
      detached(
        run((controller) => controller.caught(routeTemplate)),
        "route-error.caught",
      );
    },
    routeResolved: (routeTemplate) => {
      caughtRouteTemplate = undefined;
      snapshot = { ...snapshot, routeTemplate };
      runIfLoaded((controller) => controller.routeResolved(routeTemplate));
    },
    retryStarted: async (reference, recovery) =>
      run(async (controller) => {
        await controller.retryStarted(reference, recovery);
      }),
    shown: (options) => {
      if (capturedReference !== options.reference) {
        capturedReference = options.reference;
        reportErrorOnce(options.error, (error) => {
          analytics.captureError(error, {
            fingerprintKey: routeExceptionFingerprintKey(
              caughtRouteTemplate ?? snapshot.routeTemplate,
            ),
            scope: {
              type: "request",
              method: "GET",
              routeTemplate: caughtRouteTemplate ?? snapshot.routeTemplate,
            },
            context: {
              reference: options.reference,
              type: "recovery",
            },
          });
        });
      }
      detached(
        run((controller) => controller.shown(options)),
        "route-error.shown",
      );
    },
    updateInspectorState: (inspectorState) => {
      snapshot = { ...snapshot, inspectorState };
      runIfLoaded((controller) =>
        controller.updateInspectorState(inspectorState),
      );
    },
  };
};
