import { expect, test } from "bun:test";

import { declareRouteShellProviderFixture } from "@/__fixtures__/route-shell/route-shell-provider-fixture";
import {
  APP_FRAME_SCOPE,
  matchedAppFrameScope,
} from "@/routes/-app-frame-scope";

test("the legacy provider suite exercises the app-frame scope classifier", () => {
  expect(
    matchedAppFrameScope([
      { staticData: { appFrame: APP_FRAME_SCOPE.member } },
    ]),
  ).toBe(APP_FRAME_SCOPE.member);
});

await declareRouteShellProviderFixture({ mode: "legacy-tools" });
