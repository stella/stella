import { expect, test } from "bun:test";

const source = await Bun.file(
  new URL("view-switcher.tsx", import.meta.url),
).text();
const manifest = await Bun.file(
  new URL("../package.json", import.meta.url),
).json();

test("selection remains controlled by the accessible tabs primitive", () => {
  expect(source).toContain("onValueChange=");
  expect(source).not.toMatch(/<TabsTab[\s\S]*?onClick=/u);
});

test("drag interactions use one published Pragmatic DnD v3 contract", () => {
  expect(source).toContain(
    'from "@atlaskit/pragmatic-drag-and-drop/element/adapter"',
  );
  expect(source).toContain('from "@atlaskit/pragmatic-drag-and-drop/combine"');
  expect(source).not.toContain("/adapter/element-adapter");
  expect(source).not.toContain("/utils/combine");
  expect(manifest.peerDependencies).toMatchObject({
    "@atlaskit/pragmatic-drag-and-drop": "^3.0.0",
    "@atlaskit/pragmatic-drag-and-drop-hitbox": "^2.0.1",
  });
});
