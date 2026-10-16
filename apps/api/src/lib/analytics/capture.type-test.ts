import {
  captureError,
  captureObservedError,
  captureRequestError,
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
  // @ts-expect-error A string key is not a typed execution scope.
  captureObservedError(error, {
    observation: undefined,
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
