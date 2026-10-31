import { expect, test } from "bun:test";

import { createDetached } from "./detached";
import { type ExceptionScope, exceptionScopeIdentity } from "./exception-scope";
import {
  getExceptionScopes,
  withExceptionScope,
} from "./exception-scope-context";

test("detached rejection captures retain nested request and job owners after their scopes return", async () => {
  const rejection = new Error("detached failure");
  const settled = Promise.withResolvers<{
    error: unknown;
    context: string;
    scopes: readonly ExceptionScope[];
  }>();
  const operation = Promise.withResolvers<undefined>();
  const detached = createDetached((error, context) => {
    settled.resolve({ error, context, scopes: getExceptionScopes() });
  });
  const request = {
    type: "request",
    method: "GET",
    routeTemplate: "/a/:id",
  } as const;
  const job = { type: "job", jobId: "repair", task: "index" } as const;
  const handler = {
    type: "handler",
    handlerId: "shared.reportFailure",
  } as const;
  withExceptionScope(request, () =>
    withExceptionScope(job, () =>
      withExceptionScope(handler, () => {
        expect(getExceptionScopes()).toEqual([request, job, handler]);
        detached(operation.promise, "shared.reportFailure");
      }),
    ),
  );
  expect(getExceptionScopes()).toEqual([]);
  operation.reject(rejection);
  expect(await settled.promise).toEqual({
    error: rejection,
    context: "shared.reportFailure",
    scopes: [request, job, handler],
  });
  expect(getExceptionScopes()).toEqual([]);
});

test("concurrent captures retain additive scopes without leaking between executions", async () => {
  const scope = { type: "handler", handlerId: "shared.reportFailure" } as const;
  const results = await Promise.all(
    ["first", "second"].map(async (jobId) =>
      withExceptionScope({ type: "job", jobId, task: "repair" }, async () => {
        await Promise.resolve();
        return await withExceptionScope(scope, async () => {
          await Promise.resolve();
          return getExceptionScopes().map(exceptionScopeIdentity);
        });
      }),
    ),
  );
  expect(results).toEqual([
    ['["job","first","repair"]', '["handler","shared.reportFailure"]'],
    ['["job","second","repair"]', '["handler","shared.reportFailure"]'],
  ]);
  expect(getExceptionScopes()).toEqual([]);
});
