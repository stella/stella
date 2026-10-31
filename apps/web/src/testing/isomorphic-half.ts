import { AsyncLocalStorage } from "node:async_hooks";

type IsomorphicTestHalf = "client" | "server";

const testHalf = new AsyncLocalStorage<IsomorphicTestHalf>();

export const currentTestIsomorphicHalf = (): IsomorphicTestHalf =>
  testHalf.getStore() ?? "client";

export const withTestServerIsomorphicHalf = <T>(scenario: () => T): T =>
  testHalf.run("server", scenario);
