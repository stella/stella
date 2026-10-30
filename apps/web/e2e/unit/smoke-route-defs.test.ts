import { expect, test } from "bun:test";

import { SMOKE_ROUTE_DEFS } from "../helpers/smoke-route-defs";

test("the granted list fixture measures the list page in place", () => {
  const route = SMOKE_ROUTE_DEFS.find(
    ({ template }) => template === "/workspaces/$workspaceId/lists",
  );
  expect(route).toBeDefined();
  expect(route?.expectation?.kind ?? "rendersInPlace").toBe("rendersInPlace");
});
