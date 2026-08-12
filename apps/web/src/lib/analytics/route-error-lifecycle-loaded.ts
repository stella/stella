import { fingerprintTelemetryError } from "@/lib/analytics/error-fingerprint";
import type {
  RouteErrorAnalytics,
  RouteErrorIncident,
  RouteErrorLifecycleController,
  RouteErrorLifecycleSnapshot,
  ShowRouteErrorOptions,
} from "@/lib/analytics/route-error-lifecycle";
import type { RouteErrorLifecycleProperties } from "@/lib/analytics/types";

type RouteErrorLifecycleState =
  | { type: "idle" }
  | {
      type: "caught";
      routeTemplate: string;
      priorIncident?: RouteErrorIncident;
    }
  | { type: "visible"; incident: RouteErrorIncident }
  | { type: "retrying"; incident: RouteErrorIncident };

export const createLoadedRouteErrorLifecycleController = (
  analytics: RouteErrorAnalytics,
  initial: RouteErrorLifecycleSnapshot,
): RouteErrorLifecycleController => {
  let state: RouteErrorLifecycleState = { type: "idle" };
  let currentRouteTemplate = initial.routeTemplate;
  let inspectorState = initial.inspectorState;

  const capture = (
    incident: RouteErrorIncident,
    status: RouteErrorLifecycleProperties["status"],
  ) => {
    analytics.captureRouteErrorLifecycle({ ...incident, status });
  };

  const caught = (routeTemplate: string) => {
    state =
      state.type === "retrying"
        ? { priorIncident: state.incident, routeTemplate, type: "caught" }
        : { routeTemplate, type: "caught" };
  };

  const shown = ({ error, recovery, reference }: ShowRouteErrorOptions) => {
    if (state.type === "visible" && state.incident.reference === reference) {
      return;
    }
    const priorIncident = state.type === "caught" ? state.priorIncident : null;
    const routeTemplate =
      state.type === "caught" ? state.routeTemplate : currentRouteTemplate;
    const incident: RouteErrorIncident = {
      errorFingerprint: fingerprintTelemetryError(error),
      incidentReference: priorIncident?.incidentReference ?? reference,
      inspectorState,
      recovery,
      reference,
      routeTemplate,
    };
    state = { incident, type: "visible" };
    analytics.captureError(error, { type: "recovery", reference });
    capture(incident, priorIncident ? "recurred" : "shown");
  };

  const retryStarted: RouteErrorLifecycleController["retryStarted"] = (
    reference,
    recovery,
  ) => {
    if (state.type !== "visible" || state.incident.reference !== reference) {
      return;
    }
    const incident = { ...state.incident, recovery };
    if (recovery === "retry-route") {
      state = { incident, type: "retrying" };
    }
    capture(incident, "retry_started");
  };

  const routeResolved = (routeTemplate: string) => {
    currentRouteTemplate = routeTemplate;
    if (state.type === "retrying") {
      state = { type: "idle" };
    }
  };

  return {
    caught,
    retryStarted,
    routeResolved,
    shown,
    updateInspectorState: (nextInspectorState) => {
      inspectorState = nextInspectorState;
    },
  };
};
