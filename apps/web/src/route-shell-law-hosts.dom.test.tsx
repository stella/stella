import { expect, test } from "bun:test";

import { declareRouteShellProviderFixture } from "@/__fixtures__/route-shell/route-shell-provider-fixture";
import {
  APP_FRAME_SCOPE,
  matchedAppFrameScope,
} from "@/routes/-app-frame-scope";

test("the law-host suite exercises the deepest app-frame declaration", () => {
  expect(
    matchedAppFrameScope([
      { staticData: { appFrame: APP_FRAME_SCOPE.knowledge } },
      { staticData: { appFrame: APP_FRAME_SCOPE.none } },
      { staticData: {} },
    ]),
  ).toBe(APP_FRAME_SCOPE.none);
});

await declareRouteShellProviderFixture({
  mode: "public-knowledge",
  suite: "law-hosts",
});
