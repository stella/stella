// parser-output-unchanged: tracks exception ownership without changing parser values.
import { AsyncLocalStorage } from "node:async_hooks";

import type { ExceptionScope } from "./exception-scope";

const captureScope = new AsyncLocalStorage<readonly ExceptionScope[]>();

/** Scope every nested capture, including detached continuations, at its owner. */
export const withExceptionScope = <TResult>(
  scope: ExceptionScope,
  operation: () => TResult,
): TResult =>
  captureScope.run([...(captureScope.getStore() ?? []), scope], operation);

export const getExceptionScopes = (): readonly ExceptionScope[] =>
  captureScope.getStore() ?? [];
