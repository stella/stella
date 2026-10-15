import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects missing positioner and popup sizing contracts", async () => {
  expect(
    await lintSingleRule(
      "require-in-flow-viewport-popup",
      "const view = <Menu.Positioner>\n <Menu.Popup><Menu.Viewport /></Menu.Popup>\n</Menu.Positioner>;",
      { sourcePath: "apps/web/src/components/example.tsx" },
    ),
  ).toEqual([1, 2]);
});

test("rejects a missing popup contract independently", async () => {
  expect(
    await lintSingleRule(
      "require-in-flow-viewport-popup",
      "const view = <Menu.Positioner className={CONTENT_SIZED_POSITIONER_CLASS_NAME}>\n <Menu.Popup><Menu.Viewport /></Menu.Popup>\n</Menu.Positioner>;",
      { sourcePath: "apps/web/src/components/example.tsx" },
    ),
  ).toEqual([2]);
});

test("rejects constants carried only in a conditional arm", async () => {
  expect(
    await lintSingleRule(
      "require-in-flow-viewport-popup",
      'const view = <Menu.Positioner className={ok ? CONTENT_SIZED_POSITIONER_CLASS_NAME : "w-max"}>\n <Menu.Popup className={ok && IN_FLOW_POPUP_CLASS_NAME}><Menu.Viewport /></Menu.Popup>\n</Menu.Positioner>;',
      { sourcePath: "apps/web/src/components/example.tsx" },
    ),
  ).toEqual([1, 2]);
});

test("accepts shared classes through composition on every branch", async () => {
  expect(
    await lintSingleRule(
      "require-in-flow-viewport-popup",
      'const view = <Menu.Positioner className={cn(CONTENT_SIZED_POSITIONER_CLASS_NAME, extra)}>\n <Menu.Popup className={ok ? cn(IN_FLOW_POPUP_CLASS_NAME, "a") : IN_FLOW_POPUP_CLASS_NAME}><Menu.Viewport /></Menu.Popup>\n</Menu.Positioner>;',
      { sourcePath: "apps/web/src/components/example.tsx" },
    ),
  ).toEqual([]);
});

test("finds viewports rendered through expression containers", async () => {
  expect(
    await lintSingleRule(
      "require-in-flow-viewport-popup",
      "const view = <Menu.Positioner><Menu.Popup>{open && <Menu.Viewport />}</Menu.Popup></Menu.Positioner>;",
      { sourcePath: "apps/web/src/components/example.tsx" },
    ),
  ).toEqual([1, 1]);
});

test("accepts viewport free and prop supplied content", async () => {
  expect(
    await lintSingleRule(
      "require-in-flow-viewport-popup",
      "const a = <Menu.Positioner><Menu.Popup /></Menu.Positioner>;\nconst b = <Menu.Positioner><Menu.Popup content={<Menu.Viewport />} /></Menu.Positioner>;",
      { sourcePath: "apps/web/src/components/example.tsx" },
    ),
  ).toEqual([]);
});

test("accepts shared sizing through template and concatenated classes", async () => {
  expect(
    await lintSingleRule(
      "require-in-flow-viewport-popup",
      `const view = <Menu.Positioner className={\`flex \${CONTENT_SIZED_POSITIONER_CLASS_NAME}\`}>\n <Menu.Popup className={IN_FLOW_POPUP_CLASS_NAME + " extra"}><Menu.Viewport /></Menu.Popup>\n</Menu.Positioner>;`,
      { sourcePath: "apps/web/src/components/example.tsx" },
    ),
  ).toEqual([]);
});
