import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { BAR_GLYPHS } from "../../bar-glyphs.gen";

const REPO_ROOT = path.resolve(import.meta.dir, "../../../../..");
const read = (file: string) =>
  readFileSync(path.join(REPO_ROOT, file), "utf-8");

/** `icon: XIcon, id: "x"` pairs of the web's primary navigation. */
const webNavIcons = (): Map<string, string> =>
  new Map(
    [
      ...read("apps/web/src/components/workspace-primary-nav.ts").matchAll(
        /icon: (\w+),\s*id: "(\w+)"/gu,
      ),
    ].map(([, icon, id]) => [id ?? "", icon ?? ""]),
  );

/** lucide's glyph name for a component (`MessageSquareIcon` is `message-square`). */
const glyphOf = (component: string) =>
  component
    .replace(/Icon$/u, "")
    .replaceAll(/(?<=[a-z\d])(?=[A-Z])/gu, "-")
    .toLowerCase();

/**
 * The glyph each tab draws, by route: the lucide name it reads the asset
 * catalog's image by (`BAR_GLYPHS.layers`, `BAR_GLYPHS["list-todo"]`).
 */
const tabGlyphs = (): Map<string, string> => {
  const layout = read("apps/mobile/src/app/(tabs)/_layout.tsx");
  return new Map(
    [
      ...layout.matchAll(
        /Trigger name="(\w+)"[^>]*>[\s\S]*?xcasset=\{BAR_GLYPHS(?:\.(\w+)|\["([\w-]+)"\])\}/gu,
      ),
    ].map(([, route, dotted, quoted]) => [route ?? "", dotted ?? quoted ?? ""]),
  );
};

test("every tab draws a lucide glyph the asset catalog carries", () => {
  const glyphs = tabGlyphs();
  expect([...glyphs.keys()].toSorted()).toEqual(
    ["index", "matters", "more", "tasks"].toSorted(),
  );
  for (const glyph of glyphs.values()) {
    expect(Object.keys(BAR_GLYPHS)).toContain(glyph);
  }
});

test("the chat tab draws the web navigation's chat glyph", () => {
  expect(tabGlyphs().get("index")).toBe(
    glyphOf(webNavIcons().get("chat") ?? ""),
  );
});

test("More's case-law row draws the web navigation's case-law glyph", () => {
  expect(webNavIcons().get("caseLaw")).toBe("CaseLawIcon");
  expect(read("packages/ui/src/icons.ts")).toContain(
    "export { BookOpenIcon as CaseLawIcon }",
  );
  expect(read("apps/mobile/src/app/(tabs)/more.tsx")).toMatch(
    new RegExp(`glyph: "${glyphOf("BookOpenIcon")}",\\s*href: "/law"`, "u"),
  );
});

test("the matters tab draws the web's matter glyph, lucide's layers", () => {
  expect(webNavIcons().get("matters")).toBe("MattersNavIcon");
  expect(read("packages/ui/src/components/matter-icon.tsx")).toContain(
    'import { LayersIcon } from "../icons";',
  );
  expect(tabGlyphs().get("matters")).toBe("layers");
});

test("More's settings row draws the web user menu's settings glyph", () => {
  expect(read("apps/web/src/components/sidebar-user-menu.tsx")).toContain(
    "<CogIcon />",
  );
  expect(read("apps/mobile/src/app/(tabs)/more.tsx")).toMatch(
    new RegExp(`glyph: "${glyphOf("CogIcon")}",\\s*href: "/settings"`, "u"),
  );
});
