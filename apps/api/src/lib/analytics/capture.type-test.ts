import { handlerErrorContext } from "@stll/errors/exception-context";

import {
  captureError,
  captureObservedError,
  captureRequestError,
  createErrorCapture,
} from "@/api/lib/analytics/capture";

// Every capture needs a source-owned path, including errors without stacks.
export const framelessCaptureRequiresKey = (
  error: unknown,
  request: Request,
) => {
  // @ts-expect-error A frameless capture must supply an explicit stable key.
  captureError(error);
  // @ts-expect-error Correlation context cannot stand in for the stable key.
  captureError(error, { source: "worker" });
  // @ts-expect-error Request correlation does not identify the owning path.
  captureRequestError(error, { request });
  // @ts-expect-error A prior observation does not identify the owning path.
  captureObservedError(error, { observation: undefined });
  // @ts-expect-error A path cannot replace execution scope.
  captureError(error, { fingerprintKey: "worker.processJob" });
  // @ts-expect-error Request captures require method and declared route scope.
  captureRequestError(error, { request, fingerprintKey: "request.handle" });
  captureObservedError(error, {
    observation: undefined,
    // @ts-expect-error A string key is not a typed execution scope.
    scope: "request.handle",
    fingerprintKey: "request.handle",
  });
  captureError(error, {
    fingerprintKey: "worker.processJob",
    scope: { type: "job", jobId: "nightly", task: "repair" },
  });
  captureRequestError(error, {
    request,
    fingerprintKey: "request.handle",
    scope: { type: "request", method: "GET", routeTemplate: "/files/:id" },
  });
  captureObservedError(error, {
    observation: undefined,
    fingerprintKey: "worker.observeJob",
    scope: { type: "job", jobId: "nightly", task: "repair" },
  });
};

export const requestAttributionRequiresRequestCapture = (
  error: unknown,
  request: Request,
) => {
  const options = { request, ...handlerErrorContext("request.handle") };
  // @ts-expect-error Request-bearing variables must use the request-aware capture.
  captureError(error, options);
  // @ts-expect-error A spread cannot discard request attribution through frameless capture.
  captureError(error, { ...handlerErrorContext("request.handle"), request });
  // @ts-expect-error Bound callbacks cannot discard request attribution.
  createErrorCapture(options);
  captureRequestError(error, options);
};
