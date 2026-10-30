import { expect, test } from "bun:test";

import { exceptionScopeIdentity } from "./exception-scope";

test("scope identities retain their kind and named dimensions", () => {
  expect(
    exceptionScopeIdentity({
      type: "request",
      method: "GET",
      routeTemplate: "/files/:fileId",
    }),
  ).toBe('["request","GET","/files/:fileId"]');
  expect(
    exceptionScopeIdentity({ type: "handler", handlerId: "files.read" }),
  ).toBe('["handler","files.read"]');
  expect(
    exceptionScopeIdentity({ type: "job", jobId: "nightly", task: "repair" }),
  ).toBe('["job","nightly","repair"]');
  expect(
    exceptionScopeIdentity({ type: "ingestion", adapterKey: "court" }),
  ).toBe('["ingestion","court"]');
});
