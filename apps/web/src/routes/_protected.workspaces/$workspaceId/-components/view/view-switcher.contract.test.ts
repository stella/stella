import { expect, test } from "bun:test";

const source = await Bun.file(
  new URL("view-switcher.tsx", import.meta.url),
).text();

test("the workspace route consumes the published view switcher", () => {
  expect(source).toContain('from "@stll/workspace-ui/view-switcher"');
  expect(source).not.toMatch(/\bdraggable\(|\bdropTargetForElements\(/u);
  expect(source).not.toContain("attachClosestEdge");
  expect(source).not.toContain("reorderViewIds");
});
