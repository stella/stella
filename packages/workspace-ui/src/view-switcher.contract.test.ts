import { expect, test } from "bun:test";

const source = await Bun.file(
  new URL("view-switcher.tsx", import.meta.url),
).text();
const manifest = await Bun.file(
  new URL("../package.json", import.meta.url),
).json();
const atlaskitPeerDependencies = Object.fromEntries(
  Object.entries(manifest.peerDependencies).filter(([name]) =>
    name.startsWith("@atlaskit/"),
  ),
);
const atlaskitDevDependencies = Object.fromEntries(
  Object.entries(manifest.devDependencies).filter(([name]) =>
    name.startsWith("@atlaskit/"),
  ),
);

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
  expect(atlaskitPeerDependencies).toEqual(atlaskitDevDependencies);
});

test("drag targets accept only their own switcher instance", () => {
  expect(source).toContain("[VIEW_DRAG_INSTANCE]: instanceId");
  expect(
    source.match(/source\.data\[VIEW_DRAG_INSTANCE\] === instanceId/gu),
  ).toHaveLength(2);
});
