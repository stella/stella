import { panic } from "better-result";

/** The reason a promise rejects with; a promise that resolves fails the test. */
export const rejectionOf = async (
  promise: PromiseLike<unknown>,
): Promise<unknown> =>
  await promise.then(
    (value) =>
      panic(
        `Expected a rejection, but the promise resolved with ${String(value)}`,
      ),
    (error: unknown) => error,
  );
