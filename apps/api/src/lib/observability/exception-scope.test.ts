import { expect, test } from "bun:test";

import { exceptionScopeIdentity } from "@stll/errors";
import { withExceptionScope as withSharedExceptionScope } from "@stll/errors/exception-scope-context";

import {
  getRequestExceptionScopes,
  withExceptionScope,
} from "./exception-scope";

test("concurrent captures retain additive scopes without leaking between executions", async () => {
  const scope = { type: "handler", handlerId: "shared.reportFailure" } as const;
  const results = await Promise.all(
    ["first", "second"].map(
      async (jobId) =>
        await withSharedExceptionScope(
          { type: "job", jobId, task: "repair" },
          async () => {
            await Promise.resolve();
            return await withExceptionScope(scope, async () => {
              await Promise.resolve();
              return getRequestExceptionScopes().map(exceptionScopeIdentity);
            });
          },
        ),
    ),
  );
  expect(results).toEqual([
    ['["job","first","repair"]', '["handler","shared.reportFailure"]'],
    ['["job","second","repair"]', '["handler","shared.reportFailure"]'],
  ]);
  expect(getRequestExceptionScopes()).toEqual([]);
});
