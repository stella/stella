import { captureError } from "@/api/lib/analytics/capture";

/**
 * Run a promise as fire-and-forget work, routing any rejection to the shared
 * error-capture channel instead of letting it surface as an unhandled
 * rejection. Use this only for genuinely detached work (best-effort cache
 * warming, cleanup, telemetry). When a caller needs the result or must react
 * to failure, `await` the promise or propagate it instead.
 *
 * `context` is a short, stable label identifying the call site (for example
 * `"account-cleanup.reconcile"`). Keep it a fixed string; never interpolate
 * identifiers, so it stays a safe correlation tag in telemetry.
 */
export const detached = (
  // A thenable to attach a catch to, or a synchronous/absent (void/undefined)
  // value we simply ignore — parity with the `void` operator this helper
  // replaces. `Promise.resolve` below normalises either shape.
  // eslint-disable-next-line typescript/no-invalid-void-type
  promise: PromiseLike<unknown> | void,
  context: string,
): void => {
  Promise.resolve(promise).catch((error: unknown) => {
    captureError(error, { detached: context });
  });
};
