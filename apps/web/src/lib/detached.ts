import { getAnalytics } from "@/lib/analytics/provider";

/**
 * Run a promise as fire-and-forget work, routing any rejection to the
 * analytics error-capture channel instead of letting it surface as an
 * unhandled rejection. Use this only for genuinely detached work (navigation
 * we do not await, cache warming, prefetch, best-effort mutations). When a
 * caller needs the result or must react to failure, `await` the promise or
 * propagate it instead.
 *
 * `context` is a short, stable label identifying the call site (for example
 * `"chat-thread.prefetch"`). Keep it a fixed string; never interpolate
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
    getAnalytics().captureError(error, { detached: context });
  });
};
