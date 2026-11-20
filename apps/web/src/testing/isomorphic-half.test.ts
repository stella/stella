import { createIsomorphicFn } from "@tanstack/react-start";
import { expect, test } from "bun:test";

import { withTestServerIsomorphicHalf } from "./isomorphic-half";

test("isomorphic fixture runs only the selected branch, including concurrent scopes", async () => {
  const serverOnly = createIsomorphicFn().server(() => "server-only");
  const clientOnly = createIsomorphicFn().client(() => "client-only");
  const both = createIsomorphicFn()
    .server(() => "server")
    .client(() => "client");

  expect(serverOnly()).toBeUndefined();
  expect(clientOnly()).toBe("client-only");
  expect(both()).toBe("client");

  const release = Promise.withResolvers<undefined>();
  const pending = withTestServerIsomorphicHalf(async () => {
    expect(serverOnly()).toBe("server-only");
    expect(clientOnly()).toBeUndefined();
    expect(both()).toBe("server");
    await withTestServerIsomorphicHalf(async () => {
      expect(both()).toBe("server");
      await Promise.resolve();
      expect(both()).toBe("server");
    });
    await release.promise;
    expect(both()).toBe("server");
  });
  expect(both()).toBe("client");
  release.resolve(undefined);
  await pending;
  expect(both()).toBe("client");
});
