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
  captureError(error, { fingerprintKey: "worker.processJob" });
  captureRequestError(error, { request, fingerprintKey: "request.handle" });
  captureObservedError(error, {
    observation: undefined,
    fingerprintKey: "worker.observeJob",
  });
};
