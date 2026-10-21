import { expect, test } from "bun:test";

import { declareRouteShellProviderFixture } from "@/__fixtures__/route-shell/route-shell-provider-fixture";
import {
  APP_FRAME_SCOPE,
  matchedAppFrameScope,
} from "@/routes/-app-frame-scope";

test("the provider suite exercises the app-frame scope classifier", () => {
  expect(
    matchedAppFrameScope([
      { staticData: { appFrame: APP_FRAME_SCOPE.knowledge } },
    ]),
  ).toBe(APP_FRAME_SCOPE.knowledge);
});

await declareRouteShellProviderFixture({ mode: "public-knowledge" });
