import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

const RULE = "mobile-window-overlay-owner";

test("reports the window overlay however it is imported", async () => {
  expect(
    await lintSingleRule(
      RULE,
      'import { FullWindowOverlay } from "react-native-screens";\nimport { FullWindowOverlay as Overlay } from "react-native-screens";\nimport * as Screens from "react-native-screens";\nconst Layer = Screens.FullWindowOverlay;',
      {
        cwd: "scratch",
        sourcePath: "apps/mobile/src/components/run-banner.tsx",
      },
    ),
  ).toEqual([1, 2, 4]);
});

test("allows the rest of react-native-screens", async () => {
  expect(
    await lintSingleRule(
      RULE,
      'import { enableScreens } from "react-native-screens";\nenableScreens();',
      { cwd: "scratch", sourcePath: "apps/mobile/src/app/_layout.tsx" },
    ),
  ).toEqual([]);
});

test("allows the owner to reach the window layer", async () => {
  expect(
    await lintSingleRule(
      RULE,
      'import { FullWindowOverlay } from "react-native-screens";\nexport const Layer = FullWindowOverlay;',
      {
        cwd: "scratch",
        sourcePath: "apps/mobile/src/components/window-overlay.tsx",
      },
    ),
  ).toEqual([]);
});

test("keeps a copy of the owner restricted", async () => {
  expect(
    await lintSingleRule(
      RULE,
      'import { FullWindowOverlay } from "react-native-screens";',
      {
        cwd: "scratch",
        sourcePath: "apps/mobile/src/components/window-overlay.copy.tsx",
      },
    ),
  ).toEqual([1]);
});
