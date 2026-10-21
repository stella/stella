import { expect, test } from "bun:test";

import { readerCopyMenuBox } from "@/components/legal-reader/annotations/reader-copy-menu.logic";

test.each([
  {
    bar: { bottom: 80, left: 20, top: 40, width: 300 },
    expected: { left: 20, opensUp: false, top: 84, width: 300 },
    name: "matches a visible toolbar",
  },
  {
    bar: { bottom: 80, left: -20, top: 40, width: 500 },
    expected: { left: 0, opensUp: false, top: 84, width: 320 },
    name: "clips a toolbar wider than the viewport",
  },
  {
    bar: { bottom: 590, left: 20, top: 550, width: 200 },
    expected: { bottom: 54, left: 20, opensUp: true, width: 200 },
    name: "opens above near the bottom edge",
  },
])("$name", ({ bar, expected }) => {
  expect(
    readerCopyMenuBox({
      bar,
      menuHeight: 200,
      viewport: { height: 600, width: 320 },
    }),
  ).toEqual(expected);
});
