// Fire-and-forget work, shared by the API and web apps. Both route a detached
// rejection to their own error-capture channel; that channel is the only part
// that differs, so it is injected and the helper itself lives here once.

/** Receives a detached rejection with the call site's label. */
export type DetachedRejectionSink = (error: unknown, context: string) => void;

/**
 * Build an app's `detached(operation, context)`: run a promise as
 * fire-and-forget work, routing any rejection to `onRejection` instead of
 * letting it surface as an unhandled rejection.
 *
 * The operand may be anything a `void` operator would accept: a thenable to
 * attach a catch to, or a synchronous or absent value that is simply ignored.
 * `Promise.resolve` normalises whatever comes in.
 */
export const createDetached =
  (onRejection: DetachedRejectionSink) =>
  (operation: unknown, context: string): void => {
    Promise.resolve(operation).catch((error: unknown) => {
      onRejection(error, context);
    });
  };
