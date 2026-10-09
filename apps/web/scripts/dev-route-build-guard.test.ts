import { expect, test } from "bun:test";

import {
  assertNoDevRouteModules,
  devRouteBuildGuard,
} from "../dev-route-build-guard";

test("production chunks reject the dev route and its playground modules", () => {
  expect(devRouteBuildGuard().apply).toBe("build");
  for (const id of [
    "/app/src/routes/dev.tsx",
    "/app/src/routes/dev.tsx?tsr-split=component",
    "/app/src/routes/dev/-visual-registry.tsx",
    "/app/src/routes/dev/-components/new-fixture.tsx",
    "/app/src/routes/dev/-components/autocomplete-playground.tsx",
    "C:\\app\\src\\routes\\dev\\-components\\new-fixture.tsx",
  ]) {
    expect(() => assertNoDevRouteModules([id])).toThrow(
      "Production bundle contains a dev visual module",
    );
  }
  expect(() =>
    assertNoDevRouteModules([
      "/app/src/routes/index.tsx",
      "/app/src/routes/device.tsx",
      "/app/src/components/dev/public-law-connection-item.tsx",
    ]),
  ).not.toThrow();
});
