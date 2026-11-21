import { expect, test } from "bun:test";

import { APP_FRAME_SCOPE, matchedAppFrameScope } from "./-app-frame-scope";
import { selectAppFrame } from "./-app-frame.logic";

test("the nearest declared shell scope owns descendant matches", () => {
  expect(
    matchedAppFrameScope([
      { staticData: { appFrame: APP_FRAME_SCOPE.none } },
      { staticData: { appFrame: APP_FRAME_SCOPE.member } },
      { staticData: {} },
    ]),
  ).toBe(APP_FRAME_SCOPE.member);
  expect(
    matchedAppFrameScope([
      { staticData: { appFrame: APP_FRAME_SCOPE.member } },
      { staticData: { appFrame: APP_FRAME_SCOPE.none } },
    ]),
  ).toBe(APP_FRAME_SCOPE.none);
  expect(matchedAppFrameScope([])).toBe(APP_FRAME_SCOPE.none);
});

test("shell selection follows declared scope across route names", () => {
  for (const routeIds of [
    ["__root__", "/new-section"],
    ["__root__", "/law"],
    ["__root__", "/_protected"],
  ]) {
    expect(
      selectAppFrame({
        scope: APP_FRAME_SCOPE.member,
        routeIds,
        hasRouteUser: true,
        publicKnowledge: true,
      }),
    ).toBe("member");
    expect(
      selectAppFrame({
        scope: APP_FRAME_SCOPE.none,
        routeIds,
        hasRouteUser: true,
        publicKnowledge: true,
      }),
    ).toBe("none");
  }
});
