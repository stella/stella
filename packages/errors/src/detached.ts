// parser-output-unchanged: requires symbolic rejection labels in types; detached promise handling and parser results are unchanged.
// Fire-and-forget work, shared by the API and web apps. Both route a detached
// rejection to their own error-capture channel; that channel is the only part
// that differs, so it is injected and the helper itself lives here once.
import { TaggedError } from "better-result";

/** Receives a detached rejection with the call site's label. */
export type DetachedRejectionSink = (
  error: unknown,
  context: `${string}.${string}`,
) => void;

/**
 * What a `void` operator would accept, except a function: a function operand
 * is work that was never started (`detached(() => flush())`), so it would be
 * dropped without running. Functions carry `call`; promises and plain values
 * do not.
 */
export type DetachedOperand =
  | PromiseLike<unknown>
  | (object & { call?: never })
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined;

export class DetachedFunctionOperandError extends TaggedError(
  "DetachedFunctionOperandError",
)<{ message: string; context: string }> {}

/**
 * Build an app's `detached(operation, context)`: run a promise as
 * fire-and-forget work, routing any rejection to `onRejection` instead of
 * letting it surface as an unhandled rejection.
 *
 * The operand may be anything a `void` operator would accept: a thenable to
 * attach a catch to, or a synchronous or absent value that is simply ignored.
 * `Promise.resolve` normalises whatever comes in. A function is refused: the
 * types reject it, and at run time it reaches `onRejection` as an error
 * instead of being dropped unstarted.
 */
export const createDetached =
  (onRejection: DetachedRejectionSink) =>
  (operation: DetachedOperand, context: `${string}.${string}`): void => {
    if (typeof operation === "function") {
      onRejection(
        new DetachedFunctionOperandError({
          message: `detached(${context}) received a function, not started work`,
          context,
        }),
        context,
      );
      return;
    }
    Promise.resolve(operation).catch((error: unknown) => {
      onRejection(error, context);
    });
  };
