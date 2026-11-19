import { expect, test } from "bun:test";

const source = await Bun.file(
  new URL("view-switcher.tsx", import.meta.url),
).text();
// The strip and its tabs live in the face module, which the switcher renders.
const faceSource = await Bun.file(
  new URL("view-switcher-face.tsx", import.meta.url),
).text();
const manifest: {
  peerDependencies: Record<string, string>;
  devDependencies: Record<string, string>;
} = await Bun.file(new URL("../package.json", import.meta.url)).json();
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
  expect(faceSource).toContain("onValueChange=");
  expect(source).toContain("<WorkspaceViewStrip");
  expect(source).toContain("onViewChange={onViewChange}");
  for (const tabs of [source, faceSource]) {
    expect(tabs).not.toMatch(
      /<(TabsTab|WorkspaceViewTabFace)[\s\S]*?onClick=/u,
    );
  }
});

test("drag interactions use one published Pragmatic DnD v4 contract", () => {
  expect(source).toContain(
    'from "@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter"',
  );
  expect(source).toContain(
    'from "@atlaskit/pragmatic-drag-and-drop/utils/combine"',
  );
  expect(source).not.toContain("/element/adapter");
  expect(source).not.toContain("pragmatic-drag-and-drop/combine");
  expect(atlaskitPeerDependencies).toEqual(atlaskitDevDependencies);
});

test("drag targets accept only their own switcher instance", () => {
  expect(source).toContain("[VIEW_DRAG_INSTANCE]: instanceId");
  expect(
    source.match(/source\.data\[VIEW_DRAG_INSTANCE\] === instanceId/gu),
  ).toHaveLength(2);
});
